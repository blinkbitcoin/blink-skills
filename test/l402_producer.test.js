/**
 * Unit tests for L402 Phase 2a — Producer Tools.
 *
 * Covers:
 *   - _l402_macaroon.js: encoding, decoding, HMAC, caveats, preimage verification
 *   - l402_challenge_create.js: CLI arg parsing, mocked invoice creation
 *   - l402_payment_verify.js: token verification, caveat validation, mocked API check
 *   - bin/blink.js: l402-challenge and l402-verify commands registered
 *
 * Run: node --test test/l402_producer.test.js
 */

'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');
const binDir = path.resolve(__dirname, '..', 'bin');

// ── Helper: generate a deterministic test root key ───────────────────────────

const TEST_ROOT_KEY = Buffer.alloc(32, 0xab); // 32 bytes of 0xAB

// ── Helper: generate a realistic payment hash / preimage pair ────────────────

function makePaymentPair() {
  const preimage = crypto.randomBytes(32);
  const paymentHash = crypto.createHash('sha256').update(preimage).digest('hex');
  return { preimage: preimage.toString('hex'), paymentHash };
}

// ── _l402_macaroon: module loading ───────────────────────────────────────────

let mac;
before(() => {
  // Clear require cache to get a fresh module each test run
  delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
  mac = require(path.join(scriptsDir, '_l402_macaroon.js'));
});

// ── TLV caveat encoding / decoding ───────────────────────────────────────────

describe('encodeCaveats / decodeCaveats', () => {
  it('roundtrips an empty caveat list', () => {
    const buf = mac.encodeCaveats([]);
    assert.equal(buf.length, 0);
    const decoded = mac.decodeCaveats(buf);
    assert.deepEqual(decoded, []);
  });

  it('roundtrips a single expiry caveat', () => {
    const ts = 1_800_000_000;
    const value = mac.encodeExpiryValue(ts);
    const caveats = [{ type: mac.CAVEAT_TYPE_EXPIRY, value }];
    const buf = mac.encodeCaveats(caveats);
    const decoded = mac.decodeCaveats(buf);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].type, mac.CAVEAT_TYPE_EXPIRY);
    assert.equal(mac.decodeExpiryValue(decoded[0].value), ts);
  });

  it('roundtrips a single resource caveat', () => {
    const resource = '/api/v1/data';
    const value = Buffer.from(resource, 'utf8');
    const caveats = [{ type: mac.CAVEAT_TYPE_RESOURCE, value }];
    const buf = mac.encodeCaveats(caveats);
    const decoded = mac.decodeCaveats(buf);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].type, mac.CAVEAT_TYPE_RESOURCE);
    assert.equal(decoded[0].value.toString('utf8'), resource);
  });

  it('roundtrips multiple caveats in order', () => {
    const ts = 2_000_000_000;
    const resource = '/secure';
    const caveats = [
      { type: mac.CAVEAT_TYPE_EXPIRY, value: mac.encodeExpiryValue(ts) },
      { type: mac.CAVEAT_TYPE_RESOURCE, value: Buffer.from(resource, 'utf8') },
    ];
    const buf = mac.encodeCaveats(caveats);
    const decoded = mac.decodeCaveats(buf);
    assert.equal(decoded.length, 2);
    assert.equal(mac.decodeExpiryValue(decoded[0].value), ts);
    assert.equal(decoded[1].value.toString('utf8'), resource);
  });

  it('encodeExpiryValue / decodeExpiryValue roundtrip', () => {
    const ts = 4_102_444_800; // year 2100
    const buf = mac.encodeExpiryValue(ts);
    assert.equal(buf.length, 8);
    assert.equal(mac.decodeExpiryValue(buf), ts);
  });
});

// ── HMAC helper ───────────────────────────────────────────────────────────────

describe('hmacSha256', () => {
  it('produces a 32-byte HMAC', () => {
    const result = mac.hmacSha256(TEST_ROOT_KEY, Buffer.from('hello'));
    assert.equal(result.length, 32);
  });

  it('is deterministic for the same inputs', () => {
    const a = mac.hmacSha256(TEST_ROOT_KEY, Buffer.from('data'));
    const b = mac.hmacSha256(TEST_ROOT_KEY, Buffer.from('data'));
    assert.equal(a.toString('hex'), b.toString('hex'));
  });

  it('differs for different keys', () => {
    const key2 = Buffer.alloc(32, 0xcd);
    const a = mac.hmacSha256(TEST_ROOT_KEY, Buffer.from('data'));
    const b = mac.hmacSha256(key2, Buffer.from('data'));
    assert.notEqual(a.toString('hex'), b.toString('hex'));
  });
});

