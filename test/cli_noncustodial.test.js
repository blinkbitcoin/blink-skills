/**
 * CLI-level tests for the non-custodial commands.
 *
 * These spawn the REAL `bin/blink.js` as a subprocess, so they cover the layer
 * that unit tests structurally cannot: command registration, option parsing,
 * argv forwarding into the script, and the process exit code the caller
 * actually observes.
 *
 * That layer is where the "every spark-* command hangs via the CLI" bug lived —
 * `main()` was fine; dispatch was not — so asserting on source text (does the
 * file contain "commands['spark-balance']") would not have caught it. These run
 * the binary.
 *
 * The Breez SDK is replaced by test/fixtures/spark_sdk_stub.js via `--require`;
 * no network, no native dependency.
 *
 * Run: node --test test/cli_noncustodial.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const binPath = path.resolve(__dirname, '..', 'bin', 'blink.js');
const stubPath = path.resolve(__dirname, 'fixtures', 'spark_sdk_stub.js');

const SPARK_COMMANDS = [
  'spark-balance',
  'spark-send',
  'spark-fee-probe',
  'spark-transactions',
  'spark-subscribe',
  'spark-info',
];
const CREDENTIAL_FREE_COMMANDS = ['resolve-receiver', 'create-invoice-lnaddress'];

// spark-send enforces budget limits and records spends under ~/.blink. Point
// the CLI's HOME at a throwaway dir so tests neither read the runner's real
// budget config nor write into the real spending log.
const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-cli-home-'));
after(() => fs.rmSync(cliHome, { recursive: true, force: true }));

/**
 * Run the CLI. Resolves with { code, stdout, stderr } — a non-zero exit is data
 * here, not an error, since exit codes are part of what we are asserting.
 */
function runCli(args, { env = {}, stub = true, timeout = 20000 } = {}) {
  const nodeArgs = stub ? ['--require', stubPath, binPath, ...args] : [binPath, ...args];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      nodeArgs,
      { env: { ...process.env, ...env }, timeout, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr, killed: err && err.killed });
      },
    );
  });
}

// ── registration ─────────────────────────────────────────────────────────────

describe('CLI: non-custodial commands are registered', () => {
  it('lists every new command in --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    for (const cmd of [...SPARK_COMMANDS, ...CREDENTIAL_FREE_COMMANDS]) {
      assert.ok(stdout.includes(cmd), `${cmd} should appear in --help`);
    }
  });

  it('gives each new command its own help', async () => {
    for (const cmd of [...SPARK_COMMANDS, ...CREDENTIAL_FREE_COMMANDS]) {
      const { code, stdout } = await runCli([cmd, '--help']);
      assert.equal(code, 0, `${cmd} --help should exit 0`);
      assert.ok(stdout.includes(cmd), `${cmd} --help should name the command`);
    }
  });

  it('rejects an unknown command', async () => {
    const { code } = await runCli(['spark-nonsense']);
    assert.notEqual(code, 0);
  });
});

// ── the commands terminate (regression: they used to hang) ───────────────────

describe('CLI: spark commands return instead of hanging', () => {
  it('spark-balance exits promptly with JSON', async () => {
    const { code, stdout, killed } = await runCli(['spark-balance'], { env: { SPARK_STUB_BALANCE: '2551' } });
    assert.ok(!killed, 'command must not hit the timeout');
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).balanceSats, 2551);
  });

  it('spark-info exits promptly with the getInfo payload and network', async () => {
    const { code, stdout, killed } = await runCli(['spark-info'], { env: { SPARK_STUB_BALANCE: '2551' } });
    assert.ok(!killed, 'command must not hit the timeout');
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.accountType, 'lnaddress');
    assert.equal(j.balanceSats, 2551);
    assert.equal(j.network, 'mainnet');
  });

  it('spark-info forwards --network to connect()', async () => {
    const { code, stderr, stdout } = await runCli(['spark-info', '--network', 'regtest'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.equal(code, 0);
    assert.match(stderr, /STUB_NETWORK=regtest/);
    assert.equal(JSON.parse(stdout).network, 'regtest');
  });

  it('spark-info converts a non-empty tokenBalances Map instead of reporting {}', async () => {
    const { code, stdout } = await runCli(['spark-info'], {
      env: { SPARK_STUB_TOKEN_BALANCES: JSON.stringify({ 'token-1': { balance: 5000 } }) },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.deepEqual(
      j.tokenBalances,
      { 'token-1': { balance: 5000 } },
      'a wallet holding tokens must not report an empty object',
    );
  });

  it('spark-transactions exits promptly with JSON', async () => {
    const payments = JSON.stringify([
      { id: 'p1', paymentType: 'send', status: 'completed', amount: 10, fees: 3, timestamp: 1710000000 },
    ]);
    const { code, stdout, killed } = await runCli(['spark-transactions'], { env: { SPARK_STUB_PAYMENTS: payments } });
    assert.ok(!killed);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).count, 1);
  });

  it('spark-subscribe honours its timeout and exits', async () => {
    const { code, stdout, killed } = await runCli(['spark-subscribe', '--timeout', '1']);
    assert.ok(!killed, 'subscribe must exit on its own timeout');
    assert.equal(code, 0);
    assert.match(stdout, /sdk_event/);
  });
});

