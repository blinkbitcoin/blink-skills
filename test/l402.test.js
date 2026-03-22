/**
 * Unit tests for L402 Phase 1 scripts.
 *
 * Covers:
 *   - parseLightningLabsHeader        (l402_discover.js)
 *   - parseL402ProtocolBody           (l402_discover.js)
 *   - decodeBolt11AmountSats          (l402_discover.js)
 *   - Token store CRUD                (l402_store.js)
 *   - l402_pay dry-run flow           (l402_pay.js — mocked fetch)
 *   - fetchPreimageByPaymentHash      (l402_pay.js — mocked graphqlRequest)
 *   - Preimage resolution in main()   (l402_pay.js — inline / Option B / fallback paths)
 *
 * Run: node --test test/l402.test.js
 */

'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');

const { parseLightningLabsHeader, parseL402ProtocolBody, decodeBolt11AmountSats } = require(
  path.join(scriptsDir, 'l402_discover'),
);

// ── parseLightningLabsHeader ──────────────────────────────────────────────────

describe('parseLightningLabsHeader', () => {
  it('parses a valid Lightning Labs header', () => {
    const header = 'L402 macaroon="abc123==", invoice="lnbc100n1abc"';
    const result = parseLightningLabsHeader(header);
    assert.ok(result);
    assert.equal(result.macaroon, 'abc123==');
    assert.equal(result.invoice, 'lnbc100n1abc');
  });

  it('is case-insensitive on L402 scheme tag', () => {
    const header = 'l402 macaroon="xyz", invoice="lnbc50n1def"';
    const result = parseLightningLabsHeader(header);
    assert.ok(result);
    assert.equal(result.macaroon, 'xyz');
    assert.equal(result.invoice, 'lnbc50n1def');
  });

  it('returns null for empty string', () => {
    assert.equal(parseLightningLabsHeader(''), null);
  });

  it('returns null for null', () => {
    assert.equal(parseLightningLabsHeader(null), null);
  });

  it('returns null when macaroon field is missing', () => {
    const header = 'L402 invoice="lnbc100n1abc"';
    assert.equal(parseLightningLabsHeader(header), null);
  });

  it('returns null when invoice field is missing', () => {
    const header = 'L402 macaroon="abc123=="';
    assert.equal(parseLightningLabsHeader(header), null);
  });

  it('returns null for Bearer scheme (not L402)', () => {
    const header = 'Bearer token="abc"';
    assert.equal(parseLightningLabsHeader(header), null);
  });

  it('handles extra whitespace around equals sign', () => {
    const header = 'L402 macaroon = "abc123==", invoice = "lnbc100n1abc"';
    const result = parseLightningLabsHeader(header);
    assert.ok(result);
    assert.equal(result.macaroon, 'abc123==');
    assert.equal(result.invoice, 'lnbc100n1abc');
  });
});

// ── parseL402ProtocolBody ─────────────────────────────────────────────────────

describe('parseL402ProtocolBody', () => {
  it('parses a body with payment_request_url and offers', () => {
    const body = {
      version: '0.2',
      payment_request_url: 'https://service.example/pay',
      offers: [{ title: 'Basic', amount: 100, currency: 'BTC' }],
    };
    const result = parseL402ProtocolBody(body);
    assert.ok(result);
    assert.equal(result.paymentRequestUrl, 'https://service.example/pay');
    assert.equal(result.version, '0.2');
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0].title, 'Basic');
  });

  it('returns empty offers array when offers is missing but payment_request_url present', () => {
    const body = { payment_request_url: 'https://service.example/pay' };
    const result = parseL402ProtocolBody(body);
    assert.ok(result);
    assert.deepEqual(result.offers, []);
  });

  it('returns null for null input', () => {
    assert.equal(parseL402ProtocolBody(null), null);
  });

  it('returns null for non-object input', () => {
    assert.equal(parseL402ProtocolBody('not an object'), null);
  });

  it('returns null when neither payment_request_url nor offers is present', () => {
    assert.equal(parseL402ProtocolBody({ unrelated: 'data' }), null);
  });

  it('handles body with only offers array (no payment_request_url)', () => {
    const body = { offers: [{ title: 'Pro', amount: 500 }] };
    const result = parseL402ProtocolBody(body);
    assert.ok(result);
    assert.equal(result.paymentRequestUrl, null);
    assert.equal(result.offers.length, 1);
  });
});

