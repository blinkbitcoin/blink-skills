/**
 * Unit tests for _lnurl.js (LNURL-pay client) and resolveReceiver().
 *
 * All network access is stubbed via a fake global.fetch — no live calls.
 *
 * Run: node --test test/lnurl.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLightningAddress,
  lnurlpMetadataUrl,
  fetchLnurlPayMetadata,
  requestInvoiceFromCallback,
  getInvoiceFromLightningAddress,
  verifyLnurlPayment,
  assertAllowedUrl,
  isPrivateAddress,
  decodeBolt11Hrp,
  assertInvoiceMatches,
  fetchWithRetry,
} = require('../blink/scripts/_lnurl');

const BLINK_ONLY = new Set(['blink.sv']);

/**
 * Build a BOLT-11 string whose human-readable part encodes `msats`.
 *
 * Only the HRP is meaningful to decodeBolt11Hrp; the data part just has to be
 * non-trivial and in the bech32 charset (no '1', 'b', 'i' or 'o').
 *
 * @param {number} msats
 * @param {string} [prefix]  'bc' mainnet, 'tb' testnet, 'bcrt' regtest.
 */
function bolt11(msats, prefix = 'bc') {
  const data = '1' + 'pq'.repeat(12);
  if (msats === null) return `ln${prefix}${data}`; // amountless
  if (msats % 100 === 0) return `ln${prefix}${msats / 100}n${data}`;
  return `ln${prefix}${msats * 10}p${data}`;
}

const { resolveReceiver } = require('../blink/scripts/_blink_client');

// ── fetch stub ────────────────────────────────────────────────────────────────

let originalFetch;

/**
 * Install a fetch stub. `handler(url)` returns { status?, json?, throws? }.
 */
function stubFetch(handler) {
  global.fetch = async (url) => {
    const spec = handler(String(url));
    if (spec && spec.throws) throw new Error(spec.throws);
    const headers = new Map();
    // `location` drives the manual-redirect path in fetchWithRetry.
    if (spec.location) headers.set('location', spec.location);
    return {
      ok: spec.status ? spec.status >= 200 && spec.status < 300 : true,
      status: spec.status || 200,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
      async json() {
        if (spec.json === undefined) throw new Error('not json');
        return spec.json;
      },
      async text() {
        return JSON.stringify(spec.json || {});
      },
    };
  };
}

/** Record every URL the code under test actually fetched. */
function stubFetchRecording(handler) {
  const seen = [];
  stubFetch((url) => {
    seen.push(url);
    return handler(url);
  });
  return seen;
}

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

// ── parseLightningAddress ─────────────────────────────────────────────────────

describe('parseLightningAddress', () => {
  it('parses user@domain', () => {
    assert.deepEqual(parseLightningAddress('alice@blink.sv'), { username: 'alice', domain: 'blink.sv' });
  });

  it('lowercases input', () => {
    assert.deepEqual(parseLightningAddress('Alice@Blink.SV'), { username: 'alice', domain: 'blink.sv' });
  });

  it('accepts a bare username (domain null)', () => {
    assert.deepEqual(parseLightningAddress('alice'), { username: 'alice', domain: null });
  });

  it('rejects empty input', () => {
    assert.throws(() => parseLightningAddress('  '), /Empty/);
  });

  it('rejects malformed addresses', () => {
    assert.throws(() => parseLightningAddress('a@b@c'), /Invalid/);
    assert.throws(() => parseLightningAddress('@blink.sv'), /Invalid/);
  });
});