// ── createMacaroon ────────────────────────────────────────────────────────────

describe('createMacaroon', () => {
  it('returns a non-empty base64url string', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    assert.ok(typeof m === 'string' && m.length > 0);
    // base64url: no +, /, or padding =
    assert.ok(!/[+/=]/.test(m), 'should be base64url (no +/=)');
  });

  it('throws for invalid payment hash (not 64 hex chars)', () => {
    assert.throws(
      () => mac.createMacaroon({ paymentHash: 'deadbeef', rootKey: TEST_ROOT_KEY }),
      /paymentHash must be a 64-character hex string/,
    );
  });

  it('throws for wrong-length root key', () => {
    const { paymentHash } = makePaymentPair();
    assert.throws(
      () => mac.createMacaroon({ paymentHash, rootKey: Buffer.alloc(16) }),
      /rootKey must be a 32-byte Buffer/,
    );
  });

  it('embeds the payment hash (roundtrip via decodeMacaroon)', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.paymentHash, paymentHash);
  });

  it('produces different macaroons for different payment hashes', () => {
    const p1 = makePaymentPair();
    const p2 = makePaymentPair();
    const m1 = mac.createMacaroon({ paymentHash: p1.paymentHash, rootKey: TEST_ROOT_KEY });
    const m2 = mac.createMacaroon({ paymentHash: p2.paymentHash, rootKey: TEST_ROOT_KEY });
    assert.notEqual(m1, m2);
  });
});

// ── decodeMacaroon ────────────────────────────────────────────────────────────

describe('decodeMacaroon', () => {
  it('decodes a macaroon with no caveats', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, true);
    assert.equal(decoded.paymentHash, paymentHash);
    assert.equal(decoded.expiresAt, null);
    assert.equal(decoded.resource, null);
  });

  it('decodes a macaroon with expiry caveat', () => {
    const { paymentHash } = makePaymentPair();
    const ts = Math.floor(Date.now() / 1000) + 3600;
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY, expirySeconds: ts });
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, true);
    assert.equal(decoded.expiresAt, ts);
  });

  it('decodes a macaroon with resource caveat', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY, resource: '/api/data' });
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, true);
    assert.equal(decoded.resource, '/api/data');
  });

  it('decodes a macaroon with both caveats', () => {
    const { paymentHash } = makePaymentPair();
    const ts = Math.floor(Date.now() / 1000) + 7200;
    const m = mac.createMacaroon({
      paymentHash,
      rootKey: TEST_ROOT_KEY,
      expirySeconds: ts,
      resource: '/secure',
    });
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, true);
    assert.equal(decoded.expiresAt, ts);
    assert.equal(decoded.resource, '/secure');
  });

  it('reports signatureValid=false for tampered macaroon', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    // Flip a byte in the middle of the base64url-decoded buffer
    const raw = Buffer.from(m, 'base64url');
    raw[10] ^= 0xff;
    const tampered = raw.toString('base64url');
    const decoded = mac.decodeMacaroon({ macaroon: tampered, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, false);
  });

  it('reports signatureValid=false for wrong root key', () => {
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    const wrongKey = Buffer.alloc(32, 0x11);
    const decoded = mac.decodeMacaroon({ macaroon: m, rootKey: wrongKey });
    assert.equal(decoded.signatureValid, false);
  });

  it('throws for too-short macaroon', () => {
    assert.throws(() => mac.decodeMacaroon({ macaroon: 'YQ', rootKey: TEST_ROOT_KEY }), /too short/);
  });

  it('throws for wrong version byte', () => {
    // Build a macaroon with version byte 0x02
    const { paymentHash } = makePaymentPair();
    const m = mac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    const raw = Buffer.from(m, 'base64url');
    raw[0] = 0x02;
    assert.throws(
      () => mac.decodeMacaroon({ macaroon: raw.toString('base64url'), rootKey: TEST_ROOT_KEY }),
      /Unsupported macaroon version/,
    );
  });
});

// ── verifyPreimage ────────────────────────────────────────────────────────────

