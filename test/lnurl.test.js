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
} = require('../blink/scripts/_lnurl');

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
    return {
      ok: spec.status ? spec.status >= 200 && spec.status < 300 : true,
      status: spec.status || 200,
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
    stubFetch(() => ({ json: { pr: 'lnbc10n1p...', verify: 'https://blink.sv/verify/abc' } }));
    const inv = await requestInvoiceFromCallback('https://blink.sv/cb', 1000000, 'hi');
    assert.equal(inv.paymentRequest, 'lnbc10n1p...');
    assert.equal(inv.verify, 'https://blink.sv/verify/abc');
  });

  it('tolerates a missing verify (custodial)', async () => {
    stubFetch(() => ({ json: { pr: 'lnbc10n1p...' } }));
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
    stubFetch((url) => {
      if (url.includes('/.well-known/lnurlp/')) {
        return { json: { tag: 'payRequest', callback: 'https://blink.sv/cb', minSendable: 1000, maxSendable: 100000000, commentAllowed: 0 } };
      }
      return { json: { pr: 'lnbc10n1p...', verify: 'https://blink.sv/verify/abc' } };
    });
    const inv = await getInvoiceFromLightningAddress('alice@blink.sv', 1000);
    assert.equal(inv.paymentRequest, 'lnbc10n1p...');
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
});
