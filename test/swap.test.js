/**
 * Tests for swap functionality: _swap_common.js, swap_quote.js, swap_execute.js.
 *
 * Mocks global `fetch` to intercept GraphQL calls without hitting the network.
 * Run: node --test test/swap.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Shared test infrastructure ───────────────────────────────────────────────

const clientPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_blink_client.js');
const swapCommonPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_swap_common.js');
const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');

/**
 * Require a script fresh (bust require cache chain) so each test starts clean.
 */
function freshRequire(scriptName) {
  delete require.cache[require.resolve(clientPath)];
  delete require.cache[require.resolve(swapCommonPath)];
  const scriptPath = path.join(scriptsDir, scriptName);
  delete require.cache[require.resolve(scriptPath)];
  return require(scriptPath);
}

/**
 * Require _swap_common.js fresh.
 */
function freshRequireSwapCommon() {
  delete require.cache[require.resolve(clientPath)];
  delete require.cache[require.resolve(swapCommonPath)];
  return require(swapCommonPath);
}

/**
 * Create a mock fetch that dispatches on GraphQL operation content.
 * @param {object} handlers - Map of query substring → response data
 */
function createMockFetch(handlers) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    for (const [key, data] of Object.entries(handlers)) {
      if (body.query.includes(key)) {
        return {
          ok: true,
          json: async () => ({ data }),
          text: async () => JSON.stringify({ data }),
        };
      }
    }
    throw new Error(`Unhandled GraphQL query: ${body.query.slice(0, 80)}`);
  };
}

/**
 * Set up the test environment: mock env vars, suppress console, capture stdout.
 */
function setupTestEnv() {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalStdout = console.log;
  const originalStderr = console.error;
  const originalFetch = global.fetch;

  process.env.BLINK_API_KEY = 'blink_test_key_123';
  process.env.BLINK_API_URL = 'https://api.test.blink.sv/graphql';

  let stdoutLines = [];
  let stderrLines = [];

  console.log = (...args) => {
    stdoutLines.push(args.join(' '));
  };
  console.error = (...args) => {
    stderrLines.push(args.join(' '));
  };

  return {
    getStdout: () => stdoutLines.join('\n'),
    getStdoutJson: () => JSON.parse(stdoutLines.join('\n')),
    getStderr: () => stderrLines.join('\n'),
    setFetch: (mockFn) => {
      global.fetch = mockFn;
    },
    restore: () => {
      process.env = originalEnv;
      process.argv = originalArgv;
      console.log = originalStdout;
      console.error = originalStderr;
      global.fetch = originalFetch;
    },
  };
}

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_WALLETS_DATA = {
  me: {
    defaultAccount: {
      wallets: [
        { id: 'btc-wallet-id', walletCurrency: 'BTC', balance: 50000, pendingIncomingBalance: 0 },
        { id: 'usd-wallet-id', walletCurrency: 'USD', balance: 1500, pendingIncomingBalance: 0 },
      ],
    },
  },
};

const POST_SWAP_BTC_TO_USD_WALLETS = {
  me: {
    defaultAccount: {
      wallets: [
        { id: 'btc-wallet-id', walletCurrency: 'BTC', balance: 48000, pendingIncomingBalance: 0 },
        { id: 'usd-wallet-id', walletCurrency: 'USD', balance: 1636, pendingIncomingBalance: 0 },
      ],
    },
  },
};

const MOCK_CONVERSION_DATA = {
  currencyConversionEstimation: {
    btcSatAmount: 1470,
    usdCentAmount: 100,
  },
};

// ── _swap_common unit tests ──────────────────────────────────────────────────

describe('_swap_common: normalizeDirection', () => {
  it('normalizes btc-to-usd', () => {
    const { normalizeDirection, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('btc-to-usd'), DIRECTION_BTC_TO_USD);
  });

  it('normalizes sell-btc alias', () => {
    const { normalizeDirection, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('sell-btc'), DIRECTION_BTC_TO_USD);
  });

  it('normalizes buy-usd alias', () => {
    const { normalizeDirection, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('buy-usd'), DIRECTION_BTC_TO_USD);
  });

  it('normalizes usd-to-btc', () => {
    const { normalizeDirection, DIRECTION_USD_TO_BTC } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('usd-to-btc'), DIRECTION_USD_TO_BTC);
  });

  it('normalizes sell-usd alias', () => {
    const { normalizeDirection, DIRECTION_USD_TO_BTC } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('sell-usd'), DIRECTION_USD_TO_BTC);
  });

  it('normalizes buy-btc alias', () => {
    const { normalizeDirection, DIRECTION_USD_TO_BTC } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('buy-btc'), DIRECTION_USD_TO_BTC);
  });

  it('handles underscore format', () => {
    const { normalizeDirection, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('btc_to_usd'), DIRECTION_BTC_TO_USD);
  });

  it('returns null for invalid direction', () => {
    const { normalizeDirection } = freshRequireSwapCommon();
    assert.equal(normalizeDirection('invalid'), null);
  });

  it('returns null for null input', () => {
    const { normalizeDirection } = freshRequireSwapCommon();
    assert.equal(normalizeDirection(null), null);
  });
});