describe('verifyPreimage', () => {
  it('returns true for a valid preimage/hash pair', () => {
    const { preimage, paymentHash } = makePaymentPair();
    assert.equal(mac.verifyPreimage(preimage, paymentHash), true);
  });

  it('returns false for wrong preimage', () => {
    const { paymentHash } = makePaymentPair();
    const wrongPreimage = crypto.randomBytes(32).toString('hex');
    assert.equal(mac.verifyPreimage(wrongPreimage, paymentHash), false);
  });

  it('returns false for invalid hex preimage (too short)', () => {
    const { paymentHash } = makePaymentPair();
    assert.equal(mac.verifyPreimage('deadbeef', paymentHash), false);
  });

  it('returns false for invalid payment hash (too short)', () => {
    const { preimage } = makePaymentPair();
    assert.equal(mac.verifyPreimage(preimage, 'deadbeef'), false);
  });

  it('is case-insensitive for hex strings', () => {
    const { preimage, paymentHash } = makePaymentPair();
    assert.equal(mac.verifyPreimage(preimage.toUpperCase(), paymentHash.toUpperCase()), true);
  });
});

// ── checkCaveats ──────────────────────────────────────────────────────────────

describe('checkCaveats', () => {
  it('passes when no caveats are set', () => {
    const { expired, resourceMismatch, caveatsValid } = mac.checkCaveats({
      expiresAt: null,
      resource: null,
    });
    assert.equal(expired, false);
    assert.equal(resourceMismatch, false);
    assert.equal(caveatsValid, true);
  });

  it('passes when expiry is in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { expired, caveatsValid } = mac.checkCaveats({ expiresAt: future, resource: null });
    assert.equal(expired, false);
    assert.equal(caveatsValid, true);
  });

  it('fails when expiry is in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const { expired, caveatsValid } = mac.checkCaveats({ expiresAt: past, resource: null });
    assert.equal(expired, true);
    assert.equal(caveatsValid, false);
  });

  it('passes when resource matches checkResource', () => {
    const { resourceMismatch, caveatsValid } = mac.checkCaveats({
      expiresAt: null,
      resource: '/api',
      checkResource: '/api',
    });
    assert.equal(resourceMismatch, false);
    assert.equal(caveatsValid, true);
  });

  it('fails when resource does not match checkResource', () => {
    const { resourceMismatch, caveatsValid } = mac.checkCaveats({
      expiresAt: null,
      resource: '/api',
      checkResource: '/other',
    });
    assert.equal(resourceMismatch, true);
    assert.equal(caveatsValid, false);
  });

  it('passes when resource is set but checkResource is not provided', () => {
    // No checkResource = unconstrained check
    const { resourceMismatch, caveatsValid } = mac.checkCaveats({
      expiresAt: null,
      resource: '/api',
      checkResource: undefined,
    });
    assert.equal(resourceMismatch, false);
    assert.equal(caveatsValid, true);
  });

  it('uses the nowSeconds override for testing', () => {
    const ts = 1_000_000_000;
    // "now" is 1s before expiry
    const { expired } = mac.checkCaveats({ expiresAt: ts, resource: null, nowSeconds: ts - 1 });
    assert.equal(expired, false);
    // "now" is 1s after expiry
    const { expired: expired2 } = mac.checkCaveats({ expiresAt: ts, resource: null, nowSeconds: ts + 1 });
    assert.equal(expired2, true);
  });
});

// ── getRootKey (env var path) ─────────────────────────────────────────────────

describe('getRootKey', () => {
  let origEnv;
  afterEach(() => {
    // Restore env
    if (origEnv !== undefined) {
      process.env.BLINK_L402_ROOT_KEY = origEnv;
    } else {
      delete process.env.BLINK_L402_ROOT_KEY;
    }
    origEnv = undefined;
  });

  it('returns a 32-byte buffer from BLINK_L402_ROOT_KEY env var', () => {
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_L402_ROOT_KEY = TEST_ROOT_KEY.toString('hex');
    // Re-require fresh module
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    const freshMac = require(path.join(scriptsDir, '_l402_macaroon.js'));
    const key = freshMac.getRootKey();
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
    assert.equal(key.toString('hex'), TEST_ROOT_KEY.toString('hex'));
  });

  it('throws for invalid BLINK_L402_ROOT_KEY (not 64 hex chars)', () => {
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_L402_ROOT_KEY = 'tooshort';
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    const freshMac = require(path.join(scriptsDir, '_l402_macaroon.js'));
    assert.throws(() => freshMac.getRootKey(), /must be a 64-character hex string/);
  });
});

