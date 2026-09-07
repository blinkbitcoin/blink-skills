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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');

const binPath = path.resolve(__dirname, '..', 'bin', 'blink.js');
const stubPath = path.resolve(__dirname, 'fixtures', 'spark_sdk_stub.js');

const SPARK_COMMANDS = ['spark-balance', 'spark-send', 'spark-transactions', 'spark-subscribe'];
const CREDENTIAL_FREE_COMMANDS = ['resolve-receiver', 'create-invoice-lnaddress'];

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
      env: { SPARK_STUB_STATUS: 'COMPLETED' },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).status, 'COMPLETED');
  });

  it('exits NON-ZERO on a failed payment, through the CLI dispatch path', async () => {
    // The forceExit path in bin/blink.js must preserve the code main() set;
    // exiting 0 here would report a payment that did not happen as success.
    const { code, stdout } = await runCli(['spark-send', 'lnbc100n1pabc', '1000'], {
      env: { SPARK_STUB_STATUS: 'failed' },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).status, 'failed', 'explicit JSON is still emitted');
  });

  it('exits 0 on a pending payment', async () => {
    const { code } = await runCli(['spark-send', 'lnbc100n1pabc', '1000'], {
      env: { SPARK_STUB_STATUS: 'pending' },
    });
    assert.equal(code, 0);
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