describe('lnurlpMetadataUrl', () => {
  it('builds an https well-known URL', () => {
    assert.equal(lnurlpMetadataUrl('alice', 'blink.sv'), 'https://blink.sv/.well-known/lnurlp/alice');
  });
  it('uses http for localhost', () => {
    assert.match(lnurlpMetadataUrl('alice', 'localhost:8080'), /^http:\/\//);
  });
});

// ── fetchLnurlPayMetadata ─────────────────────────────────────────────────────

describe('fetchLnurlPayMetadata', () => {
  it('returns callback + bounds on a valid payRequest', async () => {
    stubFetch(() => ({
      json: {
        tag: 'payRequest',
        callback: 'https://blink.sv/lnurlp/alice/invoice',
        minSendable: 1000,
        maxSendable: 100000000,
        metadata: '[["text/plain","pay alice"]]',
        commentAllowed: 120,
      },
    }));
    const meta = await fetchLnurlPayMetadata('alice', 'blink.sv');
    assert.equal(meta.callback, 'https://blink.sv/lnurlp/alice/invoice');
    assert.equal(meta.minSendable, 1000);
    assert.equal(meta.commentAllowed, 120);
  });

  it('throws LNURL_NOT_FOUND on 404', async () => {
    stubFetch(() => ({ status: 404, json: {} }));
    await assert.rejects(() => fetchLnurlPayMetadata('nobody', 'blink.sv'), (e) => e.code === 'LNURL_NOT_FOUND');
  });

  it('throws LNURL_NOT_FOUND on LNURL ERROR body', async () => {
    stubFetch(() => ({ json: { status: 'ERROR', reason: 'not found' } }));
    await assert.rejects(() => fetchLnurlPayMetadata('nobody', 'blink.sv'), (e) => e.code === 'LNURL_NOT_FOUND');
  });

  it('throws on a non-payRequest tag', async () => {
    stubFetch(() => ({ json: { tag: 'withdrawRequest' } }));
    await assert.rejects(() => fetchLnurlPayMetadata('alice', 'blink.sv'), /payRequest/);
  });
});

// ── requestInvoiceFromCallback ────────────────────────────────────────────────

describe('requestInvoiceFromCallback', () => {
  it('returns paymentRequest and captures the LUD-21 verify URL', async () => {
    const pr = bolt11(1000000);
    stubFetch(() => ({ json: { pr, verify: 'https://blink.sv/verify/abc' } }));
    const inv = await requestInvoiceFromCallback('https://blink.sv/cb', 1000000, 'hi');
    assert.equal(inv.paymentRequest, pr);
    assert.equal(inv.verify, 'https://blink.sv/verify/abc');
  });

  it('tolerates a missing verify (custodial)', async () => {
    stubFetch(() => ({ json: { pr: bolt11(1000000) } }));
    const inv = await requestInvoiceFromCallback('https://blink.sv/cb', 1000000);
    assert.equal(inv.verify, null);
  });

  it('throws when no invoice is returned', async () => {
    stubFetch(() => ({ json: { status: 'ERROR', reason: 'bad amount' } }));
    await assert.rejects(() => requestInvoiceFromCallback('https://blink.sv/cb', 1), /bad amount/);
  });
});

// ── getInvoiceFromLightningAddress ────────────────────────────────────────────

describe('getInvoiceFromLightningAddress', () => {
  it('mints an invoice end-to-end and enforces min bound', async () => {
    const pr = bolt11(1000 * 1000);
    stubFetch((url) => {
      if (url.includes('/.well-known/lnurlp/')) {
        return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 100000000, commentAllowed: 0 } };
      }
      return { json: { pr, verify: 'https://blink.sv/verify/abc' } };
    });
    const inv = await getInvoiceFromLightningAddress('alice@blink.sv', 1000);
    assert.equal(inv.paymentRequest, pr);
    assert.equal(inv.verify, 'https://blink.sv/verify/abc');
    assert.equal(inv.lightningAddress, 'alice@blink.sv');
  });

  it('rejects an amount below minSendable', async () => {
    stubFetch(() => ({ json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 10000, maxSendable: 100000000 } }));
    await assert.rejects(() => getInvoiceFromLightningAddress('alice@blink.sv', 1), (e) => e.code === 'AMOUNT_TOO_LOW');
  });
});

// ── verifyLnurlPayment ────────────────────────────────────────────────────────

describe('verifyLnurlPayment', () => {
  it('reports settled=true with preimage', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: true, preimage: 'deadbeef' } }));
    const r = await verifyLnurlPayment('https://blink.sv/verify/abc');
    assert.equal(r.settled, true);
    assert.equal(r.preimage, 'deadbeef');
  });

  it('reports settled=false while pending', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: false } }));
    const r = await verifyLnurlPayment('https://blink.sv/verify/abc');
    assert.equal(r.settled, false);
  });
});

// ── resolveReceiver ───────────────────────────────────────────────────────────

