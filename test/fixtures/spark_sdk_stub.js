/**
 * Preload stub for CLI-level Spark tests.
 *
 * Loaded with `node --require`, this intercepts `require()` of
 * `blink/scripts/_spark_sdk` so the real Breez SDK is never touched. It lets a
 * test spawn the ACTUAL `bin/blink.js` binary — exercising real command
 * registration, option parsing and argv forwarding — while stopping short of
 * the network and the native dependency.
 *
 * The fake SDK's behaviour is driven by env vars so the parent test can vary it
 * without writing a new fixture each time:
 *
 *   SPARK_STUB_BALANCE   balance in sats returned by getInfo()   (default 1234)
 *   SPARK_STUB_PAYMENTS  JSON array returned by listPayments()   (default [])
 *   SPARK_STUB_STATUS    payment status for send                 (default COMPLETED)
 *   SPARK_STUB_ECHO      when "1", print the argv/limit the script received
 */

const Module = require('node:module');
const path = require('node:path');

const target = path.resolve(__dirname, '..', '..', 'blink', 'scripts', '_spark_sdk.js');

const balance = Number(process.env.SPARK_STUB_BALANCE || 1234);
const payments = JSON.parse(process.env.SPARK_STUB_PAYMENTS || '[]');
const status = process.env.SPARK_STUB_STATUS || 'COMPLETED';
const echo = process.env.SPARK_STUB_ECHO === '1';

// Optional non-empty tokenBalances, mirroring the pinned SDK's
// Map<string, TokenBalance> shape (with BigInt balances), so spark-info
// tests exercise the Map normalization path.
//   SPARK_STUB_TOKEN_BALANCES='{"token-id-1": {"balance": 5000}}'
let stubTokenBalances = null;
if (process.env.SPARK_STUB_TOKEN_BALANCES) {
  const parsed = JSON.parse(process.env.SPARK_STUB_TOKEN_BALANCES);
  stubTokenBalances = new Map(Object.entries(parsed).map(([k, v]) => [k, { ...v, balance: BigInt(v.balance) }]));
}

const fakeSdk = {
  async getInfo() {
    const info = { balanceSats: balance };
    if (stubTokenBalances) info.tokenBalances = stubTokenBalances;
    return info;
  },
  async listPayments(req) {
    if (echo) console.error(`STUB_LIMIT=${req && req.limit} STUB_OFFSET=${req && req.offset}`);
    if (echo && req && req.typeFilter) console.error(`STUB_TYPEFILTER=${req.typeFilter.join(',')}`);
    return payments;
  },
  async parse(input) {
    if (echo) console.error(`STUB_DESTINATION=${input}`);
    // SPARK_STUB_PARSE_TYPE forces a parse result type so tests can exercise
    // unsupported destinations (e.g. bitcoinAddress) and the sparkAddress path.
    const forced = process.env.SPARK_STUB_PARSE_TYPE;
    if (forced) return { type: forced };
    return input.includes('@') ? { type: 'lnUrlPay', callback: 'https://blink.sv/cb' } : { type: 'bolt11Invoice' };
  },
  async prepareLnurlPay(req) {
    if (echo) console.error(`STUB_AMOUNT=${req.amount}`);
    return { feeSats: 2 };
  },
  async lnurlPay() {
    return { payment: { id: 'ln-1', status } };
  },
  async prepareSendPayment(req) {
    if (echo) console.error(`STUB_AMOUNT=${req.amount}`);
    return { paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 3 } };
  },
  async sendPayment() {
    return {
      payment: {
        id: 'spark-1',
        status,
        fees: 0,
        details: {
          type: 'lightning',
          htlcDetails: { paymentHash: 'd'.repeat(64), preimage: 'f'.repeat(64), status: 'preimageShared' },
        },
      },
    };
  },
  async addEventListener(l) {
    setImmediate(() => l.onEvent({ type: 'synced' }));
    return 'listener-1';
  },
  async removeEventListener() {},
};

// Mirror of the real _spark_sdk.normalizeSdkValue — spark-info output
// behavior (Map conversion, bigint stringification) is asserted against it.
// Standalone (not a method): spark-info destructures it, losing `this`.
function normalizeSdkValue(value) {
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  const MIN_SAFE = BigInt(-Number.MAX_SAFE_INTEGER);
  if (typeof value === 'bigint') {
    return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = normalizeSdkValue(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(normalizeSdkValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeSdkValue(v);
    return out;
  }
  return value;
}

const stub = {
  SPARK_PACKAGE: '@breeztech/breez-sdk-spark',
  DEFAULT_NETWORK: 'mainnet',
  async connect({ network } = {}) {
    if (echo) console.error(`STUB_NETWORK=${network}`);
    return { sdk: fakeSdk, disconnect: async () => {} };
  },
  // Mirror of the real _spark_sdk.feeFromPrepare — spark_send now imports it
  // from _spark_sdk, which this stub replaces.
  feeFromPrepare(prepareResponse) {
    const has = (v) => v !== null && v !== undefined;
    if (!has(prepareResponse)) return null;
    if (has(prepareResponse.feeSats)) return Number(prepareResponse.feeSats);
    const pm = prepareResponse.paymentMethod;
    if (!pm) return null;
    if (has(pm.feeSats)) return Number(pm.feeSats);
    if (has(pm.lightningFeeSats)) {
      return Number(pm.lightningFeeSats) + (has(pm.sparkTransferFeeSats) ? Number(pm.sparkTransferFeeSats) : 0);
    }
    if (has(pm.sparkTransferFeeSats)) return Number(pm.sparkTransferFeeSats);
    if (has(pm.fee)) {
      const n = Number(pm.fee);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  },
  normalizeInfo: (info) => ({ balanceSats: Number(info && info.balanceSats) || 0 }),
  normalizeSdkValue,
  async waitForStableBalance(sdk) {
    const info = await sdk.getInfo({ ensureSynced: true });
    return { balanceSats: Number(info.balanceSats), stable: true };
  },
  normalizePayment: (p) => ({
    id: p.id || null,
    type: p.paymentType || null,
    status: p.status || null,
    amountSats: p.amount === undefined ? null : Number(p.amount),
    feeSats: p.fees === undefined ? null : Number(p.fees),
    timestamp: p.timestamp === undefined ? null : Number(p.timestamp),
  }),
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && request.includes('_spark_sdk')) {
    try {
      if (Module._resolveFilename(request, parent) === target) return stub;
    } catch {
      // fall through to the real loader
    }
  }
  return realLoad.call(this, request, parent, isMain);
};