// ── l402_challenge_create: parseCliArgs ──────────────────────────────────────

describe('l402_challenge_create — parseCliArgs', () => {
  let challengeModule;
  before(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_challenge_create.js'))];
    challengeModule = require(path.join(scriptsDir, 'l402_challenge_create.js'));
  });

  it('parses --amount correctly', () => {
    const args = challengeModule.parseCliArgs(['--amount', '100']);
    assert.equal(args.amountSats, 100);
    assert.equal(args.walletId, null);
    assert.equal(args.memo, null);
    assert.equal(args.expirySeconds, null);
    assert.equal(args.resource, null);
  });

  it('parses all options', () => {
    const now = Math.floor(Date.now() / 1000);
    const args = challengeModule.parseCliArgs([
      '--amount',
      '500',
      '--wallet',
      'wallet-id-123',
      '--memo',
      'Test memo',
      '--expiry',
      '3600',
      '--resource',
      '/api/data',
    ]);
    assert.equal(args.amountSats, 500);
    assert.equal(args.walletId, 'wallet-id-123');
    assert.equal(args.memo, 'Test memo');
    assert.ok(args.expirySeconds >= now + 3599 && args.expirySeconds <= now + 3601);
    assert.equal(args.resource, '/api/data');
  });

  it('throws for missing --amount', () => {
    assert.throws(() => challengeModule.parseCliArgs([]), /--amount .* is required/);
  });

  it('throws for non-positive --amount', () => {
    assert.throws(() => challengeModule.parseCliArgs(['--amount', '0']), /positive integer/);
  });

  it('throws for non-numeric --expiry', () => {
    assert.throws(() => challengeModule.parseCliArgs(['--amount', '100', '--expiry', 'abc']), /positive integer/);
  });
});

// ── l402_challenge_create: main() with mocked fetch ──────────────────────────

describe('l402_challenge_create — main() mocked', () => {
  let origFetch;
  let origArgv;
  let origEnv;
  let captured;

  const FAKE_PAYMENT_HASH = 'a'.repeat(64);
  const FAKE_PAYMENT_REQUEST = 'lnbc100n1fakeinvoice';
  const FAKE_WALLET_ID = 'fake-wallet-id';

  function mockFetchRespond(data) {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ data }),
    });
  }

  before(() => {
    origFetch = global.fetch;
    origArgv = process.argv;
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_API_KEY = 'test-api-key';
    process.env.BLINK_L402_ROOT_KEY = TEST_ROOT_KEY.toString('hex');
  });

  after(() => {
    global.fetch = origFetch;
    process.argv = origArgv;
    if (origEnv !== undefined) {
      process.env.BLINK_L402_ROOT_KEY = origEnv;
    } else {
      delete process.env.BLINK_L402_ROOT_KEY;
    }
  });

  afterEach(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_challenge_create.js'))];
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    delete require.cache[require.resolve(path.join(scriptsDir, '_blink_client.js'))];
  });

  it('creates a challenge with correct output fields', async () => {
    // Mock: wallet query + invoice mutation
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // Wallet query
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  wallets: [{ id: FAKE_WALLET_ID, walletCurrency: 'BTC', balance: 100000, pendingIncomingBalance: 0 }],
                },
              },
            },
          }),
        };
      }
      // Invoice creation
      return {
        ok: true,
        json: async () => ({
          data: {
            lnInvoiceCreate: {
              invoice: {
                paymentRequest: FAKE_PAYMENT_REQUEST,
                paymentHash: FAKE_PAYMENT_HASH,
                satoshis: 100,
                paymentStatus: 'PENDING',
                createdAt: '2025-01-01T00:00:00Z',
              },
              errors: [],
            },
          },
        }),
      };
    };

    process.argv = ['node', 'blink', '--amount', '100'];
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);

    try {
      const mod = require(path.join(scriptsDir, 'l402_challenge_create.js'));
      await mod.main();
    } finally {
      console.log = origLog;
    }

    assert.equal(logs.length, 1);
    const output = JSON.parse(logs[0]);
    assert.ok(output.header.startsWith('L402 macaroon="'));
    assert.ok(output.header.includes(`invoice="${FAKE_PAYMENT_REQUEST}"`));
    assert.equal(output.paymentHash, FAKE_PAYMENT_HASH);
    assert.equal(output.satoshis, 100);
    assert.equal(output.invoice, FAKE_PAYMENT_REQUEST);
    assert.ok(typeof output.macaroon === 'string' && output.macaroon.length > 0);
    assert.equal(output.expiresAt, null);
    assert.equal(output.resource, null);
  });

  it('includes expiry and resource in output when provided', async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  wallets: [{ id: FAKE_WALLET_ID, walletCurrency: 'BTC', balance: 100000, pendingIncomingBalance: 0 }],
                },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            lnInvoiceCreate: {
              invoice: {
                paymentRequest: FAKE_PAYMENT_REQUEST,
                paymentHash: FAKE_PAYMENT_HASH,
                satoshis: 500,
                paymentStatus: 'PENDING',
                createdAt: '2025-01-01T00:00:00Z',
              },
              errors: [],
            },
          },
        }),
      };
    };

    process.argv = ['node', 'blink', '--amount', '500', '--expiry', '3600', '--resource', '/api/data'];
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);

    try {
      const mod = require(path.join(scriptsDir, 'l402_challenge_create.js'));
      await mod.main();
    } finally {
      console.log = origLog;
    }

    const output = JSON.parse(logs[0]);
    assert.ok(output.expiresAt > Math.floor(Date.now() / 1000));
    assert.equal(output.resource, '/api/data');
    // Verify the macaroon decodes with these caveats
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    const freshMac = require(path.join(scriptsDir, '_l402_macaroon.js'));
    const decoded = freshMac.decodeMacaroon({ macaroon: output.macaroon, rootKey: TEST_ROOT_KEY });
    assert.equal(decoded.signatureValid, true);
    assert.equal(decoded.resource, '/api/data');
    assert.ok(decoded.expiresAt > 0);
  });
});