describe('resolveReceiver', () => {
  it('classifies a custodial account (accountDefaultWallet returns a wallet)', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { data: { accountDefaultWallet: { id: 'wallet-123', walletCurrency: 'BTC' } } } };
      }
      return { status: 404, json: {} };
    });
    const r = await resolveReceiver('pretyflaco@blink.sv', {});
    assert.equal(r.type, 'custodial');
    assert.equal(r.walletId, 'wallet-123');
  });

  it('falls back to lnaddress when custodial misses but LNURL resolves', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { data: { accountDefaultWallet: null } } };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    const r = await resolveReceiver('yasar@blink.sv', {});
    assert.equal(r.type, 'lnaddress');
    assert.equal(r.walletId, null);
  });

  it('throws RECEIVER_NOT_FOUND when neither resolves', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { data: { accountDefaultWallet: null } } };
      return { status: 404, json: {} };
    });
    await assert.rejects(() => resolveReceiver('ghost@blink.sv', {}), (e) => e.code === 'RECEIVER_NOT_FOUND');
  });

  it('SSRF guard: rejects a non-blink.sv domain before any network call', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await assert.rejects(() => resolveReceiver('alice@evil.com', {}), /non-Blink domain/);
    assert.equal(called, false, 'fetch must not be called for a disallowed domain');
  });

  // Review finding #7: a transient custodial-probe failure used to be swallowed
  // and the account then reported as non-custodial — a confident wrong answer
  // manufactured by an outage.
  it('propagates a 503 on the custodial probe instead of guessing lnaddress', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { status: 503, json: { error: 'upstream' } };
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    await assert.rejects(
      () => resolveReceiver('pretyflaco@blink.sv', {}),
      (e) => e.code === 'CUSTODIAL_PROBE_FAILED',
    );
  });

  it('propagates a network error on the custodial probe', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { throws: 'fetch failed' };
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    await assert.rejects(
      () => resolveReceiver('pretyflaco@blink.sv', {}),
      (e) => e.code === 'CUSTODIAL_PROBE_FAILED',
    );
  });

  it('propagates an authentication error rather than misclassifying', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { errors: [{ message: 'Not authorized' }] } };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    await assert.rejects(
      () => resolveReceiver('pretyflaco@blink.sv', {}),
      (e) => e.code === 'CUSTODIAL_PROBE_FAILED',
    );
  });

  // A message-matching fallback is only safe if it cannot match errors that
  // mean "the lookup did not happen". These are the ones that would otherwise
  // reinstate the bug for EVERY username at once.
  it('does not mistake schema drift or a gateway 404 for an absent account', async () => {
    for (const message of [
      'Cannot query field "accountDefaultWallet" on type "Query": not found',
      '404 Not Found',
      'Route not found',
      'Invalid username or password',
      'Service Unavailable',
    ]) {
      stubFetch((url) => {
        if (url.includes('/graphql')) return { json: { errors: [{ message }] } };
        return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1, maxSendable: 1e9 } };
      });
      await assert.rejects(
        () => resolveReceiver('pretyflaco@blink.sv', {}),
        (e) => e.code === 'CUSTODIAL_PROBE_FAILED',
        `"${message}" must not be read as an absent account`,
      );
    }
  });

  it('honours a structured not-found code from extensions', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { errors: [{ message: 'nope', extensions: { code: 'ACCOUNT_NOT_FOUND' } }] } };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1, maxSendable: 1e9 } };
    });
    const r = await resolveReceiver('yasar@blink.sv', {});
    assert.equal(r.type, 'lnaddress');
  });

  it('still falls back to lnaddress on a genuine "does not exist" GraphQL error', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { errors: [{ message: 'Account does not exist for username' }] } };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    const r = await resolveReceiver('yasar@blink.sv', {});
    assert.equal(r.type, 'lnaddress');
  });
});

// ── SSRF guard: assertAllowedUrl / isPrivateAddress ──────────────────────────

describe('isPrivateAddress', () => {
  it('flags private, loopback and link-local IPv4', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
    }
  });

  it('does not flag public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
    }
  });

  it('flags IPv6 loopback, unique-local and link-local', () => {
    for (const ip of ['::1', '[::1]', 'fc00::1', 'fd12::1', 'fe80::1']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
    }
  });

  it('sees through IPv4-mapped IPv6 in both spellings', () => {
    assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
    // This is the form `new URL()` actually produces, so it is the one the
    // guard sees. Asserting only the dotted form left the control absent.
    assert.equal(isPrivateAddress('::ffff:a9fe:a9fe'), true);
    assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  });
});