describe('_swap_common: parseUnit', () => {
  it('normalizes sats variants', () => {
    const { parseUnit } = freshRequireSwapCommon();
    assert.equal(parseUnit('sat'), 'sats');
    assert.equal(parseUnit('sats'), 'sats');
    assert.equal(parseUnit('satoshi'), 'sats');
  });

  it('normalizes cents variants', () => {
    const { parseUnit } = freshRequireSwapCommon();
    assert.equal(parseUnit('cent'), 'cents');
    assert.equal(parseUnit('cents'), 'cents');
    assert.equal(parseUnit('usd-cents'), 'cents');
  });

  it('returns null for invalid unit', () => {
    const { parseUnit } = freshRequireSwapCommon();
    assert.equal(parseUnit('btc'), null);
    assert.equal(parseUnit(null), null);
  });
});

describe('_swap_common: defaultUnitForDirection', () => {
  it('defaults to sats for BTC_TO_USD', () => {
    const { defaultUnitForDirection, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    assert.equal(defaultUnitForDirection(DIRECTION_BTC_TO_USD), 'sats');
  });

  it('defaults to cents for USD_TO_BTC', () => {
    const { defaultUnitForDirection, DIRECTION_USD_TO_BTC } = freshRequireSwapCommon();
    assert.equal(defaultUnitForDirection(DIRECTION_USD_TO_BTC), 'cents');
  });
});

describe('_swap_common: parsePositiveInt', () => {
  it('parses valid positive integers', () => {
    const { parsePositiveInt } = freshRequireSwapCommon();
    assert.equal(parsePositiveInt('42', 'test'), 42);
    assert.equal(parsePositiveInt('1', 'test'), 1);
  });

  it('throws for zero', () => {
    const { parsePositiveInt } = freshRequireSwapCommon();
    assert.throws(() => parsePositiveInt('0', 'amount'), /amount must be a positive integer/);
  });

  it('throws for negative', () => {
    const { parsePositiveInt } = freshRequireSwapCommon();
    assert.throws(() => parsePositiveInt('-5', 'amount'), /amount must be a positive integer/);
  });

  it('throws for non-numeric', () => {
    const { parsePositiveInt } = freshRequireSwapCommon();
    assert.throws(() => parsePositiveInt('abc', 'amount'), /amount must be a positive integer/);
  });
});

describe('_swap_common: parseCommonSwapArgs', () => {
  it('parses minimal valid args', () => {
    const { parseCommonSwapArgs, DIRECTION_BTC_TO_USD } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs(['btc-to-usd', '1000']);
    assert.equal(result.direction, DIRECTION_BTC_TO_USD);
    assert.equal(result.amount, 1000);
    assert.equal(result.unit, 'sats');
    assert.equal(result.dryRun, false);
    assert.equal(result.memo, null);
    assert.equal(result.ttlSeconds, 60);
  });

  it('parses all flags', () => {
    const { parseCommonSwapArgs, DIRECTION_USD_TO_BTC } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs([
      'usd-to-btc',
      '500',
      '--unit',
      'cents',
      '--ttl-seconds',
      '120',
      '--immediate',
      '--dry-run',
      '--memo',
      'test memo',
    ]);
    assert.equal(result.direction, DIRECTION_USD_TO_BTC);
    assert.equal(result.amount, 500);
    assert.equal(result.unit, 'cents');
    assert.equal(result.ttlSeconds, 120);
    assert.equal(result.immediateExecution, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.memo, 'test memo');
  });

  it('returns error for too few args', () => {
    const { parseCommonSwapArgs } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs(['btc-to-usd']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Usage'));
  });

  it('returns error for invalid direction', () => {
    const { parseCommonSwapArgs } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs(['invalid', '1000']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Invalid direction'));
  });

  it('returns error for unknown argument', () => {
    const { parseCommonSwapArgs } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs(['btc-to-usd', '1000', '--unknown']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown argument'));
  });

  it('returns error for invalid unit', () => {
    const { parseCommonSwapArgs } = freshRequireSwapCommon();
    const result = parseCommonSwapArgs(['btc-to-usd', '1000', '--unit', 'btc']);
    assert.ok(result.error);
    assert.ok(result.error.includes('Invalid --unit'));
  });
});

describe('_swap_common: walletSnapshot', () => {
  it('builds correct snapshot object', () => {
    const { walletSnapshot } = freshRequireSwapCommon();
    const btcWallet = { id: 'btc-id', balance: 50000 };
    const usdWallet = { id: 'usd-id', balance: 1500 };
    const snapshot = walletSnapshot(btcWallet, usdWallet);
    assert.equal(snapshot.btcWalletId, 'btc-id');
    assert.equal(snapshot.usdWalletId, 'usd-id');
    assert.equal(snapshot.btcBalanceSats, 50000);
    assert.equal(snapshot.usdBalanceCents, 1500);
    assert.equal(snapshot.usdBalanceFormatted, '$15.00');
  });
});

describe('_swap_common: computeBalanceDelta', () => {
  it('computes correct deltas', () => {
    const { computeBalanceDelta } = freshRequireSwapCommon();
    const pre = { btcBalanceSats: 50000, usdBalanceCents: 1500 };
    const post = { btcBalanceSats: 48000, usdBalanceCents: 1636 };
    const delta = computeBalanceDelta(pre, post);
    assert.equal(delta.btcDeltaSats, -2000);
    assert.equal(delta.usdDeltaCents, 136);
  });

  it('returns zero deltas for identical balances', () => {
    const { computeBalanceDelta } = freshRequireSwapCommon();
    const snap = { btcBalanceSats: 50000, usdBalanceCents: 1500 };
    const delta = computeBalanceDelta(snap, snap);
    assert.equal(delta.btcDeltaSats, 0);
    assert.equal(delta.usdDeltaCents, 0);
  });
});

// ── swap_quote command tests ─────────────────────────────────────────────────

describe('swap_quote', () => {
  let env;

  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => {
    env.restore();
  });

  it('returns a quote JSON with correct structure', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'btc-to-usd', '1000'];
    const { main } = freshRequire('swap_quote.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.event, 'swap_quote');
    assert.equal(output.dryRun, true);
    assert.equal(output.direction, 'BTC_TO_USD');
    assert.ok(output.preBalance);
    assert.ok(output.quote);
    assert.equal(output.quote.direction, 'BTC_TO_USD');
    assert.equal(output.quote.requestedAmount.value, 1000);
    assert.equal(output.quote.requestedAmount.unit, 'sats');
    assert.equal(output.quote.amountIn.unit, 'sats');
    assert.equal(output.quote.amountOut.unit, 'cents');
    assert.equal(output.quote.feeSats, 0);
    assert.ok(output.quote.quoteId);
    assert.ok(output.generatedAtEpochSeconds);
  });

  it('USD-to-BTC quote uses cents as default unit', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'usd-to-btc', '500'];
    const { main } = freshRequire('swap_quote.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.direction, 'USD_TO_BTC');
    assert.equal(output.quote.requestedAmount.unit, 'cents');
    assert.equal(output.quote.amountIn.unit, 'cents');
    assert.equal(output.quote.amountOut.unit, 'sats');
  });

  it('includes pre-balance snapshot', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'btc-to-usd', '1000'];
    const { main } = freshRequire('swap_quote.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.preBalance.btcWalletId, 'btc-wallet-id');
    assert.equal(output.preBalance.usdWalletId, 'usd-wallet-id');
    assert.equal(output.preBalance.btcBalanceSats, 50000);
    assert.equal(output.preBalance.usdBalanceCents, 1500);
  });

  it('includes execution path in quote', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'btc-to-usd', '1000'];
    const { main } = freshRequire('swap_quote.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.quote.executionPath, 'blink:intraLedgerPaymentSend');
  });

  it('USD-to-BTC uses intraLedgerUsdPaymentSend path', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'usd-to-btc', '500'];
    const { main } = freshRequire('swap_quote.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.quote.executionPath, 'blink:intraLedgerUsdPaymentSend');
  });
});