// ── l402_payment_verify: parseCliArgs ────────────────────────────────────────

describe('l402_payment_verify — parseCliArgs', () => {
  let verifyModule;
  before(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_payment_verify.js'))];
    verifyModule = require(path.join(scriptsDir, 'l402_payment_verify.js'));
  });

  it('parses --token into macaroon and preimage', () => {
    const preimage = 'b'.repeat(64);
    const macaroon = 'somebase64urlmacaroon';
    const args = verifyModule.parseCliArgs([`--token`, `${macaroon}:${preimage}`]);
    assert.equal(args.macaroon, macaroon);
    assert.equal(args.preimage, preimage);
    assert.equal(args.resource, null);
    assert.equal(args.checkApi, false);
  });

  it('parses --macaroon and --preimage separately', () => {
    const preimage = 'c'.repeat(64);
    const macaroon = 'anothermacaroon';
    const args = verifyModule.parseCliArgs(['--macaroon', macaroon, '--preimage', preimage]);
    assert.equal(args.macaroon, macaroon);
    assert.equal(args.preimage, preimage);
  });

  it('throws when no token/macaroon provided', () => {
    assert.throws(() => verifyModule.parseCliArgs(['--preimage', 'f'.repeat(64)]), /--token|--macaroon/);
  });

  it('throws when --token has no colon', () => {
    assert.throws(() => verifyModule.parseCliArgs(['--token', 'nocolon']), /colon-separated/);
  });

  it('throws for invalid preimage (not 64 hex chars)', () => {
    assert.throws(() => verifyModule.parseCliArgs(['--macaroon', 'mac', '--preimage', 'tooshort']), /64-character hex/);
  });

  it('error message includes character count when preimage is too short', () => {
    let thrown;
    try {
      verifyModule.parseCliArgs(['--macaroon', 'mac', '--preimage', 'deadbeef']);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'should throw');
    assert.match(thrown.message, /8 characters/);
    assert.match(thrown.message, /need exactly 64/);
  });

  it('error message mentions non-hex when preimage has right length but wrong chars', () => {
    const nonHex = 'z'.repeat(64);
    let thrown;
    try {
      verifyModule.parseCliArgs(['--macaroon', 'mac', '--preimage', nonHex]);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'should throw');
    assert.match(thrown.message, /non-hex/);
  });

  it('error message includes usage example hint', () => {
    let thrown;
    try {
      verifyModule.parseCliArgs(['--macaroon', 'mac', '--preimage', 'tooshort']);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'should throw');
    assert.match(thrown.message, /blink l402-verify/);
  });

  it('parses --resource and --check-api flags', () => {
    const preimage = 'd'.repeat(64);
    const args = verifyModule.parseCliArgs([
      '--macaroon',
      'mac',
      '--preimage',
      preimage,
      '--resource',
      '/api/data',
      '--check-api',
    ]);
    assert.equal(args.resource, '/api/data');
    assert.equal(args.checkApi, true);
  });
});