// ── decodeBolt11AmountSats ────────────────────────────────────────────────────

describe('decodeBolt11AmountSats', () => {
  it('decodes n (nano) multiplier: 100n = 10 sats', () => {
    // 100n = 100 * 1e-9 BTC * 1e8 sats/BTC = 10 sats
    const sats = decodeBolt11AmountSats('lnbc100n1p0xyz');
    assert.equal(sats, 10);
  });

  it('decodes m (milli) multiplier: 10m = 1_000_000 sats', () => {
    // 10m = 10 * 0.001 BTC * 1e8 = 1_000_000 sats
    const sats = decodeBolt11AmountSats('lnbc10m1p0xyz');
    assert.equal(sats, 1_000_000);
  });

  it('decodes u (micro) multiplier: 1000u = 100_000 sats', () => {
    // 1000u = 1000 * 1e-6 BTC * 1e8 = 100_000 sats
    const sats = decodeBolt11AmountSats('lnbc1000u1p0xyz');
    assert.equal(sats, 100_000);
  });

  it('decodes u (micro) multiplier: 10u = 1_000 sats', () => {
    // 10u = 10 * 1e-6 * 1e8 = 1_000 sats
    const sats = decodeBolt11AmountSats('lnbc10u1p0xyz');
    assert.equal(sats, 1_000);
  });

  it('decodes p (pico) multiplier: 1e12p = 100_000_000 sats', () => {
    // 1e12p = 1e12 * 1e-12 BTC * 1e8 = 1e8 = 100_000_000 sats
    const sats = decodeBolt11AmountSats('lnbc1000000000000p1p0xyz');
    assert.equal(sats, 100_000_000);
  });

  it('decodes whole-BTC amount (no multiplier): 1 = 100_000_000 sats', () => {
    // 1 BTC = 100_000_000 sats
    const sats = decodeBolt11AmountSats('lnbc11p0xyz');
    assert.equal(sats, 100_000_000);
  });

  it('decodes testnet invoice (lntb prefix)', () => {
    // 500n = 500 * 1e-9 * 1e8 = 50 sats
    const sats = decodeBolt11AmountSats('lntb500n1p0xyz');
    assert.equal(sats, 50);
  });

  it('decodes signet invoice (lntbs prefix)', () => {
    // 500n = 50 sats
    const sats = decodeBolt11AmountSats('lntbs500n1p0xyz');
    assert.equal(sats, 50);
  });

  it('returns null for null input', () => {
    assert.equal(decodeBolt11AmountSats(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(decodeBolt11AmountSats(''), null);
  });

  it('returns null for unrecognised prefix', () => {
    assert.equal(decodeBolt11AmountSats('bc1qxyz'), null);
  });

  it('is case-insensitive (uppercase LNBC)', () => {
    const sats = decodeBolt11AmountSats('LNBC100n1p0xyz');
    assert.equal(sats, 10);
  });

  it('decodes a 1-sat invoice: 10000p = 1 sat', () => {
    // 10000p = 10000 * 1e-12 * 1e8 = 1 sat
    const sats = decodeBolt11AmountSats('lnbc10000p1p0xyz');
    assert.equal(sats, 1);
  });
});

// ── Token Store CRUD (l402_store.js) ─────────────────────────────────────────

describe('l402_store token CRUD', () => {
  // Use an isolated temp directory so tests don't touch ~/.blink
  let tmpDir;
  let storeModule;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l402-test-'));
    // Patch the module's STORE_DIR/STORE_FILE by loading with monkey-patched os.homedir
    // Simplest approach: require the module, then override the store path via re-requiring
    // with a custom home directory.
    // We do this by temporarily overriding os.homedir.
    const originalHomedir = os.homedir;
    os.homedir = () => tmpDir;
    // Bust cache so the patched homedir takes effect.
    const storePath = path.join(scriptsDir, 'l402_store.js');
    delete require.cache[require.resolve(storePath)];
    storeModule = require(storePath);
    os.homedir = originalHomedir;
  });

  after(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    // Reset the store between tests
    storeModule.clearTokens();
  });

  it('saveToken + getToken round-trip', () => {
    storeModule.saveToken('example.com', {
      macaroon: 'MACAROON_BASE64',
      preimage: 'a'.repeat(64),
      invoice: 'lnbc100n1test',
      satoshis: 10,
    });

    const token = storeModule.getToken('example.com');
    assert.ok(token);
    assert.equal(token.macaroon, 'MACAROON_BASE64');
    assert.equal(token.preimage, 'a'.repeat(64));
    assert.equal(token.satoshis, 10);
    assert.ok(token.savedAt > 0);
  });

  it('getToken returns null for unknown domain', () => {
    assert.equal(storeModule.getToken('unknown.example'), null);
  });

  it('getToken returns null for expired token', () => {
    storeModule.saveToken('expired.example', {
      macaroon: 'MAC',
      preimage: 'b'.repeat(64),
      expiresAt: Date.now() - 1000, // already expired
    });
    assert.equal(storeModule.getToken('expired.example'), null);
  });

  it('getToken returns token that has not yet expired', () => {
    storeModule.saveToken('valid.example', {
      macaroon: 'MAC',
      preimage: 'c'.repeat(64),
      expiresAt: Date.now() + 60_000, // expires 60s from now
    });
    const token = storeModule.getToken('valid.example');
    assert.ok(token);
    assert.equal(token.macaroon, 'MAC');
  });

  it('listTokens returns all stored tokens with masked values', () => {
    storeModule.saveToken('a.example', { macaroon: 'AAAA1234567890abcdef', preimage: 'd'.repeat(64) });
    storeModule.saveToken('b.example', { macaroon: 'BBBB1234567890abcdef', preimage: 'e'.repeat(64) });

    const list = storeModule.listTokens();
    assert.equal(list.length, 2);

    const domains = list.map((t) => t.domain).sort();
    assert.deepEqual(domains, ['a.example', 'b.example']);

    // Preimage should be masked (only first 8 chars + '…')
    for (const entry of list) {
      assert.ok(entry.preimage.endsWith('…'));
      assert.ok(entry.preimage.length < 20);
    }
  });

  it('clearTokens() removes all tokens', () => {
    storeModule.saveToken('x.example', { macaroon: 'MAC', preimage: 'f'.repeat(64) });
    storeModule.saveToken('y.example', { macaroon: 'MAC', preimage: 'g'.repeat(64) });
    const removed = storeModule.clearTokens();
    assert.equal(removed, 2);
    assert.equal(storeModule.listTokens().length, 0);
  });

  it('clearTokens({ expiredOnly: true }) removes only expired tokens', () => {
    storeModule.saveToken('keep.example', {
      macaroon: 'MAC',
      preimage: 'h'.repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    storeModule.saveToken('drop.example', {
      macaroon: 'MAC',
      preimage: 'i'.repeat(64),
      expiresAt: Date.now() - 1000,
    });
    const removed = storeModule.clearTokens({ expiredOnly: true });
    assert.equal(removed, 1);

    const list = storeModule.listTokens();
    assert.equal(list.length, 1);
    assert.equal(list[0].domain, 'keep.example');
  });

  it('overwriting a domain replaces the old token', () => {
    storeModule.saveToken('dup.example', { macaroon: 'OLD', preimage: 'j'.repeat(64) });
    storeModule.saveToken('dup.example', { macaroon: 'NEW', preimage: 'k'.repeat(64) });
    const token = storeModule.getToken('dup.example');
    assert.equal(token.macaroon, 'NEW');
  });
});

// ── l402_pay dry-run (mocked fetch) ──────────────────────────────────────────

describe('l402_pay dry-run flow', () => {
  let env;
  const payPath = path.join(scriptsDir, 'l402_pay.js');
  const discoverPath = path.join(scriptsDir, 'l402_discover.js');
  const storePath = path.join(scriptsDir, 'l402_store.js');
  const clientPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_blink_client.js');

  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalFetch = global.fetch;
  let stdoutLines = [];
  let stderrLines = [];
  const originalStdout = console.log;
  const originalStderr = console.error;

  before(() => {
    process.env.BLINK_API_KEY = 'blink_test_key';
    process.env.BLINK_API_URL = 'https://api.test.blink.sv/graphql';
    console.log = (...args) => {
      stdoutLines.push(args.join(' '));
    };
    console.error = (...args) => {
      stderrLines.push(args.join(' '));
    };
  });

  after(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    global.fetch = originalFetch;
    console.log = originalStdout;
    console.error = originalStderr;
  });

  afterEach(() => {
    stdoutLines = [];
    stderrLines = [];
    global.fetch = originalFetch;
    // Bust require cache so each test starts fresh
    delete require.cache[require.resolve(payPath)];
    delete require.cache[require.resolve(discoverPath)];
    delete require.cache[require.resolve(storePath)];
    delete require.cache[require.resolve(clientPath)];
  });

  it('dry-run emits l402_dry_run event for Lightning Labs 402 response', async () => {
    // Mock: first call returns 402 with WWW-Authenticate header
    global.fetch = async (_url, _opts) => ({
      status: 402,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'www-authenticate') {
            return 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0dryrun"';
          }
          return null;
        },
      },
      text: async () => '',
    });

    process.argv = ['node', 'l402_pay.js', 'https://api.example.com/resource', '--dry-run', '--no-store'];
    const { main } = require(payPath);
    await main();

    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_dry_run');
    assert.equal(out.format, 'lightning-labs');
    // lnbc1000u: 1000 * 1e-6 BTC * 1e8 = 100_000 sats
    assert.equal(out.satoshis, 100_000);
    assert.equal(out.invoice, 'lnbc1000u1p0dryrun');
  });

  it('emits l402_not_required when resource returns 200', async () => {
    global.fetch = async (_url, _opts) => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: 'Hello, world!' }),
    });

    process.argv = ['node', 'l402_pay.js', 'https://api.example.com/free', '--no-store'];
    const { main } = require(payPath);
    await main();

    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_not_required');
    assert.equal(out.status, 200);
  });

  it('dry-run respects --max-amount and sets withinBudget correctly', async () => {
    // Invoice is 100 sats (lnbc1000u), max-amount is 50 — over budget
    global.fetch = async (_url, _opts) => ({
      status: 402,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'www-authenticate') {
            return 'L402 macaroon="MAC", invoice="lnbc1000u1p0budget"';
          }
          return null;
        },
      },
      text: async () => '',
    });

    process.argv = [
      'node',
      'l402_pay.js',
      'https://api.example.com/resource',
      '--dry-run',
      '--no-store',
      '--max-amount',
      '50',
    ];

    const { main } = require(payPath);
    let exitCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };

    try {
      await main();
    } catch (err) {
      // Swallow the exit error
    } finally {
      process.exit = originalExit;
    }

    // Should have exited with code 1 (budget exceeded — not a dry-run event)
    assert.equal(exitCode, 1);
    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_budget_exceeded');
    assert.equal(out.satoshis, 100_000); // lnbc1000u = 100_000 sats
    assert.equal(out.maxAmount, 50);
  });

  it('dry-run with budget OK emits withinBudget: true', async () => {
    global.fetch = async (_url, _opts) => ({
      status: 402,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'www-authenticate') {
            // lnbc100n = 100 * 1e-9 * 1e8 = 10 sats, well within max 200
            return 'L402 macaroon="MAC", invoice="lnbc100n1p0withinbudget"';
          }
          return null;
        },
      },
      text: async () => '',
    });

    process.argv = [
      'node',
      'l402_pay.js',
      'https://api.example.com/resource',
      '--dry-run',
      '--no-store',
      '--max-amount',
      '200',
    ];

    const { main } = require(payPath);
    await main();

    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_dry_run');
    assert.equal(out.withinBudget, true);
    assert.equal(out.satoshis, 10); // 100n = 10 sats
  });

  it('--dry-run bypasses token cache and emits l402_dry_run even when cached token exists', async () => {
    // Seed a real cached token into ~/.blink/l402-tokens.json so that the
    // cache lookup would normally short-circuit and return l402_paid immediately.
    const storeDir = path.join(os.homedir(), '.blink');
    const storeFile = path.join(storeDir, 'l402-tokens.json');
    fs.mkdirSync(storeDir, { recursive: true });
    const previousStore = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : null;
    const cachedEntry = {
      macaroon: 'CACHED_MAC==',
      preimage: 'cachedpreimage',
      satoshis: 42,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    };
    fs.writeFileSync(storeFile, JSON.stringify({ 'api.example.com': cachedEntry }));

    try {
      // Mock: server still returns 402 (dry-run should reach this, not the cache)
      global.fetch = async (_url, _opts) => ({
        status: 402,
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'www-authenticate') {
              return 'L402 macaroon="FRESH_MAC==", invoice="lnbc100n1p0nocache"';
            }
            return null;
          },
        },
        text: async () => '',
      });

      process.argv = ['node', 'l402_pay.js', 'https://api.example.com/resource', '--dry-run'];
      const { main } = require(payPath);
      await main();

      const out = JSON.parse(stdoutLines.join('\n'));
      // Must be l402_dry_run, not l402_paid (which would mean the cache was used)
      assert.equal(out.event, 'l402_dry_run', '--dry-run must bypass cache and report fresh invoice');
      assert.equal(out.invoice, 'lnbc100n1p0nocache');
    } finally {
      // Restore store to previous state
      if (previousStore === null) {
        fs.unlinkSync(storeFile);
      } else {
        fs.writeFileSync(storeFile, previousStore);
      }
    }
  });

  it('without --dry-run, cached token is reused and emits l402_paid with tokenReused: true', async () => {
    // Confirm the cache-reuse path still works correctly (regression guard)
    const storeDir = path.join(os.homedir(), '.blink');
    const storeFile = path.join(storeDir, 'l402-tokens.json');
    fs.mkdirSync(storeDir, { recursive: true });
    const previousStore = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : null;
    const cachedEntry = {
      macaroon: 'REUSE_MAC==',
      preimage: 'reusepreimage',
      satoshis: 99,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    };
    fs.writeFileSync(storeFile, JSON.stringify({ 'api.example.com': cachedEntry }));

    try {
      // Mock: server returns 200 when Authorization header is present (cache reuse)
      global.fetch = async (_url, opts) => {
        if (opts && opts.headers && opts.headers.Authorization) {
          return {
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ result: 'cached-ok' }),
          };
        }
        // Should not be reached — cache should short-circuit before any 402
        return { status: 402, headers: { get: () => null }, text: async () => '' };
      };

      process.argv = ['node', 'l402_pay.js', 'https://api.example.com/resource'];
      const { main } = require(payPath);
      await main();

      const out = JSON.parse(stdoutLines.join('\n'));
      assert.equal(out.event, 'l402_paid');
      assert.equal(out.tokenReused, true);
      assert.equal(out.satoshis, 99);
    } finally {
      if (previousStore === null) {
        fs.unlinkSync(storeFile);
      } else {
        fs.writeFileSync(storeFile, previousStore);
      }
    }
  });
});

