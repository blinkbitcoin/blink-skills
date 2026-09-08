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
  isLnurlNotFoundReason,
  bech32Decode,
  decodeBolt11,
  assertInvoiceMatches,
  fetchWithRetry,
} = require('../blink/scripts/_lnurl');

const BLINK_ONLY = new Set(['blink.sv']);

// ── Real invoice fixtures ────────────────────────────────────────────────────
//
// The BOLT-11 binding now verifies the bech32 checksum and the LUD-06
// description-hash, so the fixtures have to be REAL invoices — the synthetic
// HRP-only strings the earlier tests used (`lnbc10n1p...`) are exactly what
// this control exists to reject. `bech32` is a devDependency used only here.

const { bech32 } = require('bech32');
const crypto = require('node:crypto');

const TEST_METADATA = '[["text/plain","pay alice"]]';
const TEST_METADATA_HASH = crypto.createHash('sha256').update(TEST_METADATA, 'utf8').digest('hex');

/**
 * Build a structurally valid BOLT-11 invoice whose HRP encodes `msats` and
 * whose description-hash tag commits to `metadata`.
 *
 * @param {number|null} msats  Null for an amountless invoice.
 * @param {string} [prefix]  'bc' mainnet, 'tb' testnet, 'bcrt' regtest.
 * @param {string} [metadata]  LUD-06 metadata the desc-hash commits to.
 */
function bolt11(msats, prefix = 'bc', metadata = TEST_METADATA, buildOpts = {}) {
  const hrp = `ln${prefix}${amountSuffix(msats)}`;
  const hash = crypto.createHash('sha256').update(metadata, 'utf8').digest();

  // Timestamp: 35 bits big-endian as 7 five-bit words. A real (non-zero,
  // unexpired) timestamp is now required, so fixtures must carry one.
  const ts = buildOpts.timestampSeconds !== undefined ? buildOpts.timestampSeconds : Math.floor(Date.now() / 1000);
  const tsWords = [];
  for (let w = 6; w >= 0; w--) tsWords.push(Math.floor(ts / Math.pow(32, w)) % 32);

  const tags = [];
  // `p` payment hash (type 1, 52 words) — now mandatory.
  if (!buildOpts.omitPaymentHash) {
    const pHash = crypto
      .createHash('sha256')
      .update('payment:' + (buildOpts.paymentSeed || 'seed'))
      .digest();
    tags.push(1, (52 >> 5) & 31, 52 & 31, ...bech32.toWords(pHash));
  }
  // Description form: h (type 23) or d (type 13), or both for the dup test.
  const descWords = bech32.toWords(hash);
  if (buildOpts.bothDescriptions) {
    const dBytes = bech32.toWords(Buffer.from('desc', 'utf8'));
    tags.push(13, (dBytes.length >> 5) & 31, dBytes.length & 31, ...dBytes);
    tags.push(23, (52 >> 5) & 31, 52 & 31, ...descWords);
  } else if (!buildOpts.omitDescription) {
    tags.push(23, (52 >> 5) & 31, 52 & 31, ...descWords);
  }
  // `s` payment secret (type 16, 52 words) — now mandatory under BOLT #11.
  if (!buildOpts.omitPaymentSecret) {
    const sHash = crypto
      .createHash('sha256')
      .update('secret:' + (buildOpts.paymentSeed || 'seed'))
      .digest();
    tags.push(16, (52 >> 5) & 31, 52 & 31, ...bech32.toWords(sHash));
  }
  // `x` expiry (type 6) when given.
  if (buildOpts.expirySeconds !== undefined) {
    const exp = buildOpts.expirySeconds;
    const expWords = [];
    let v = exp;
    while (v > 0) {
      expWords.unshift(v % 32);
      v = Math.floor(v / 32);
    }
    tags.push(6, (expWords.length >> 5) & 31, expWords.length & 31, ...expWords);
  }

  // Signature region: 104 words = 65 bytes (64-byte sig + recovery id). The
  // default is all-zero, i.e. recovery id 0 (valid). buildOpts.recoveryByte
  // overrides the last byte for the boundary tests.
  const sigWords = new Array(104).fill(0);
  if (buildOpts.recoveryByte !== undefined) {
    // Recovery id is byte 64 of the 65-byte sig = the low 5 bits of word 103
    // plus the high 3 bits of word 102... simplest: build bytes, set, reconvert.
    const sigBytes = new Array(65).fill(0);
    sigBytes[64] = buildOpts.recoveryByte;
    // 8-bit bytes back to 5-bit words.
    let acc = 0;
    let bits = 0;
    const out = [];
    for (const b of sigBytes) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out.push((acc >>> bits) & 31);
      }
    }
    if (bits > 0) out.push((acc << (5 - bits)) & 31);
    for (let k = 0; k < 104; k++) sigWords[k] = out[k];
  }

  const words = [...tsWords, ...tags, ...sigWords];
  return bech32.encode(hrp, words, 20000);
}