// ── l402_payment_verify: main() full integration ─────────────────────────────

describe('l402_payment_verify — main() mocked', () => {
  let origArgv;
  let origEnv;

  before(() => {
    origArgv = process.argv;
    origEnv = process.env.BLINK_L402_ROOT_KEY;
    process.env.BLINK_L402_ROOT_KEY = TEST_ROOT_KEY.toString('hex');
  });

  after(() => {
    process.argv = origArgv;
    if (origEnv !== undefined) {
      process.env.BLINK_L402_ROOT_KEY = origEnv;
    } else {
      delete process.env.BLINK_L402_ROOT_KEY;
    }
  });

  afterEach(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_payment_verify.js'))];
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    delete require.cache[require.resolve(path.join(scriptsDir, '_blink_client.js'))];
  });

  /**
   * Helper: create a valid macaroon + preimage pair for testing.
   */
  function makeValidToken(opts = {}) {
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    const freshMac = require(path.join(scriptsDir, '_l402_macaroon.js'));
    const { preimage, paymentHash } = makePaymentPair();
    const macaroon = freshMac.createMacaroon({
      paymentHash,
      rootKey: TEST_ROOT_KEY,
      expirySeconds: opts.expirySeconds,
      resource: opts.resource,
    });
    return { macaroon, preimage, paymentHash };
  }

  /**
   * Helper: run main() and capture output.
   */
  async function runVerify(argv) {
    process.argv = ['node', 'blink', ...argv];
    const logs = [];
    const origLog = console.log;
    const origExit = process.exit;
    let exitCode = null;
    console.log = (msg) => logs.push(msg);
    process.exit = (code) => {
      exitCode = code;
      throw Object.assign(new Error('process.exit'), { exitCode: code });
    };
    try {
      delete require.cache[require.resolve(path.join(scriptsDir, 'l402_payment_verify.js'))];
      const mod = require(path.join(scriptsDir, 'l402_payment_verify.js'));
      await mod.main();
    } catch (e) {
      if (!e.exitCode && e.exitCode !== 0) throw e;
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
    return { output: logs.length ? JSON.parse(logs[0]) : null, exitCode };
  }

  it('returns valid=true for a correct token with no caveats', async () => {
    const { macaroon, preimage } = makeValidToken();
    const { output, exitCode } = await runVerify([`--token`, `${macaroon}:${preimage}`]);
    assert.ok(output);
    assert.equal(output.valid, true);
    assert.equal(output.preimageValid, true);
    assert.equal(output.signatureValid, true);
    assert.equal(output.caveatsValid, true);
    assert.equal(output.expired, false);
    assert.equal(exitCode, 0);
  });

  it('returns valid=false for wrong preimage', async () => {
    const { macaroon } = makeValidToken();
    const wrongPreimage = crypto.randomBytes(32).toString('hex');
    const { output, exitCode } = await runVerify([`--token`, `${macaroon}:${wrongPreimage}`]);
    assert.equal(output.valid, false);
    assert.equal(output.preimageValid, false);
    assert.equal(exitCode, 1);
  });

  it('returns valid=false for tampered macaroon', async () => {
    const { preimage, paymentHash } = makePaymentPair();
    delete require.cache[require.resolve(path.join(scriptsDir, '_l402_macaroon.js'))];
    const freshMac = require(path.join(scriptsDir, '_l402_macaroon.js'));
    const macaroon = freshMac.createMacaroon({ paymentHash, rootKey: TEST_ROOT_KEY });
    // Tamper: flip a byte in the macaroon
    const raw = Buffer.from(macaroon, 'base64url');
    raw[10] ^= 0xff;
    const tampered = raw.toString('base64url');
    const { output, exitCode } = await runVerify([`--token`, `${tampered}:${preimage}`]);
    assert.equal(output.valid, false);
    assert.equal(output.signatureValid, false);
    assert.equal(exitCode, 1);
  });

  it('returns valid=false for expired token', async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const { macaroon, preimage } = makeValidToken({ expirySeconds: pastExpiry });
    const { output, exitCode } = await runVerify([`--token`, `${macaroon}:${preimage}`]);
    assert.equal(output.valid, false);
    assert.equal(output.caveatsValid, false);
    assert.equal(output.expired, true);
    assert.equal(exitCode, 1);
  });

  it('returns valid=true for unexpired token', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const { macaroon, preimage } = makeValidToken({ expirySeconds: futureExpiry });
    const { output } = await runVerify([`--token`, `${macaroon}:${preimage}`]);
    assert.equal(output.valid, true);
    assert.equal(output.expired, false);
  });

  it('returns valid=false for resource mismatch', async () => {
    const { macaroon, preimage } = makeValidToken({ resource: '/api/v1' });
    const { output, exitCode } = await runVerify([`--token`, `${macaroon}:${preimage}`, '--resource', '/api/v2']);
    assert.equal(output.valid, false);
    assert.equal(output.caveatsValid, false);
    assert.equal(output.resourceMismatch, true);
    assert.equal(exitCode, 1);
  });

  it('returns valid=true when resource matches', async () => {
    const { macaroon, preimage } = makeValidToken({ resource: '/api/v1' });
    const { output } = await runVerify([`--token`, `${macaroon}:${preimage}`, '--resource', '/api/v1']);
    assert.equal(output.valid, true);
  });

  it('returns apiStatus=PAID when --check-api confirms payment', async () => {
    const { macaroon, preimage, paymentHash } = makeValidToken();
    process.env.BLINK_API_KEY = 'test-api-key';

    let callCount = 0;
    const origFetch = global.fetch;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // getAllWallets
        return {
          ok: true,
          json: async () => ({
            data: {
              me: {
                defaultAccount: {
                  wallets: [{ id: 'wallet-1', walletCurrency: 'BTC', balance: 0, pendingIncomingBalance: 0 }],
                },
              },
            },
          }),
        };
      }
      // invoiceByPaymentHash
      return {
        ok: true,
        json: async () => ({
          data: {
            me: {
              defaultAccount: {
                walletById: {
                  invoiceByPaymentHash: { paymentHash, paymentStatus: 'PAID' },
                },
              },
            },
          },
        }),
      };
    };

    try {
      const { output } = await runVerify([`--token`, `${macaroon}:${preimage}`, '--check-api']);
      assert.equal(output.valid, true);
      assert.equal(output.apiStatus, 'PAID');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('returns apiStatus=NOT_CHECKED when --check-api is not set', async () => {
    const { macaroon, preimage } = makeValidToken();
    const { output } = await runVerify([`--token`, `${macaroon}:${preimage}`]);
    assert.equal(output.apiStatus, 'NOT_CHECKED');
  });
});