describe('assertAllowedUrl', () => {
  it('accepts an allowlisted https host', () => {
    const u = assertAllowedUrl('https://blink.sv/cb', BLINK_ONLY);
    assert.equal(u.hostname, 'blink.sv');
  });

  it('rejects a host off the allowlist', () => {
    assert.throws(() => assertAllowedUrl('https://attacker.example/cb', BLINK_ONLY), /non-Blink host/);
  });

  it('rejects plaintext http for a remote host', () => {
    assert.throws(() => assertAllowedUrl('http://blink.sv/cb', BLINK_ONLY), /plaintext http/);
  });

  it('rejects non-http schemes', () => {
    assert.throws(() => assertAllowedUrl('file:///etc/passwd', BLINK_ONLY), /unsupported scheme/);
    assert.throws(() => assertAllowedUrl('gopher://blink.sv/', BLINK_ONLY), /unsupported scheme/);
  });

  it('rejects an unparseable URL', () => {
    assert.throws(() => assertAllowedUrl('not a url', BLINK_ONLY), /unparseable/);
  });

  it('rejects a private address even with the allowlist disabled', () => {
    assert.throws(() => assertAllowedUrl('https://169.254.169.254/latest/meta-data', null), /private address/);
  });

  it('does not treat localhost as a prefix', () => {
    // `startsWith('localhost')` would have downgraded this to http and allowed it.
    assert.throws(() => assertAllowedUrl('http://localhost.attacker.example/', BLINK_ONLY), /non-Blink host/);
  });

  // Being loopback must NOT be a licence to be fetched. An earlier revision of
  // this guard exempted local hosts from the allowlist AND the private-address
  // check, so a hostile LNURL response naming http://127.0.0.1:6379/ — or its
  // integer spelling http://2130706433/, which WHATWG normalises to the same
  // host — reached services on the loopback interface.
  it('refuses loopback in every spelling when an allowlist is in force', () => {
    for (const u of [
      'http://127.0.0.1:6379/x',
      'http://2130706433/admin',
      'http://0x7f000001/',
      'http://127.1/',
      'http://localhost:8080/',
      'http://[::1]:9200/',
    ]) {
      assert.throws(() => assertAllowedUrl(u, BLINK_ONLY), `${u} must be refused`);
    }
  });

  it('refuses IPv4-mapped IPv6 metadata addresses with the allowlist disabled', () => {
    assert.throws(() => assertAllowedUrl('https://[::ffff:169.254.169.254]/', null), /private address/);
  });

  it('refuses a non-standard port on an allowlisted host', () => {
    assert.throws(() => assertAllowedUrl('https://blink.sv:8443/x', BLINK_ONLY), /non-standard port/);
  });

  it('permits a host:port the caller listed explicitly', () => {
    const u = assertAllowedUrl('https://blink.sv:8443/x', new Set(['blink.sv', 'blink.sv:8443']));
    assert.equal(u.port, '8443');
  });

  it('allows plaintext localhost when the caller opted out of the allowlist', () => {
    assert.doesNotThrow(() => assertAllowedUrl('http://localhost:8080/', null));
  });

  it('allows plaintext localhost when the caller listed it with its port', () => {
    // The port is part of what must be allowed, so a dev/regtest caller names
    // `localhost:8080` rather than just `localhost`.
    assert.doesNotThrow(() => assertAllowedUrl('http://localhost:8080/', new Set(['localhost', 'localhost:8080'])));
    assert.throws(() => assertAllowedUrl('http://localhost:8080/', new Set(['localhost'])), /non-standard port/);
  });
});

// ── Allowlist enforcement at every hop ───────────────────────────────────────