/** The `<digits><multiplier>` HRP suffix for a msat amount. */
function amountSuffix(msats) {
  if (msats === null) return '';
  if (msats % 100 === 0) return `${msats / 100}n`;
  return `${msats * 10}p`;
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
    await assert.rejects(
      () => fetchLnurlPayMetadata('nobody', 'blink.sv'),
      (e) => e.code === 'LNURL_NOT_FOUND',
    );
  });

  it('throws LNURL_NOT_FOUND on LNURL ERROR body with a receiver-anchored not-found reason', async () => {
    stubFetch(() => ({ json: { status: 'ERROR', reason: 'user not found' } }));
    await assert.rejects(
      () => fetchLnurlPayMetadata('nobody', 'blink.sv'),
      (e) => e.code === 'LNURL_NOT_FOUND',
    );
  });

  // A transient server failure must NOT be classified as "the address does not
  // exist" — that is the outage-as-identity-answer bug, one layer down.
  it('throws LNURL_SERVICE_ERROR on a transient LNURL ERROR body', async () => {
    stubFetch(() => ({ json: { status: 'ERROR', reason: 'temporarily overloaded' } }));
    await assert.rejects(
      () => fetchLnurlPayMetadata('alice', 'blink.sv'),
      (e) => e.code === 'LNURL_SERVICE_ERROR',
    );
  });

  it('distinguishes not-found from transient reasons', () => {
    assert.equal(isLnurlNotFoundReason('user not found'), true);
    assert.equal(isLnurlNotFoundReason('account does not exist'), true);
    assert.equal(isLnurlNotFoundReason('temporarily overloaded'), false);
    assert.equal(isLnurlNotFoundReason('rate limited, retry later'), false);
    assert.equal(isLnurlNotFoundReason('internal error'), false);
  });

  // The EXACT production Blink body for a nonexistent address is verb-first.
  // Confirmed live: {"reason":"Couldn't find user 'x'.","status":"ERROR"}.
  it('classifies the live production missing-user body as not-found', async () => {
    stubFetch(() => ({ json: { status: 'ERROR', reason: "Couldn't find user 'nonexistentprobezz'." } }));
    await assert.rejects(
      () => fetchLnurlPayMetadata('nonexistentprobezz', 'blink.sv'),
      (e) => e.code === 'LNURL_NOT_FOUND',
    );
  });

  it('maps the production missing-user body to RECEIVER_NOT_FOUND in resolveReceiver', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { data: { accountDefaultWallet: null } } };
      return { json: { status: 'ERROR', reason: "Couldn't find user 'nonexistentprobezz'." } };
    });
    await assert.rejects(
      () => resolveReceiver('nonexistentprobezz@blink.sv', {}),
      (e) => e.code === 'RECEIVER_NOT_FOUND',
    );
  });

  it('a generic NOT_FOUND code does not override contradictory transient prose', () => {
    assert.equal(isLnurlNotFoundReason('backend temporarily overloaded', 'NOT_FOUND'), false);
    assert.equal(isLnurlNotFoundReason('user not found', 'NOT_FOUND'), true);
    assert.equal(isLnurlNotFoundReason('whatever', 'USER_NOT_FOUND'), true);
  });

  // Review finding: an unrestricted /not found/ matched infrastructure errors,
  // letting them be misreported as receiver-absence. These must stay SERVICE.
  it('does not classify infrastructure or payment "not found" as receiver-absence', () => {
    for (const reason of [
      'upstream route not found',
      'backend service not found',
      'invoice not found',
      'page not found',
      'resource not found',
    ]) {
      assert.equal(isLnurlNotFoundReason(reason), false, `"${reason}" must not read as receiver-absence`);
    }
    // The receiver-anchored forms still do.
    for (const reason of ['user not found', 'account not found', 'username does not exist', 'unknown address']) {
      assert.equal(isLnurlNotFoundReason(reason), true, `"${reason}" should read as receiver-absence`);
    }
  });

  it('honours a structured not-found code on the LUD-06 error body', () => {
    assert.equal(isLnurlNotFoundReason('whatever', 'USER_NOT_FOUND'), true);
    assert.equal(isLnurlNotFoundReason('whatever', 'RATE_LIMITED'), false);
  });

  // A single transient 404 (proxy/WAF/rolling deploy) must not be relayed as
  // "this address does not exist" — only a consistent 404 is absence.
  it('recovers from one transient 404 before declaring not-found', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 1) return { status: 404, json: {} };
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1, maxSendable: 1e9 } };
    });
    const meta = await fetchLnurlPayMetadata('alice', 'blink.sv', { retries: 1 });
    assert.equal(meta.callback, 'https://blink.sv/cb');
    assert.equal(calls, 2, 'must retry the first 404');
  });

  it('still treats a CONSISTENT 404 as not-found after retrying', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return { status: 404, json: {} };
    });
    await assert.rejects(
      () => fetchLnurlPayMetadata('nobody', 'blink.sv', { retries: 1 }),
      (e) => e.code === 'LNURL_NOT_FOUND',
    );
    assert.equal(calls, 2, 'must have retried before giving up');
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
        return {
          json: {
            tag: 'payRequest',
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 100000000,
            commentAllowed: 0,
            metadata: TEST_METADATA,
          },
        };
      }
      return { json: { pr, verify: 'https://blink.sv/verify/abc' } };
    });
    const inv = await getInvoiceFromLightningAddress('alice@blink.sv', 1000);
    assert.equal(inv.paymentRequest, pr);
    assert.equal(inv.verify, 'https://blink.sv/verify/abc');
    assert.equal(inv.lightningAddress, 'alice@blink.sv');
  });

  it('rejects an amount below minSendable', async () => {
    stubFetch(() => ({
      json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 10000, maxSendable: 100000000 },
    }));
    await assert.rejects(
      () => getInvoiceFromLightningAddress('alice@blink.sv', 1),
      (e) => e.code === 'AMOUNT_TOO_LOW',
    );
  });

  // Production topology regression (review finding): the live blink.sv metadata
  // returns its callback on lnurl.blink.sv, NOT blink.sv. The address domain and
  // the LNURL service host are different sets, and conflating them breaks the
  // whole credential-free receive path.
  it('accepts a callback on the lnurl.blink.sv service host (production topology)', async () => {
    const { ALLOWED_LN_ADDRESS_DOMAINS, ALLOWED_LNURL_SERVICE_HOSTS } = require('../blink/scripts/_blink_client');
    const pr = bolt11(1000 * 1000);
    stubFetch((url) => {
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            callback: 'https://lnurl.blink.sv/lnurlp/blink.sv/alice/invoice',
            minSendable: 1000,
            maxSendable: 1e9,
            metadata: TEST_METADATA,
          },
        };
      }
      return { json: { pr, verify: 'https://lnurl.blink.sv/verify/abc' } };
    });
    const inv = await getInvoiceFromLightningAddress('alice@blink.sv', 1000, undefined, {
      allowedAddressDomains: ALLOWED_LN_ADDRESS_DOMAINS,
      allowedHosts: ALLOWED_LNURL_SERVICE_HOSTS,
    });
    assert.equal(inv.paymentRequest, pr);
    assert.equal(inv.verify, 'https://lnurl.blink.sv/verify/abc');
  });

  it('still refuses a callback on an arbitrary host even when the service set is wide', async () => {
    const { ALLOWED_LN_ADDRESS_DOMAINS, ALLOWED_LNURL_SERVICE_HOSTS } = require('../blink/scripts/_blink_client');
    stubFetch((url) => {
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          json: {
            tag: 'payRequest',
            callback: 'https://evil.example/cb',
            minSendable: 1000,
            maxSendable: 1e9,
            metadata: TEST_METADATA,
          },
        };
      }
      return { json: { pr: bolt11(1000 * 1000) } };
    });
    await assert.rejects(
      () =>
        getInvoiceFromLightningAddress('alice@blink.sv', 1000, undefined, {
          allowedAddressDomains: ALLOWED_LN_ADDRESS_DOMAINS,
          allowedHosts: ALLOWED_LNURL_SERVICE_HOSTS,
        }),
      /non-Blink host/,
    );
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
    await assert.rejects(
      () => resolveReceiver('ghost@blink.sv', {}),
      (e) => e.code === 'RECEIVER_NOT_FOUND',
    );
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

  // The headline regression: an INACTIVE custodial account is not payable via
  // the custodial API, but Blink still serves its Lightning address over LNURL.
  // It must fall through to the LNURL branch, not be a hard probe failure.
  it('falls back to lnaddress when the custodial probe reports "Account is inactive"', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) {
        return { json: { errors: [{ message: 'Account is inactive.' }] } };
      }
      return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 1e9 } };
    });
    const r = await resolveReceiver('openoms@blink.sv', {});
    assert.equal(r.type, 'lnaddress');
  });

  // But a transient LNURL service failure after a clean custodial "null" must
  // NOT become a confident RECEIVER_NOT_FOUND either.
  it('propagates a transient LNURL service error instead of RECEIVER_NOT_FOUND', async () => {
    stubFetch((url) => {
      if (url.includes('/graphql')) return { json: { data: { accountDefaultWallet: null } } };
      return { json: { status: 'ERROR', reason: 'temporarily overloaded' } };
    });
    await assert.rejects(
      () => resolveReceiver('yasar@blink.sv', {}),
      (e) => e.code === 'LNURL_SERVICE_ERROR',
    );
  });
});

