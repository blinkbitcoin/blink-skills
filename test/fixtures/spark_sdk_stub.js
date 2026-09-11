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
  stubTokenBalances = new Map(
    Object.entries(parsed).map(([k, v]) => [
      k,
      {
        balance: BigInt(v.balance),
        tokenMetadata: {
          identifier: k,
          name: v.name || 'Token',
          ticker: v.ticker || 'TKN',
          decimals: v.decimals === undefined ? 6 : v.decimals,
          issuerPublicKey: '02ffff',
        },
      },
    ]),
  );
}

const fakeSdk = {
  async getInfo() {
    const info = { balanceSats: balance };
    if (stubTokenBalances) info.tokenBalances = stubTokenBalances;
    return info;
  },
  async getTokensMetadata(req) {
    const ids = (req && req.tokenIdentifiers) || [];
    return {
      tokensMetadata: ids.map((id) => ({
        identifier: id,
        issuerPublicKey: '02ffff',
        name: 'Stub Dollar',
        ticker: 'USDB',
        decimals: 6,
        maxSupply: '1000000000000',
        isFreezable: false,
      })),
    };
  },
  async receivePayment(req) {
    const method = req && req.paymentMethod;
    if (!method || method.type !== 'sparkInvoice') throw new Error('stub: only sparkInvoice receive is supported');
    return { paymentRequest: `sprtstub1${method.amount || 0}${method.tokenIdentifier || ''}`, fee: 0n };
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
    if (String(input).startsWith('sprt'))
      return {
        type: 'sparkAddress',
        address: String(input),
        identityPublicKey: '02ffff',
        network: 'MAINNET',
        source: {},
      };
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
    if (echo && req.tokenIdentifier) console.error(`STUB_TOKEN=${req.tokenIdentifier}`);
    if (echo && req.conversionOptions) {
      console.error(`STUB_CONV=${req.conversionOptions.conversionType.type}`);
    }
    // Token-mode prepare: mirror the SDK's token send methods. When
    // conversionOptions are present, include a deterministic estimate
    // (amountIn = source asset, amountOut = target asset, fee = 0).
    if (req.tokenIdentifier || req.conversionOptions) {
      const isToBitcoin = req.conversionOptions && req.conversionOptions.conversionType.type === 'toBitcoin';
      const response = {
        paymentMethod: { type: 'sparkAddress', address: 'sprt1stub', fee: '0', tokenIdentifier: req.tokenIdentifier },
        // For a toBitcoin conversion no amount is passed, so the invoice's
        // amount is authoritative — the stub uses a fixed 45000-sat invoice.
        amount: isToBitcoin ? 45000n : req.amount || 0n,
        feePolicy: { type: 'simple' },
      };
      if (req.tokenIdentifier) response.tokenIdentifier = req.tokenIdentifier;
      if (req.conversionOptions) {
        response.conversionEstimate = {
          options: req.conversionOptions,
          amountIn: req.conversionOptions.conversionType.type === 'fromBitcoin' ? 50000n : 1000000n,
          amountOut: req.conversionOptions.conversionType.type === 'fromBitcoin' ? 1000000n : 45000n,
          fee: 0n,
        };
      }
      return response;
    }
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

// Mirrors of the production _spark_sdk token helpers — the stub replaces
// _spark_sdk, so every command-imported export must exist here. Standalone
// (not methods): commands destructure these, losing `this`.
const USDB_TOKEN_MAINNET = 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87';
function resolveTokenIdentifier(token, network) {
  if (token !== 'usdb') return token;
  const fromEnv = process.env.SPARK_USDB_TOKEN;
  if (fromEnv) return fromEnv;
  if (network !== 'mainnet') {
    throw new Error(
      "The 'usdb' alias has no known identifier on this network — set SPARK_USDB_TOKEN or pass the token identifier explicitly with --token.",
    );
  }
  return USDB_TOKEN_MAINNET;
}
function parseTokenAmount(input, decimals) {
  const m = String(input)
    .trim()
    .match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`Invalid token amount '${input}' — expected a non-negative decimal like 10.5`);
  const frac = m[2] || '';
  if (frac.length > decimals) {
    throw new Error(`Amount '${input}' has more than ${decimals} decimal places for this token`);
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(m[1] + padded);
}
function formatTokenAmount(units, decimals) {
  const n = BigInt(units);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? '.' + frac : ''}`;
}
function normalizeTokenBalances(tokenBalances) {
  if (!tokenBalances || typeof tokenBalances[Symbol.iterator] !== 'function') return {};
  const out = {};
  for (const [id, tb] of tokenBalances) {
    const meta = tb && tb.tokenMetadata ? tb.tokenMetadata : {};
    out[String(id)] = {
      balance: String(tb.balance),
      decimals: meta.decimals,
      name: meta.name,
      ticker: meta.ticker,
      issuerPublicKey: meta.issuerPublicKey,
      balanceFormatted: formatTokenAmount(tb.balance, meta.decimals || 0),
    };
  }
  return out;
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
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    if (!has(prepareResponse)) return null;
    if (has(prepareResponse.feeSats)) return num(prepareResponse.feeSats);
    const pm = prepareResponse.paymentMethod;
    if (!pm) return null;
    if (has(pm.feeSats)) return num(pm.feeSats);
    if (has(pm.lightningFeeSats)) {
      // A composite with one non-finite PRESENT component is an unknowable total.
      const fee = num(pm.lightningFeeSats);
      if (fee === null) return null;
      if (has(pm.sparkTransferFeeSats)) {
        const transfer = num(pm.sparkTransferFeeSats);
        if (transfer === null) return null;
        return fee + transfer;
      }
      return fee;
    }
    if (has(pm.sparkTransferFeeSats)) return num(pm.sparkTransferFeeSats);
    if (has(pm.fee)) return num(pm.fee);
    return null;
  },
  safeErrorDetail(value) {
    try {
      return value && typeof value.message === 'string' ? value.message : String(value);
    } catch {
      return '(non-coercible error value)';
    }
  },
  // Mirrors of the production token helpers (standalone functions — see the
  // normalizeSdkValue note about destructuring and `this`).
  USDB_TOKEN_MAINNET,
  resolveTokenIdentifier,
  parseTokenAmount,
  formatTokenAmount,
  normalizeTokenBalances,
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