describe('LNURL host allowlist (per hop)', () => {
  it('refuses a callback URL pointing off-allowlist', async () => {
    stubFetch(() => ({
      json: { tag: 'payRequest', callback: 'https://attacker.example/cb', minSendable: 1000, maxSendable: 1e9 },
    }));
    await assert.rejects(
      () => getInvoiceFromLightningAddress('alice@blink.sv', 1000, undefined, { allowedHosts: BLINK_ONLY }),
      /callback URL from non-Blink host/,
    );
  });

  it('refuses a LUD-21 verify URL pointing off-allowlist', async () => {
    stubFetch((url) => {
      if (url.includes('/.well-known/')) {
        return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
      }
      return { json: { pr: bolt11(1000 * 1000), verify: 'https://attacker.example/verify/1' } };
    });
    await assert.rejects(
      () => getInvoiceFromLightningAddress('alice@blink.sv', 1000, undefined, { allowedHosts: BLINK_ONLY }),
      /verify URL from non-Blink host/,
    );
  });

  it('refuses to follow a redirect to an off-allowlist host', async () => {
    const seen = stubFetchRecording((url) => {
      if (url.includes('blink.sv')) return { status: 302, location: 'https://attacker.example/steal' };
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb' } };
    });
    await assert.rejects(
      () => fetchLnurlPayMetadata('alice', 'blink.sv', { allowedHosts: BLINK_ONLY, retries: 0 }),
      /redirect target from non-Blink host/,
    );
    assert.ok(
      !seen.some((u) => u.includes('attacker.example')),
      'must not have fetched the redirect target',
    );
  });

  it('refuses a redirect to a private address', async () => {
    stubFetch((url) => {
      if (url.includes('blink.sv')) return { status: 302, location: 'http://169.254.169.254/latest/meta-data' };
      return { json: {} };
    });
    await assert.rejects(
      () => fetchLnurlPayMetadata('alice', 'blink.sv', { allowedHosts: BLINK_ONLY, retries: 0 }),
      /redirect target/,
    );
  });

  it('follows an allowlisted redirect', async () => {
    let hops = 0;
    stubFetch((url) => {
      hops++;
      if (url.endsWith('/.well-known/lnurlp/alice')) {
        return { status: 302, location: 'https://blink.sv/lnurlp/alice' };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1, maxSendable: 1e9 } };
    });
    const meta = await fetchLnurlPayMetadata('alice', 'blink.sv', { allowedHosts: BLINK_ONLY, retries: 0 });
    assert.equal(meta.callback, 'https://blink.sv/cb');
    assert.equal(hops, 2);
  });

  it('bounds the redirect chain', async () => {
    let n = 0;
    stubFetch(() => ({ status: 302, location: `https://blink.sv/hop${n++}` }));
    await assert.rejects(
      () => fetchWithRetry('https://blink.sv/start', { allowedHosts: BLINK_ONLY, retries: 0 }),
      /Too many redirects/,
    );
  });

  it('does not retry a policy rejection as if it were a network fault', async () => {
    const seen = stubFetchRecording(() => ({ json: {} }));
    await assert.rejects(
      () => fetchWithRetry('https://attacker.example/x', { allowedHosts: BLINK_ONLY, retries: 2 }),
      /non-Blink host/,
    );
    assert.equal(seen.length, 0, 'guard must reject before any attempt');
  });
});

// ── BOLT-11 binding ──────────────────────────────────────────────────────────

describe('decodeBolt11Hrp', () => {
  it('decodes the multipliers against the BOLT-11 spec', () => {
    // 1 BTC = 1e11 msat.
    assert.equal(decodeBolt11Hrp(bolt11(100000000)).amountMsats, 100000000); // 1m  = 1e8 msat
    assert.equal(decodeBolt11Hrp('lnbc1m' + '1' + 'pq'.repeat(6)).amountMsats, 100000000);
    assert.equal(decodeBolt11Hrp('lnbc1u' + '1' + 'pq'.repeat(6)).amountMsats, 100000);
    assert.equal(decodeBolt11Hrp('lnbc1n' + '1' + 'pq'.repeat(6)).amountMsats, 100);
    assert.equal(decodeBolt11Hrp('lnbc10p' + '1' + 'pq'.repeat(6)).amountMsats, 1);
  });

  it('reads the network from the prefix', () => {
    assert.equal(decodeBolt11Hrp(bolt11(1000, 'bc')).network, 'mainnet');
    assert.equal(decodeBolt11Hrp(bolt11(1000, 'tb')).network, 'testnet');
    assert.equal(decodeBolt11Hrp(bolt11(1000, 'bcrt')).network, 'regtest');
  });

  it('returns null amount for an amountless invoice', () => {
    assert.equal(decodeBolt11Hrp(bolt11(null)).amountMsats, null);
  });

  it('rejects a non-invoice', () => {
    assert.throws(() => decodeBolt11Hrp('lnbc10n1p...'), /bad bech32 data part/);
    assert.throws(() => decodeBolt11Hrp('http://blink.sv'), /unrecognised prefix|separator/);
    assert.throws(() => decodeBolt11Hrp(''), /Empty/);
  });

  it('rejects a sub-millisatoshi amount', () => {
    assert.throws(() => decodeBolt11Hrp('lnbc1p' + '1' + 'pq'.repeat(6)), /sub-millisatoshi/);
  });
});