// ── SSRF guard: assertAllowedUrl / isPrivateAddress ──────────────────────────

describe('isPrivateAddress', () => {
  it('flags private, loopback and link-local IPv4', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
    ]) {
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
        return {
          json: {
            tag: 'payRequest',
            callback: 'https://blink.sv/cb',
            minSendable: 1000,
            maxSendable: 1e9,
            metadata: TEST_METADATA,
          },
        };
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
    assert.ok(!seen.some((u) => u.includes('attacker.example')), 'must not have fetched the redirect target');
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

describe('decodeBolt11', () => {
  it('decodes the multipliers against the BOLT-11 spec', () => {
    // 1 BTC = 1e11 msat. bolt11() builds a real invoice, so each multiplier is
    // exercised through the full bech32 + HRP path.
    assert.equal(decodeBolt11(bolt11(100000000)).amountMsats, 100000000); // 1m  = 1e8 msat
    assert.equal(decodeBolt11(bolt11(100000)).amountMsats, 100000); // 1u  = 1e5 msat
    assert.equal(decodeBolt11(bolt11(100)).amountMsats, 100); // 1n  = 1e2 msat
    assert.equal(decodeBolt11(bolt11(1)).amountMsats, 1); // 10p = 1 msat
  });

  it('reads the network from the prefix', () => {
    assert.equal(decodeBolt11(bolt11(1000, 'bc')).network, 'mainnet');
    assert.equal(decodeBolt11(bolt11(1000, 'tb')).network, 'testnet');
    assert.equal(decodeBolt11(bolt11(1000, 'bcrt')).network, 'regtest');
  });

  it('extracts the description-hash tag', () => {
    assert.equal(decodeBolt11(bolt11(1000)).descriptionHash, TEST_METADATA_HASH);
  });

  it('returns null amount for an amountless invoice', () => {
    assert.equal(decodeBolt11(bolt11(null)).amountMsats, null);
  });

  it('rejects a corrupted checksum', () => {
    const good = bolt11(1000);
    // Flip one data character — the checksum must now fail.
    const pos = good.lastIndexOf('1') + 3;
    const flipped = good.slice(0, pos) + (good[pos] === 'q' ? 'p' : 'q') + good.slice(pos + 1);
    assert.throws(() => decodeBolt11(flipped), /checksum mismatch/);
  });

  it('rejects a synthetic HRP-only string that has no valid checksum', () => {
    // This is the fixture the earlier tests used, and exactly what the binding
    // now exists to refuse.
    assert.throws(() => decodeBolt11('lnbc10u1qqqqqq'), /checksum|bech32|data/);
    assert.throws(() => decodeBolt11('lnbc10u1aaaaaaaa'), /checksum|bech32|data/);
  });

  it('rejects a non-invoice', () => {
    assert.throws(() => decodeBolt11('lnbc10n1p...'), /bech32|invalid data/);
    assert.throws(() => decodeBolt11('http://blink.sv'), /unrecognised prefix|separator/);
    assert.throws(() => decodeBolt11(''), /Empty/);
  });

  it('rejects a sub-millisatoshi amount', () => {
    // Build a real 1p invoice: 1 pico = 0.1 msat is not a whole msat.
    const hrp = 'lnbc1p';
    const pHash = crypto.createHash('sha256').update('p').digest();
    const ts = Math.floor(Date.now() / 1000);
    const tsWords = [];
    for (let w = 6; w >= 0; w--) tsWords.push(Math.floor(ts / Math.pow(32, w)) % 32);
    const words = [
      ...tsWords,
      1,
      (52 >> 5) & 31,
      52 & 31,
      ...bech32.toWords(pHash),
      23,
      (52 >> 5) & 31,
      52 & 31,
      ...bech32.toWords(crypto.createHash('sha256').update(TEST_METADATA, 'utf8').digest()),
      ...new Array(104).fill(0),
    ];
    const inv = bech32.encode(hrp, words, 20000);
    assert.throws(() => decodeBolt11(inv), /sub-millisatoshi/);
  });

  // ── structural validity (payment hash, description, timestamp, expiry) ─────

  it('rejects an invoice with no payment-hash tag', () => {
    const inv = bolt11(1000, 'bc', TEST_METADATA, { omitPaymentHash: true });
    assert.throws(() => decodeBolt11(inv), /missing payment-hash/);
  });

  it('rejects an invoice with both d and h description tags', () => {
    const inv = bolt11(1000, 'bc', TEST_METADATA, { bothDescriptions: true });
    assert.throws(() => decodeBolt11(inv), /both d and h/);
  });

  it('rejects a zero timestamp', () => {
    const inv = bolt11(1000, 'bc', TEST_METADATA, { timestampSeconds: 0 });
    assert.throws(() => decodeBolt11(inv), /zero timestamp/);
  });

  it('rejects an expired invoice', () => {
    const now = Math.floor(Date.now() / 1000);
    const inv = bolt11(1000, 'bc', TEST_METADATA, { timestampSeconds: now - 7200, expirySeconds: 3600 });
    assert.throws(() => decodeBolt11(inv, { nowSeconds: now }), /expired/);
  });

  it('applies the 3600s default expiry when no x tag is present', () => {
    const now = Math.floor(Date.now() / 1000);
    const inv = bolt11(1000, 'bc', TEST_METADATA, { timestampSeconds: now - 7200 }); // no expiry tag
    assert.throws(() => decodeBolt11(inv, { nowSeconds: now }), /expired/);
  });

  it('accepts a current invoice within its expiry window', () => {
    const now = Math.floor(Date.now() / 1000);
    const inv = bolt11(1000, 'bc', TEST_METADATA, { timestampSeconds: now - 60, expirySeconds: 3600 });
    assert.doesNotThrow(() => decodeBolt11(inv, { nowSeconds: now }));
  });

  it('exposes the payment hash and timestamp', () => {
    const d = decodeBolt11(bolt11(1000));
    assert.match(d.paymentHash, /^[0-9a-f]{64}$/);
    assert.ok(d.timestampSeconds > 0);
    assert.equal(d.expirySeconds, 3600);
  });

  // ── payment-secret (s) tag and signature recovery id (BOLT #11 reader rules) ──

  it('rejects an invoice with no payment-secret (s) tag', () => {
    const inv = bolt11(1000, 'bc', TEST_METADATA, { omitPaymentSecret: true });
    assert.throws(() => decodeBolt11(inv), /missing payment-secret/);
  });

  it('accepts the in-range recovery ids 0 and 3', () => {
    for (const rid of [0, 3]) {
      const inv = bolt11(1000, 'bc', TEST_METADATA, { recoveryByte: rid });
      assert.equal(decodeBolt11(inv).recoveryId, rid);
    }
  });

  it('rejects out-of-range recovery ids 4 and 255', () => {
    for (const rid of [4, 255]) {
      const inv = bolt11(1000, 'bc', TEST_METADATA, { recoveryByte: rid });
      assert.throws(() => decodeBolt11(inv), /recovery id .* out of range/);
    }
  });

  it('rejects a duplicate payment-secret tag', () => {
    // Build manually: two s tags.
    const sHash = crypto.createHash('sha256').update('secret:x').digest();
    const sWords = bech32.toWords(sHash);
    const pHash = crypto.createHash('sha256').update('payment:x').digest();
    const hHash = crypto.createHash('sha256').update(TEST_METADATA, 'utf8').digest();
    const ts = Math.floor(Date.now() / 1000);
    const tsWords = [];
    for (let w = 6; w >= 0; w--) tsWords.push(Math.floor(ts / Math.pow(32, w)) % 32);
    const words = [
      ...tsWords,
      1,
      (52 >> 5) & 31,
      52 & 31,
      ...bech32.toWords(pHash),
      16,
      (52 >> 5) & 31,
      52 & 31,
      ...sWords,
      16,
      (52 >> 5) & 31,
      52 & 31,
      ...sWords, // duplicate s
      23,
      (52 >> 5) & 31,
      52 & 31,
      ...bech32.toWords(hHash),
      ...new Array(104).fill(0),
    ];
    const inv = bech32.encode('lnbc10n', words, 20000);
    assert.throws(() => decodeBolt11(inv), /duplicate tag type 16/);
  });
});

describe('assertInvoiceMatches', () => {
  it('accepts an exact match', () => {
    assert.equal(assertInvoiceMatches(bolt11(1000000), { amountMsats: 1000000 }).amountMsats, 1000000);
  });

  it('accepts when the description hash matches the LUD-06 metadata', () => {
    const inv = bolt11(1000000, 'bc', TEST_METADATA);
    assert.doesNotThrow(() => assertInvoiceMatches(inv, { amountMsats: 1000000, metadata: TEST_METADATA }));
  });

  it('rejects when the description hash does NOT match the metadata', () => {
    const inv = bolt11(1000000, 'bc', TEST_METADATA);
    assert.throws(
      () => assertInvoiceMatches(inv, { amountMsats: 1000000, metadata: '[["text/plain","different"]]' }),
      /description hash does not match/,
    );
  });

  it('rejects an invoice with no description-hash tag when metadata is required', () => {
    // Valid payment hash + timestamp, but no `h` and no `d` either.
    const inv = bolt11(1000000, 'bc', TEST_METADATA, { omitDescription: true });
    assert.throws(
      () => assertInvoiceMatches(inv, { amountMsats: 1000000, metadata: TEST_METADATA }),
      /no description or description-hash/,
    );
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