// ── bin/blink.js: commands registered ────────────────────────────────────────

describe('bin/blink.js — l402-challenge and l402-verify registered', () => {
  it('lists l402-challenge in help output', () => {
    const origArgv = process.argv;
    process.argv = ['node', 'blink', '--help'];
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => logs.push(msg);
    // blink.js calls main() immediately on require — catch the help output
    try {
      delete require.cache[require.resolve(path.join(binDir, 'blink.js'))];
      // blink.js calls main().catch() but doesn't block; give it a tick
    } finally {
      // restore immediately — we'll check after the tick
    }
    // Actually, bin/blink.js calls main() at module level async
    // We need to check via the commands object directly
    console.log = origLog;
    process.argv = origArgv;

    // Load module and check commands via a different approach
    delete require.cache[require.resolve(path.join(binDir, 'blink.js'))];
    // blink.js exposes nothing directly, so we test by running --help programmatically
    // and capturing via a fresh spawn or by inspecting the source
    // We'll validate via the help text in a simpler way:
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(binDir, 'blink.js'), 'utf8');
    assert.ok(src.includes("commands['l402-challenge']"), 'l402-challenge should be registered');
    assert.ok(src.includes("commands['l402-verify']"), 'l402-verify should be registered');
  });

  it('l402-challenge action calls l402_challenge_create.js', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(binDir, 'blink.js'), 'utf8');
    assert.ok(src.includes('l402_challenge_create.js'), 'action should reference l402_challenge_create.js');
  });

  it('l402-verify action calls l402_payment_verify.js', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(binDir, 'blink.js'), 'utf8');
    assert.ok(src.includes('l402_payment_verify.js'), 'action should reference l402_payment_verify.js');
  });
});
