/**
 * Command-level tests for payment scripts.
 *
 * Mocks global `fetch` to intercept GraphQL calls without hitting the network.
 * Run: node --test test/commands.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Shared test infrastructure ───────────────────────────────────────────────

const clientPath = path.resolve(__dirname, '..', 'blink', 'scripts', '_blink_client.js');
const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');

/**
 * Require a script fresh (bust require cache chain) so each test starts clean.
 */
function freshRequire(scriptName) {
  // Bust the client and the script so they re-bind
  delete require.cache[require.resolve(clientPath)];
  const scriptPath = path.join(scriptsDir, scriptName);
  delete require.cache[require.resolve(scriptPath)];
  return require(scriptPath);
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

const EMPTY_BTC_WALLETS_DATA = {
  me: {
    defaultAccount: {
      wallets: [
        { id: 'btc-wallet-id', walletCurrency: 'BTC', balance: 0, pendingIncomingBalance: 0 },
        { id: 'usd-wallet-id', walletCurrency: 'USD', balance: 0, pendingIncomingBalance: 0 },
      ],
    },
  },
};

const LOW_BTC_WALLETS_DATA = {
  me: {
    defaultAccount: {
      wallets: [
        { id: 'btc-wallet-id', walletCurrency: 'BTC', balance: 500, pendingIncomingBalance: 0 },
        { id: 'usd-wallet-id', walletCurrency: 'USD', balance: 1500, pendingIncomingBalance: 0 },
      ],
    },
  },
};

// ── pay_invoice tests ────────────────────────────────────────────────────────

describe('pay_invoice', () => {
  let env;

  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => {
    env.restore();
  });

  it('--dry-run outputs JSON with dryRun: true and does not send mutation', async () => {
    let mutationCalled = false;
    // Custom fetch that tracks whether the mutation was called
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('query Me')) {
        return { ok: true, json: async () => ({ data: MOCK_WALLETS_DATA }), text: async () => '{}' };
      }
      if (body.query.includes('LnInvoicePaymentSend')) {
        mutationCalled = true;
        return {
          ok: true,
          json: async () => ({ data: { lnInvoicePaymentSend: { status: 'SUCCESS', errors: [] } } }),
          text: async () => '{}',
        };
      }
      throw new Error('Unexpected query');
    };

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice', '--wallet', 'BTC', '--dry-run'];
    const { main } = freshRequire('pay_invoice.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.dryRun, true);
    assert.equal(output.walletId, 'btc-wallet-id');
    assert.equal(output.walletCurrency, 'BTC');
    assert.equal(output.balance, 50000);
    assert.equal(mutationCalled, false, 'Mutation should not be called during dry-run');
  });

  it('successful payment returns status SUCCESS', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnInvoicePaymentSend: { lnInvoicePaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice', '--wallet', 'BTC'];
    const { main } = freshRequire('pay_invoice.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.walletCurrency, 'BTC');
    assert.equal(output.balanceBefore, 50000);
  });

  it('USD wallet payment includes balanceBeforeFormatted', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnInvoicePaymentSend: { lnInvoicePaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice', '--wallet', 'USD'];
    const { main } = freshRequire('pay_invoice.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.walletCurrency, 'USD');
    assert.equal(output.balanceBeforeFormatted, '$15.00');
  });

  it('zero BTC balance without --force throws Insufficient balance', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': EMPTY_BTC_WALLETS_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice'];
    const { main } = freshRequire('pay_invoice.js');
    await assert.rejects(main, /Insufficient balance/);
  });

  it('zero BTC balance with --force proceeds to mutation', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': EMPTY_BTC_WALLETS_DATA,
        LnInvoicePaymentSend: {
          lnInvoicePaymentSend: {
            status: 'FAILURE',
            errors: [{ message: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' }],
          },
        },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice', '--force'];
    const { main } = freshRequire('pay_invoice.js');
    // Will throw due to payment errors, but the point is it GOT to the mutation
    await assert.rejects(main, /Payment failed/);
  });

  it('payment errors are thrown', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnInvoicePaymentSend: {
          lnInvoicePaymentSend: {
            status: 'FAILURE',
            errors: [{ message: 'Route not found', code: 'ROUTE_NOT_FOUND' }],
          },
        },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice'];
    const { main } = freshRequire('pay_invoice.js');
    await assert.rejects(main, /Payment failed.*Route not found/);
  });

  it('CANT_PAY_SELF error produces a clear actionable message', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnInvoicePaymentSend: {
          lnInvoicePaymentSend: {
            status: 'FAILURE',
            errors: [{ message: 'Cannot pay yourself', code: 'CANT_PAY_SELF' }],
          },
        },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice'];
    const { main } = freshRequire('pay_invoice.js');
    await assert.rejects(main, /Cannot pay your own invoice.*CANT_PAY_SELF/);
  });

  it('CANT_PAY_SELF detected by message text (lowercase "self")', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnInvoicePaymentSend: {
          lnInvoicePaymentSend: {
            status: 'FAILURE',
            errors: [{ message: 'You cannot pay yourself' }],
          },
        },
      }),
    );

    process.argv = ['node', 'blink', 'lnbc100n1p0testinvoice'];
    const { main } = freshRequire('pay_invoice.js');
    await assert.rejects(main, /Cannot pay your own invoice.*CANT_PAY_SELF/);
  });
});