// ── argv / option forwarding ─────────────────────────────────────────────────

describe('CLI: options reach the underlying script', () => {
  it('forwards --limit to spark-transactions', async () => {
    const { stderr } = await runCli(['spark-transactions', '--limit', '50'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.match(stderr, /STUB_LIMIT=50/);
  });

  it('forwards --network to the SDK connect call', async () => {
    const { stderr } = await runCli(['spark-balance', '--network', 'regtest'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.match(stderr, /STUB_NETWORK=regtest/);
  });

  // Review finding: an unset --network used to be defaulted to mainnet by the
  // CLI registry and then clobbered the operator's SPARK_NETWORK=regtest. One
  // precedence rule must hold everywhere: --network > SPARK_NETWORK > mainnet.
  it('honours SPARK_NETWORK=regtest when no --network flag is given', async () => {
    const { stderr, stdout } = await runCli(['spark-balance'], {
      env: { SPARK_STUB_ECHO: '1', SPARK_NETWORK: 'regtest' },
    });
    assert.match(stderr, /STUB_NETWORK=regtest/);
    assert.match(stdout, /"network":\s*"regtest"/);
  });

  it('an explicit --network overrides SPARK_NETWORK', async () => {
    const { stderr } = await runCli(['spark-balance', '--network', 'mainnet'], {
      env: { SPARK_STUB_ECHO: '1', SPARK_NETWORK: 'regtest' },
    });
    assert.match(stderr, /STUB_NETWORK=mainnet/);
  });

  it('defaults to mainnet only when neither flag nor env is set', async () => {
    const env = { SPARK_STUB_ECHO: '1' };
    delete process.env.SPARK_NETWORK;
    const { stderr } = await runCli(['spark-balance'], { env });
    assert.match(stderr, /STUB_NETWORK=mainnet/);
  });

  it('forwards destination and amount to spark-send', async () => {
    const { stderr } = await runCli(['spark-send', 'lnbc100n1pabc', '1000', '--dry-run'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.match(stderr, /STUB_DESTINATION=lnbc100n1pabc/);
    assert.match(stderr, /STUB_AMOUNT=1000/);
  });

  it('rejects a non-numeric amount before reaching the SDK', async () => {
    const { code, stderr } = await runCli(['spark-send', 'lnbc100n1pabc', 'abc']);
    assert.notEqual(code, 0);
    assert.ok(stderr.length > 0);
  });

  it('--dry-run does not send', async () => {
    const { code, stdout } = await runCli(['spark-send', 'alice@blink.sv', '1000', '--dry-run']);
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.event, 'send_prepared');
    assert.equal(j.dryRun, true);
  });
});

// ── exit codes (review finding #6) ───────────────────────────────────────────

describe('CLI: spark-send exit code reflects payment outcome', () => {
  it('exits 0 on a completed payment', async () => {
    const { code, stdout } = await runCli(['spark-send', 'lnbc100n1pabc', '1000'], {
      env: { HOME: cliHome, SPARK_STUB_STATUS: 'COMPLETED' },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).status, 'COMPLETED');
  });

  it('exits NON-ZERO on a failed payment, through the CLI dispatch path', async () => {
    // The forceExit path in bin/blink.js must preserve the code main() set;
    // exiting 0 here would report a payment that did not happen as success.
    const { code, stdout } = await runCli(['spark-send', 'lnbc100n1pabc', '1000'], {
      env: { HOME: cliHome, SPARK_STUB_STATUS: 'failed' },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).status, 'failed', 'explicit JSON is still emitted');
  });

  it('exits 0 on a pending payment', async () => {
    const { code } = await runCli(['spark-send', 'lnbc100n1pabc', '1000'], {
      env: { HOME: cliHome, SPARK_STUB_STATUS: 'pending' },
    });
    assert.equal(code, 0);
  });
});

// ── destination classification ───────────────────────────────────────────────

describe('CLI: exhaustive destination classification', () => {
  it('spark-send rejects an unsupported SDK destination before any prepare call', async () => {
    const { code, stderr } = await runCli(['spark-send', 'bc1qxyz', '100'], {
      env: { HOME: cliHome, SPARK_STUB_PARSE_TYPE: 'bitcoinAddress' },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /Unsupported destination type/);
  });

  it('spark-fee-probe rejects the same unsupported destinations', async () => {
    const { code, stderr } = await runCli(['spark-fee-probe', 'bc1qxyz', '100'], {
      env: { SPARK_STUB_PARSE_TYPE: 'bolt12Invoice' },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /Unsupported destination type/);
  });

  it('a Spark address is routed and labeled spark (not bolt11)', async () => {
    const { code, stdout } = await runCli(['spark-fee-probe', 'spark1qxyz', '100'], {
      env: { SPARK_STUB_PARSE_TYPE: 'sparkAddress' },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.destinationType, 'spark');
    assert.equal(j.feeSats, 3);
  });
});

// ── budget enforcement (parity with the custodial pay commands) ──────────────

describe('CLI: spark-send budget enforcement', () => {
  it('a configured budget blocks an over-limit send', async () => {
    const { code, stderr } = await runCli(['spark-send', 'lnbc100n1pabc', '100'], {
      env: { HOME: cliHome, BLINK_BUDGET_DAILY_SATS: '50' },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /Budget exceeded/);
  });

  it('--force bypasses the budget check and records the spend', async () => {
    const { code } = await runCli(['spark-send', 'lnbc100n1pabc', '100', '--force'], {
      env: { HOME: cliHome, BLINK_BUDGET_DAILY_SATS: '50', SPARK_STUB_STATUS: 'COMPLETED' },
    });
    assert.equal(code, 0);
    const log = JSON.parse(fs.readFileSync(path.join(cliHome, '.blink', 'spending-log.json'), 'utf8'));
    const entry = log.find((e) => e.command === 'spark-send' && e.sats === 100);
    assert.ok(entry, 'the send must be recorded in the spending log');
  });

  it('an unconfigured budget does not block an explicit send, and records it', async () => {
    // Explicitly blank the budget env vars: the runner's real environment must
    // not leak a configured budget into this "unconfigured" assertion.
    const { code } = await runCli(['spark-send', 'lnbc100n1pabc', '100'], {
      env: { HOME: cliHome, BLINK_BUDGET_HOURLY_SATS: '', BLINK_BUDGET_DAILY_SATS: '', SPARK_STUB_STATUS: 'COMPLETED' },
    });
    assert.equal(code, 0);
    const log = JSON.parse(fs.readFileSync(path.join(cliHome, '.blink', 'spending-log.json'), 'utf8'));
    assert.ok(log.some((e) => e.command === 'spark-send'));
  });
});

// ── spark-fee-probe ──────────────────────────────────────────────────────────

describe('CLI: spark-fee-probe', () => {
  it('reports fees without sending (bolt11 path)', async () => {
    const { code, stdout, killed } = await runCli(['spark-fee-probe', 'lnbc100n1pabc', '100']);
    assert.ok(!killed, 'probe must not hang');
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.event, 'fee_probe');
    assert.equal(j.destinationType, 'bolt11');
    assert.equal(j.feeSats, 3); // stub prepareSendPayment -> lightningFeeSats
  });

  it('classifies a Lightning Address as the lnurl path', async () => {
    const { code, stdout } = await runCli(['spark-fee-probe', 'alice@blink.sv', '100']);
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.destinationType, 'lnurl');
    assert.equal(j.feeSats, 2); // stub prepareLnurlPay -> feeSats
  });

  it('forwards --network', async () => {
    const { stderr } = await runCli(['spark-fee-probe', 'lnbc100n1pabc', '100', '--network', 'regtest'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.match(stderr, /STUB_NETWORK=regtest/);
  });
});

// ── spark-transactions pagination / filtering ────────────────────────────────

describe('CLI: spark-transactions pagination and filtering', () => {
  it('forwards --offset to the SDK listPayments call', async () => {
    const { stderr } = await runCli(['spark-transactions', '--offset', '40'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.match(stderr, /STUB_OFFSET=40/);
  });

  it('passes --type to the SDK as a native typeFilter (pagination over the filtered stream)', async () => {
    const { stderr } = await runCli(['spark-transactions', '--type', 'receive'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.match(stderr, /STUB_TYPEFILTER=receive/);
  });

  it('filters by --type receive', async () => {
    const payments = JSON.stringify([
      { id: 'p1', paymentType: 'send', status: 'completed', amount: 10, fees: 3, timestamp: 1710000000 },
      { id: 'p2', paymentType: 'receive', status: 'completed', amount: 20, fees: 0, timestamp: 1710000001 },
    ]);
    const { code, stdout } = await runCli(['spark-transactions', '--type', 'receive'], {
      env: { SPARK_STUB_PAYMENTS: payments },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.count, 1);
    assert.equal(j.transactions[0].id, 'p2');
    assert.equal(j.typeFilter, 'receive');
  });

  it('reports hasNextPage=false for a partial page', async () => {
    const payments = JSON.stringify([{ id: 'p1', paymentType: 'send', status: 'completed', amount: 10, fees: 0 }]);
    const { code, stdout } = await runCli(['spark-transactions', '--limit', '20'], {
      env: { SPARK_STUB_PAYMENTS: payments },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).pageInfo.hasNextPage, false);
  });

  it('rejects an invalid --type', async () => {
    const { code } = await runCli(['spark-transactions', '--type', 'sideways']);
    assert.notEqual(code, 0);
  });
});

// ── budget CLI dispatch (review: documented --force must reach the script) ───

describe('CLI: budget reset through the public dispatcher', () => {
  function seededHome(entries) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-cli-reset-'));
    fs.mkdirSync(path.join(home, '.blink'), { recursive: true });
    fs.writeFileSync(path.join(home, '.blink', 'spending-log.json'), JSON.stringify(entries), 'utf8');
    return home;
  }

  it('ordinary reset clears finalized history and keeps active reservations', async () => {
    const home = seededHome([
      { ts: Date.now(), sats: 10, command: 'pay-invoice', domain: null },
      { ts: Date.now(), sats: 60, command: 'spark-send', domain: null, state: 'reserved', id: 'r1' },
    ]);
    try {
      const { code, stdout } = await runCli(['budget', 'reset'], { env: { HOME: home }, stub: false });
      assert.equal(code, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.removed, 1);
      assert.equal(out.keptReserved, 1);
      const remaining = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'spending-log.json'), 'utf8'));
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].state, 'reserved');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reset --force survives CLI dispatch and clears everything (incl. reservations)', async () => {
    const home = seededHome([
      { ts: Date.now(), sats: 60, command: 'spark-send', domain: null, state: 'reserved', id: 'r1' },
    ]);
    try {
      const { code, stdout } = await runCli(['budget', 'reset', '--force'], { env: { HOME: home }, stub: false });
      assert.equal(code, 0, 'the documented --force escape hatch must work through `blink`');
      const out = JSON.parse(stdout);
      assert.equal(out.removed, 1);
      assert.equal(out.force, true);
      const remaining = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'spending-log.json'), 'utf8'));
      assert.deepEqual(remaining, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── credential-free commands need no API key ─────────────────────────────────

describe('CLI: credential-free commands run without BLINK_API_KEY', () => {
  it('resolve-receiver does not demand an API key', async () => {
    // No stub needed: these are pure HTTP. We only assert that the command does
    // NOT fail on a missing credential — a network error is an acceptable
    // outcome here and is not what is under test.
    const { stderr } = await runCli(['resolve-receiver', 'alice@blink.sv'], {
      env: { BLINK_API_KEY: '' },
      stub: false,
      timeout: 25000,
    });
    assert.ok(!/BLINK_API_KEY/.test(stderr), `should not require an API key, got: ${stderr}`);
  });

  it('refuses a non-Blink domain', async () => {
    const { code, stderr } = await runCli(['resolve-receiver', 'alice@attacker.example'], {
      env: { BLINK_API_KEY: '' },
      stub: false,
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /non-Blink domain/);
  });

  it('create-invoice-lnaddress refuses a non-Blink domain', async () => {
    const { code, stderr } = await runCli(['create-invoice-lnaddress', 'alice@attacker.example', '1000'], {
      env: { BLINK_API_KEY: '' },
      stub: false,
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /non-Blink domain/);
  });
});