// ── swap_execute command tests ───────────────────────────────────────────────

describe('swap_execute', () => {
  let env;

  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => {
    env.restore();
  });

  it('--dry-run outputs JSON with dryRun: true and does not send mutation', async () => {
    let mutationCalled = false;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('CurrencyConversion')) {
        return { ok: true, json: async () => ({ data: MOCK_CONVERSION_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('IntraLedger')) {
        mutationCalled = true;
        return { ok: true, json: async () => ({ data: {} }), text: async () => '{}' };
      }
      throw new Error(`Unexpected query: ${body.query.slice(0, 60)}`);
    };

    process.argv = ['node', 'blink', 'btc-to-usd', '2000', '--dry-run'];
    const { main } = freshRequire('swap_execute.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.event, 'swap_execution');
    assert.equal(output.dryRun, true);
    assert.equal(output.status, 'DRY_RUN');
    assert.equal(output.succeeded, false);
    assert.equal(output.execution.transactionId, null);
    assert.equal(mutationCalled, false, 'Mutation should not be called during dry-run');
  });

  it('--dry-run shows zero balance delta', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        CurrencyConversion: MOCK_CONVERSION_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'btc-to-usd', '2000', '--dry-run'];
    const { main } = freshRequire('swap_execute.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.balanceDelta.btcDeltaSats, 0);
    assert.equal(output.balanceDelta.usdDeltaCents, 0);
  });

  it('successful BTC-to-USD swap returns correct output', async () => {
    // Track call sequence: first wallet fetch is for quote, second is for execute pre-balance,
    // third is for post-balance refresh
    let walletCallCount = 0;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        walletCallCount++;
        // Return post-swap balances on the third wallet call (post-execution refresh)
        if (walletCallCount >= 3) {
          return { ok: true, json: async () => ({ data: POST_SWAP_BTC_TO_USD_WALLETS }), text: async () => '{}' };
        }
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('CurrencyConversion')) {
        return { ok: true, json: async () => ({ data: MOCK_CONVERSION_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('IntraLedgerPaymentSend')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              intraLedgerPaymentSend: {
                status: 'SUCCESS',
                errors: [],
                transaction: { id: 'tx_swap_123' },
              },
            },
          }),
          text: async () => '{}',
        };
      }
      throw new Error(`Unexpected query: ${body.query.slice(0, 60)}`);
    };

    process.argv = ['node', 'blink', 'btc-to-usd', '2000'];
    const { main } = freshRequire('swap_execute.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.event, 'swap_execution');
    assert.equal(output.dryRun, false);
    assert.equal(output.direction, 'BTC_TO_USD');
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.succeeded, true);
    assert.equal(output.execution.transactionId, 'tx_swap_123');
    assert.equal(output.execution.path, 'blink:intraLedgerPaymentSend');
  });

  it('successful USD-to-BTC swap uses correct mutation', async () => {
    let usedMutation = null;
    let walletCallCount = 0;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        walletCallCount++;
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('CurrencyConversion')) {
        return { ok: true, json: async () => ({ data: MOCK_CONVERSION_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('IntraLedgerUsdPaymentSend')) {
        usedMutation = 'IntraLedgerUsdPaymentSend';
        return {
          ok: true,
          json: async () => ({
            data: {
              intraLedgerUsdPaymentSend: {
                status: 'SUCCESS',
                errors: [],
                transaction: { id: 'tx_swap_456' },
              },
            },
          }),
          text: async () => '{}',
        };
      }
      if (body.query.includes('IntraLedgerPaymentSend')) {
        usedMutation = 'IntraLedgerPaymentSend';
        return {
          ok: true,
          json: async () => ({
            data: {
              intraLedgerPaymentSend: {
                status: 'SUCCESS',
                errors: [],
                transaction: { id: 'tx_swap_456' },
              },
            },
          }),
          text: async () => '{}',
        };
      }
      throw new Error(`Unexpected query: ${body.query.slice(0, 60)}`);
    };

    process.argv = ['node', 'blink', 'usd-to-btc', '500'];
    const { main } = freshRequire('swap_execute.js');
    await main();

    assert.equal(usedMutation, 'IntraLedgerUsdPaymentSend');
    const output = env.getStdoutJson();
    assert.equal(output.direction, 'USD_TO_BTC');
    assert.equal(output.execution.path, 'blink:intraLedgerUsdPaymentSend');
  });

  it('swap failure throws error with message', async () => {
    let walletCallCount = 0;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        walletCallCount++;
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('CurrencyConversion')) {
        return { ok: true, json: async () => ({ data: MOCK_CONVERSION_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('IntraLedgerPaymentSend')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              intraLedgerPaymentSend: {
                status: 'FAILURE',
                errors: [{ message: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' }],
                transaction: null,
              },
            },
          }),
          text: async () => '{}',
        };
      }
      throw new Error(`Unexpected query: ${body.query.slice(0, 60)}`);
    };

    process.argv = ['node', 'blink', 'btc-to-usd', '999999'];
    const { main } = freshRequire('swap_execute.js');
    await assert.rejects(main, /Swap failed.*Insufficient balance/);
  });

  it('includes memo in execution output', async () => {
    let walletCallCount = 0;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        walletCallCount++;
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('CurrencyConversion')) {
        return { ok: true, json: async () => ({ data: MOCK_CONVERSION_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('IntraLedgerPaymentSend')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              intraLedgerPaymentSend: {
                status: 'SUCCESS',
                errors: [],
                transaction: { id: 'tx_memo_123' },
              },
            },
          }),
          text: async () => '{}',
        };
      }
      throw new Error(`Unexpected query: ${body.query.slice(0, 60)}`);
    };

    process.argv = ['node', 'blink', 'btc-to-usd', '1000', '--memo', 'Monthly DCA'];
    const { main } = freshRequire('swap_execute.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.execution.memo, 'Monthly DCA');
  });
});