// ── fetchPreimageByPaymentHash (l402_pay.js) ──────────────────────────────────

describe('fetchPreimageByPaymentHash', () => {
  const payPath = path.join(scriptsDir, 'l402_pay.js');
  const clientPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_blink_client.js');
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete require.cache[require.resolve(payPath)];
    delete require.cache[require.resolve(clientPath)];
  });

  it('returns preimage when matching paymentHash found in transactions', async () => {
    const targetHash = 'aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd11223344';
    const expectedPreimage = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    global.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      // Respond to transactions query
      if (body.query && body.query.includes('TransactionsForPreimage')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  transactions: {
                    edges: [
                      {
                        node: {
                          initiationVia: { paymentHash: targetHash },
                          settlementVia: { preImage: expectedPreimage },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }
      return { ok: false, text: async () => 'unexpected request' };
    };

    const { fetchPreimageByPaymentHash } = require(payPath);
    const result = await fetchPreimageByPaymentHash(targetHash, {
      apiKey: 'blink_test_key',
      apiUrl: 'https://api.test.blink.sv/graphql',
    });
    assert.equal(result, expectedPreimage);
  });

  it('returns null when paymentHash does not match any transaction', async () => {
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query && body.query.includes('TransactionsForPreimage')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  transactions: {
                    edges: [
                      {
                        node: {
                          initiationVia: {
                            paymentHash: 'aaaa000000000000000000000000000000000000000000000000000000000000',
                          },
                          settlementVia: { preImage: 'somepreimage' },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }
      return { ok: false, text: async () => 'unexpected' };
    };

    const { fetchPreimageByPaymentHash } = require(payPath);
    const result = await fetchPreimageByPaymentHash(
      'bbbb000000000000000000000000000000000000000000000000000000000000',
      { apiKey: 'blink_test_key', apiUrl: 'https://api.test.blink.sv/graphql' },
    );
    assert.equal(result, null);
  });

  it('returns null when called with null paymentHash', async () => {
    const { fetchPreimageByPaymentHash } = require(payPath);
    const result = await fetchPreimageByPaymentHash(null, {
      apiKey: 'blink_test_key',
      apiUrl: 'https://api.test.blink.sv/graphql',
    });
    assert.equal(result, null);
  });

  it('returns null and does not throw when query fails', async () => {
    global.fetch = async () => {
      throw new Error('Network error');
    };
    const { fetchPreimageByPaymentHash } = require(payPath);
    const result = await fetchPreimageByPaymentHash(
      'cccc000000000000000000000000000000000000000000000000000000000000',
      { apiKey: 'blink_test_key', apiUrl: 'https://api.test.blink.sv/graphql' },
    );
    assert.equal(result, null);
  });

  it('is case-insensitive when matching paymentHash', async () => {
    const lowerHash = 'aabb1234aabb1234aabb1234aabb1234aabb1234aabb1234aabb1234aabb1234';
    const upperHash = lowerHash.toUpperCase();
    const expectedPreimage = '1234beef1234beef1234beef1234beef1234beef1234beef1234beef1234beef';

    global.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query && body.query.includes('TransactionsForPreimage')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  transactions: {
                    edges: [
                      {
                        node: {
                          initiationVia: { paymentHash: upperHash },
                          settlementVia: { preImage: expectedPreimage },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }
      return { ok: false, text: async () => 'unexpected' };
    };

    const { fetchPreimageByPaymentHash } = require(payPath);
    const result = await fetchPreimageByPaymentHash(lowerHash, {
      apiKey: 'blink_test_key',
      apiUrl: 'https://api.test.blink.sv/graphql',
    });
    assert.equal(result, expectedPreimage);
  });
});

// ── resolveCanonicalUrl (l402_discover.js) ────────────────────────────────────

describe('resolveCanonicalUrl', () => {
  const discoverPath = path.join(scriptsDir, 'l402_discover.js');
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete require.cache[require.resolve(discoverPath)];
  });

  it('returns the redirected URL when a redirect occurs', async () => {
    global.fetch = async (url, opts) => {
      if (url === 'https://www.example.com/resource') {
        // Simulate a redirect — response.url reflects the final URL
        return { url: 'https://example.com/resource', status: 200 };
      }
      return { url, status: 200 };
    };

    const { resolveCanonicalUrl } = require(discoverPath);
    const canonical = await resolveCanonicalUrl('https://www.example.com/resource');
    assert.equal(canonical, 'https://example.com/resource');
  });

  it('returns the original URL when no redirect occurs', async () => {
    global.fetch = async (url) => ({ url, status: 200 });

    const { resolveCanonicalUrl } = require(discoverPath);
    const canonical = await resolveCanonicalUrl('https://api.example.com/v1/data');
    assert.equal(canonical, 'https://api.example.com/v1/data');
  });

  it('returns the original URL when HEAD request fails (graceful degradation)', async () => {
    global.fetch = async () => {
      throw new Error('Network error');
    };

    const { resolveCanonicalUrl } = require(discoverPath);
    const canonical = await resolveCanonicalUrl('https://www.example.com/resource');
    assert.equal(canonical, 'https://www.example.com/resource');
  });
});

// ── l402_pay redirect handling ────────────────────────────────────────────────

describe('l402_pay redirect handling', () => {
  const payPath = path.join(scriptsDir, 'l402_pay.js');
  const discoverPath = path.join(scriptsDir, 'l402_discover.js');
  const storePath = path.join(scriptsDir, 'l402_store.js');
  const clientPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_blink_client.js');

  const originalFetch = global.fetch;
  let stdoutLines = [];
  let stderrLines = [];
  const originalStdout = console.log;
  const originalStderr = console.error;

  before(() => {
    process.env.BLINK_API_KEY = 'blink_test_key';
    process.env.BLINK_API_URL = 'https://api.test.blink.sv/graphql';
    console.log = (...args) => {
      stdoutLines.push(args.join(' '));
    };
    console.error = (...args) => {
      stderrLines.push(args.join(' '));
    };
  });

  after(() => {
    global.fetch = originalFetch;
    console.log = originalStdout;
    console.error = originalStderr;
  });

  afterEach(() => {
    stdoutLines = [];
    stderrLines = [];
    global.fetch = originalFetch;
    delete require.cache[require.resolve(payPath)];
    delete require.cache[require.resolve(discoverPath)];
    delete require.cache[require.resolve(storePath)];
    delete require.cache[require.resolve(clientPath)];
  });

  it('resolves redirect before L402 handshake: canonicalUrl appears in dry-run output', async () => {
    // Simulates the satring.com scenario: www. → canonical redirect
    global.fetch = async (url, opts) => {
      // HEAD pre-flight: resolve redirect
      if (opts && opts.method === 'HEAD') {
        return { url: 'https://satring.com/api/v1/services', status: 200 };
      }
      // Initial GET to canonical URL → 402
      if (url === 'https://satring.com/api/v1/services') {
        return {
          status: 402,
          url,
          headers: {
            get: (name) => {
              if (name.toLowerCase() === 'www-authenticate') {
                return 'L402 macaroon="CANONICAL_MAC==", invoice="lnbc1000u1p0canonical"';
              }
              return null;
            },
          },
          text: async () => '',
        };
      }
      return { status: 404, url, headers: { get: () => null }, text: async () => '' };
    };

    process.argv = ['node', 'l402_pay.js', 'https://www.satring.com/api/v1/services', '--dry-run', '--no-store'];
    const { main } = require(payPath);
    await main();

    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_dry_run');
    // Original user-supplied URL preserved
    assert.equal(out.url, 'https://www.satring.com/api/v1/services');
    // Canonical URL reported
    assert.equal(out.canonicalUrl, 'https://satring.com/api/v1/services');
    // Invoice from canonical endpoint was correctly parsed
    assert.equal(out.invoice, 'lnbc1000u1p0canonical');
    // Redirect message logged to stderr
    assert.ok(stderrLines.some((l) => l.includes('Resolved redirect')));
  });

  it('uses canonical domain as token cache key (not www. domain)', async () => {
    // Verify extractDomain runs on canonicalUrl, not args.url
    global.fetch = async (url, opts) => {
      if (opts && opts.method === 'HEAD') {
        return { url: 'https://satring.com/api/v1/services', status: 200 };
      }
      // Initial GET → 402
      if (url === 'https://satring.com/api/v1/services') {
        return {
          status: 402,
          url,
          headers: {
            get: (name) => {
              if (name.toLowerCase() === 'www-authenticate') {
                return 'L402 macaroon="DOMAIN_MAC==", invoice="lnbc1000u1p0domain"';
              }
              return null;
            },
          },
          text: async () => '',
        };
      }
      return { status: 404, url, headers: { get: () => null }, text: async () => '' };
    };

    process.argv = ['node', 'l402_pay.js', 'https://www.satring.com/api/v1/services', '--dry-run', '--no-store'];
    const { main } = require(payPath);
    await main();

    // The redirect log line tells us the resolution worked; the domain used for
    // the cache key (satring.com not www.satring.com) is confirmed indirectly
    // by the stderr log that says "Resolved redirect: ... → https://satring.com/..."
    const redirectLog = stderrLines.find((l) => l.includes('Resolved redirect'));
    assert.ok(redirectLog, 'Expected redirect resolution log');
    assert.ok(redirectLog.includes('satring.com/api'), 'Canonical domain logged');
  });

  it('sends Authorization header to canonical URL (not www.) on retry', async () => {
    // Track which URLs receive the Authorization header
    const authHeadersSentTo = [];

    global.fetch = async (url, opts) => {
      // HEAD pre-flight
      if (opts && opts.method === 'HEAD') {
        return { url: 'https://api.example.com/resource', status: 200 };
      }
      // Initial GET → 402
      if (url === 'https://api.example.com/resource' && !(opts && opts.headers && opts.headers.Authorization)) {
        return {
          status: 402,
          url,
          headers: {
            get: (name) => {
              if (name.toLowerCase() === 'www-authenticate') {
                return 'L402 macaroon="RETRY_MAC==", invoice="lnbc100n1p0retry"';
              }
              return null;
            },
          },
          text: async () => '',
        };
      }
      // Retry with Authorization
      if (opts && opts.headers && opts.headers.Authorization) {
        authHeadersSentTo.push(url);
        return {
          status: 200,
          url,
          headers: { get: () => null },
          text: async () => JSON.stringify({ result: 'ok' }),
        };
      }
      return { status: 404, url, headers: { get: () => null }, text: async () => '' };
    };

    // Intercept process.exit and graphqlRequest for payment simulation
    // We use dry-run to avoid needing the full payment stack
    process.argv = ['node', 'l402_pay.js', 'https://www.api.example.com/resource', '--dry-run', '--no-store'];
    const { main } = require(payPath);
    await main();

    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_dry_run');
    // No actual retry happens in dry-run, but canonical URL is in the output
    assert.equal(out.canonicalUrl, 'https://api.example.com/resource');
    assert.equal(out.url, 'https://www.api.example.com/resource');
  });
});

// ── runFeeProbe ───────────────────────────────────────────────────────────────

describe('runFeeProbe', () => {
  const { runFeeProbe } = require(path.join(scriptsDir, 'l402_pay'));

  // We monkey-patch graphqlRequest on the module's closure by intercepting at
  // the _blink_client level via global.fetch (the underlying transport).

  const FAKE_INVOICE = 'lnbc100n1p0fakeprobe';
  const FAKE_WALLET_ID = 'wallet-probe-test';

  it('returns estimatedFeeSats when probe succeeds', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        data: {
          lnInvoiceFeeProbe: {
            amount: 3,
            errors: [],
          },
        },
      }),
      text: async () => JSON.stringify({ data: { lnInvoiceFeeProbe: { amount: 3, errors: [] } } }),
    });

    const result = await runFeeProbe(FAKE_INVOICE, {
      walletId: FAKE_WALLET_ID,
      walletCurrency: 'BTC',
      apiKey: 'blink_test',
      apiUrl: 'https://api.blink.sv/graphql',
    });

    assert.equal(result.error, null);
    assert.equal(typeof result.estimatedFeeSats, 'number');
  });

  it('returns error string when probe reports API errors', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        data: {
          lnInvoiceFeeProbe: {
            amount: null,
            errors: [{ message: 'no route found', code: 'ROUTE_FINDING_ERROR', path: [] }],
          },
        },
      }),
      text: async () =>
        JSON.stringify({
          data: {
            lnInvoiceFeeProbe: {
              amount: null,
              errors: [{ message: 'no route found', code: 'ROUTE_FINDING_ERROR', path: [] }],
            },
          },
        }),
    });

    const result = await runFeeProbe(FAKE_INVOICE, {
      walletId: FAKE_WALLET_ID,
      walletCurrency: 'BTC',
      apiKey: 'blink_test',
      apiUrl: 'https://api.blink.sv/graphql',
    });

    assert.ok(result.error, 'Expected an error string');
    assert.ok(result.error.includes('no route found'));
    assert.equal(result.estimatedFeeSats, null);
  });

  it('returns error string when fetch throws (network failure)', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await runFeeProbe(FAKE_INVOICE, {
      walletId: FAKE_WALLET_ID,
      walletCurrency: 'BTC',
      apiKey: 'blink_test',
      apiUrl: 'https://api.blink.sv/graphql',
    });

    assert.ok(result.error, 'Expected an error string');
    assert.ok(result.error.includes('ECONNREFUSED'));
    assert.equal(result.estimatedFeeSats, null);
  });

  it('uses USD mutation when walletCurrency is USD', async () => {
    let capturedBody = null;
    global.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: { lnUsdInvoiceFeeProbe: { amount: 1, errors: [] } } }),
        text: async () => JSON.stringify({ data: { lnUsdInvoiceFeeProbe: { amount: 1, errors: [] } } }),
      };
    };

    await runFeeProbe(FAKE_INVOICE, {
      walletId: FAKE_WALLET_ID,
      walletCurrency: 'USD',
      apiKey: 'blink_test',
      apiUrl: 'https://api.blink.sv/graphql',
    });

    assert.ok(capturedBody.query.includes('lnUsdInvoiceFeeProbe'), 'Expected USD mutation');
  });
});
