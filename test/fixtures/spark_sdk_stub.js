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

const fakeSdk = {
  async getInfo() {
    return { balanceSats: balance };
  },
  async listPayments(req) {
    if (echo) console.error(`STUB_LIMIT=${req && req.limit}`);
    return payments;
  },
  async parse(input) {
    if (echo) console.error(`STUB_DESTINATION=${input}`);
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
    return { payment: { id: 'bolt-1', status } };
  },
  async addEventListener(l) {
    setImmediate(() => l.onEvent({ type: 'synced' }));
    return 'listener-1';
  },
  async removeEventListener() {},
};

const stub = {
  SPARK_PACKAGE: '@breeztech/breez-sdk-spark',
  DEFAULT_NETWORK: 'mainnet',
  async connect({ network } = {}) {
    if (echo) console.error(`STUB_NETWORK=${network}`);
    return { sdk: fakeSdk, disconnect: async () => {} };
  },
  normalizeInfo: (info) => ({ balanceSats: Number(info && info.balanceSats) || 0 }),
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