// ── pay_lnaddress tests ──────────────────────────────────────────────────────

describe('pay_lnaddress', () => {
  let env;

  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => {
    env.restore();
  });

  it('--dry-run outputs JSON with dryRun: true', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'user@blink.sv', '1000', '--wallet', 'BTC', '--dry-run'];
    const { main } = freshRequire('pay_lnaddress.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.dryRun, true);
    assert.equal(output.lnAddress, 'user@blink.sv');
    assert.equal(output.amountSats, 1000);
    assert.equal(output.walletCurrency, 'BTC');
  });

  it('successful payment returns correct JSON', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnAddressPaymentSend: { lnAddressPaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'user@blink.sv', '1000'];
    const { main } = freshRequire('pay_lnaddress.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.lnAddress, 'user@blink.sv');
    assert.equal(output.amountSats, 1000);
  });

  it('insufficient BTC balance without --force throws error', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': LOW_BTC_WALLETS_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'user@blink.sv', '1000'];
    const { main } = freshRequire('pay_lnaddress.js');
    await assert.rejects(main, /Insufficient balance/);
  });

  it('--force allows payment with insufficient balance', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': LOW_BTC_WALLETS_DATA,
        LnAddressPaymentSend: { lnAddressPaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'user@blink.sv', '1000', '--force'];
    const { main } = freshRequire('pay_lnaddress.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
  });

  it('--max-amount rejects when exceeded', async () => {
    // max-amount check happens before wallet resolution, so no fetch needed
    process.argv = ['node', 'blink', 'user@blink.sv', '5000', '--max-amount', '1000'];
    const { main } = freshRequire('pay_lnaddress.js');
    await assert.rejects(main, /exceeds --max-amount/);
  });

  it('USD wallet skips balance check (cents vs sats not comparable)', async () => {
    // USD wallet with 1500 cents, sending 5000 sats — should NOT fail balance check
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnAddressPaymentSend: { lnAddressPaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'user@blink.sv', '5000', '--wallet', 'USD'];
    const { main } = freshRequire('pay_lnaddress.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.walletCurrency, 'USD');
  });
});

// ── pay_lnurl tests ──────────────────────────────────────────────────────────

describe('pay_lnurl', () => {
  let env;

  beforeEach(() => {
    env = setupTestEnv();
  });
  afterEach(() => {
    env.restore();
  });

  it('--dry-run outputs JSON with dryRun: true', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'lnurl1dp68gup69uhnzwfj9cknpvz', '2000', '--dry-run'];
    const { main } = freshRequire('pay_lnurl.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.dryRun, true);
    assert.equal(output.amountSats, 2000);
    assert.equal(output.walletCurrency, 'BTC');
  });

  it('successful payment returns correct JSON shape', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': MOCK_WALLETS_DATA,
        LnurlPaymentSend: { lnurlPaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'lnurl1dp68gup69uhnzwfj9cknpvz', '2000'];
    const { main } = freshRequire('pay_lnurl.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
    assert.equal(output.amountSats, 2000);
    assert.equal(output.walletId, 'btc-wallet-id');
    assert.equal(output.balanceBefore, 50000);
  });

  it('insufficient BTC balance without --force throws error', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': LOW_BTC_WALLETS_DATA,
      }),
    );

    process.argv = ['node', 'blink', 'lnurl1dp68gup69uhnzwfj9cknpvz', '2000'];
    const { main } = freshRequire('pay_lnurl.js');
    await assert.rejects(main, /Insufficient balance/);
  });

  it('--force allows payment with insufficient balance', async () => {
    env.setFetch(
      createMockFetch({
        'query Me': LOW_BTC_WALLETS_DATA,
        LnurlPaymentSend: { lnurlPaymentSend: { status: 'SUCCESS', errors: [] } },
      }),
    );

    process.argv = ['node', 'blink', 'lnurl1dp68gup69uhnzwfj9cknpvz', '2000', '--force'];
    const { main } = freshRequire('pay_lnurl.js');
    await main();

    const output = env.getStdoutJson();
    assert.equal(output.status, 'SUCCESS');
  });

  it('--max-amount rejects when exceeded', async () => {
    process.argv = ['node', 'blink', 'lnurl1dp68gup69uhnzwfj9cknpvz', '5000', '--max-amount', '1000'];
    const { main } = freshRequire('pay_lnurl.js');
    await assert.rejects(main, /exceeds --max-amount/);
  });
});