describe('assertInvoiceMatches', () => {
  it('accepts an exact match', () => {
    assert.equal(assertInvoiceMatches(bolt11(1000000), { amountMsats: 1000000 }).amountMsats, 1000000);
  });

  it('rejects an amount mismatch', () => {
    assert.throws(() => assertInvoiceMatches(bolt11(500), { amountMsats: 1000000 }), /Refusing it/);
  });

  it('rejects a wrong-network invoice', () => {
    assert.throws(() => assertInvoiceMatches(bolt11(1000000, 'tb'), { amountMsats: 1000000 }), /testnet invoice/);
  });

  it('rejects an amountless invoice', () => {
    assert.throws(() => assertInvoiceMatches(bolt11(null), { amountMsats: 1000000 }), /amountless/);
  });
});

describe('requestInvoiceFromCallback binding', () => {
  it('refuses an invoice for a different amount than requested', async () => {
    stubFetch(() => ({ json: { pr: bolt11(500) } }));
    await assert.rejects(
      () => requestInvoiceFromCallback('https://blink.sv/cb', 1000000, undefined, { allowedHosts: BLINK_ONLY }),
      /Refusing it/,
    );
  });

  it('refuses a testnet invoice when mainnet was requested', async () => {
    stubFetch(() => ({ json: { pr: bolt11(1000000, 'tb') } }));
    await assert.rejects(
      () => requestInvoiceFromCallback('https://blink.sv/cb', 1000000, undefined, { allowedHosts: BLINK_ONLY }),
      /testnet invoice/,
    );
  });

  it('refuses a `pr` that is not a BOLT-11 invoice at all', async () => {
    stubFetch(() => ({ json: { pr: 'https://attacker.example/pay' } }));
    await assert.rejects(
      () => requestInvoiceFromCallback('https://blink.sv/cb', 1000000, undefined, { allowedHosts: BLINK_ONLY }),
      /not a BOLT-11 invoice/,
    );
  });
});

// ── LUD-21 settlement binding ────────────────────────────────────────────────

describe('verifyLnurlPayment binding', () => {
  const ours = bolt11(1000000);
  const theirs = bolt11(2000000);

  it('accepts settlement whose pr matches the polled invoice', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: true, preimage: 'dead', pr: ours } }));
    const r = await verifyLnurlPayment('https://blink.sv/v/1', { expectedPr: ours, allowedHosts: BLINK_ONLY });
    assert.equal(r.settled, true);
  });

  it('rejects settlement reported for a different invoice', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: true, preimage: 'dead', pr: theirs } }));
    await assert.rejects(
      () => verifyLnurlPayment('https://blink.sv/v/1', { expectedPr: ours, allowedHosts: BLINK_ONLY }),
      /DIFFERENT invoice/,
    );
  });

  it('rejects settled=true with no pr to bind against', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: true } }));
    await assert.rejects(
      () => verifyLnurlPayment('https://blink.sv/v/1', { expectedPr: ours, allowedHosts: BLINK_ONLY }),
      /no `pr` to bind/,
    );
  });

  it('is case-insensitive, as BOLT-11 is', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: true, pr: ours.toUpperCase() } }));
    const r = await verifyLnurlPayment('https://blink.sv/v/1', { expectedPr: ours, allowedHosts: BLINK_ONLY });
    assert.equal(r.settled, true);
  });

  it('does not require binding while still pending', async () => {
    stubFetch(() => ({ json: { status: 'OK', settled: false } }));
    const r = await verifyLnurlPayment('https://blink.sv/v/1', { expectedPr: ours, allowedHosts: BLINK_ONLY });
    assert.equal(r.settled, false);
  });
});
