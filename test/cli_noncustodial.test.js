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
  'spark-token-info',
  'spark-receive-token',
  'spark-lnaddress',
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
    assert.equal(j.accountType, 'spark');
    assert.equal(j.balanceSats, 2551);
    assert.equal(j.network, 'mainnet');
    // No address registered AND the lookup service answered the probe —
    // a verified negative, not a silent one.
    assert.equal(j.lnAddressStatus, 'none');
    assert.equal(j.lightningAddress, null);
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
    assert.ok(j.tokenBalances['token-1'], 'a wallet holding tokens must not report an empty object');
    assert.equal(j.tokenBalances['token-1'].balance, 5000);
    assert.equal(j.tokenBalances['token-1'].tokenMetadata.decimals, 6, 'metadata rides along');
  });

  it('spark-info emits unsafe bigints as decimal strings, never rounded', async () => {
    // Beyond Number.MAX_SAFE_INTEGER: a JSON number would round to ...992.
    const huge = '9007199254740993';
    const { code, stdout } = await runCli(['spark-info'], {
      env: { SPARK_STUB_TOKEN_BALANCES: JSON.stringify({ 'token-1': { balance: huge } }) },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.tokenBalances['token-1'].balance, huge);
    assert.equal(typeof j.tokenBalances['token-1'].balance, 'string');
  });

  // ── token (BTKN / USDB) surface ──────────────────────────────────────────────

  it('spark-balance includes normalized tokenBalances with metadata', async () => {
    const { code, stdout } = await runCli(['spark-balance'], {
      env: {
        SPARK_STUB_BALANCE: '2551',
        SPARK_STUB_TOKEN_BALANCES: JSON.stringify({ 'token-1': { balance: 10500000 } }),
      },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.balanceSats, 2551);
    assert.equal(j.tokenBalances['token-1'].balance, '10500000', 'balance is a precision-preserving string');
    assert.equal(j.tokenBalances['token-1'].balanceFormatted, '10.500000', 'formatted at the token decimals');
    assert.equal(j.tokenBalances['token-1'].ticker, 'TKN', 'metadata is flattened onto the entry');
  });

  it('spark-token-info resolves the usdb alias on mainnet and fetches metadata', async () => {
    const { code, stdout } = await runCli(['spark-token-info', 'usdb'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.found, true);
    assert.equal(j.ticker, 'USDB');
    assert.equal(j.decimals, 6);
    // The alias must resolve to the documented mainnet constant.
    assert.equal(j.identifier, 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87');
  });

  it('the usdb alias on regtest fails with the SPARK_USDB_TOKEN hint unless the env var is set', async () => {
    const { code, stderr } = await runCli(['spark-token-info', 'usdb', '--network', 'regtest']);
    assert.notEqual(code, 0);
    assert.match(stderr, /SPARK_USDB_TOKEN/);
  });

  it('spark-receive-token mints a Spark invoice with the resolved token and base units', async () => {
    const { code, stdout, stderr } = await runCli(['spark-receive-token', '25', '--description', 'Invoice #42']);
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.event, 'token_invoice_created');
    assert.equal(j.tokenIdentifier, 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87');
    assert.equal(j.amountBaseUnits, '25000000', '25 USDB at 6 decimals');
    assert.ok(j.paymentRequest.startsWith('sprtstub1'));
    assert.match(stderr, /Stub Dollar \(USDB\), 6 decimals/);
  });

  it('spark-receive-token --base-units skips the metadata lookup', async () => {
    const { code, stdout } = await runCli(['spark-receive-token', '10500000', '--base-units']);
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.amountBaseUnits, '10500000');
    assert.equal(j.baseUnits, true);
  });

  it('spark-send --token routes prepare with tokenIdentifier + base units (dry-run)', async () => {
    const { code, stdout, stderr } = await runCli(['spark-send', 'sprt1stub', '10.5', '--token', 'usdb', '--dry-run'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.equal(code, 0);
    assert.match(stderr, /STUB_TOKEN=btkn1/);
    const j = JSON.parse(stdout);
    assert.equal(j.event, 'send_prepared');
    assert.equal(j.destinationType, 'spark');
    assert.equal(j.tokenIdentifier, 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87');
    assert.equal(j.amountBaseUnits, '10500000');
  });

  it('spark-send --token --from-btc attaches conversionOptions and reserves the sats side', async () => {
    // The stub's conversionEstimate for fromBitcoin is amountIn=50000 (sats).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-cli-token-'));
    try {
      const { code, stdout, stderr } = await runCli(
        ['spark-send', 'sprt1stub', '10.5', '--token', 'usdb', '--from-btc', '--dry-run'],
        { env: { SPARK_STUB_ECHO: '1', HOME: home, BLINK_BUDGET_DAILY_SATS: '100000' } },
      );
      assert.equal(code, 0);
      assert.match(stderr, /STUB_CONV=fromBitcoin/);
      const j = JSON.parse(stdout);
      assert.equal(j.conversionEstimate.conversionType, 'fromBitcoin');
      assert.equal(j.conversionEstimate.amountIn, '50000');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('spark-fee-probe quotes a token conversion (prepare only)', async () => {
    // The stub's toBitcoin prepare binds to a fixed 45000-sat invoice; the
    // supplied amount must match it (amount binding).
    const { code, stdout } = await runCli(['spark-fee-probe', 'lnbc1000u1p0x', '45000', '--from-token', 'usdb'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.event, 'fee_probe');
    assert.equal(j.conversionEstimate.conversionType, 'toBitcoin');
    assert.equal(j.conversionEstimate.amountOut, '45000', 'the sats side of the quote');
  });

  it('spark-fee-probe --from-token REJECTS a mismatching supplied amount', async () => {
    const { code, stderr } = await runCli(['spark-fee-probe', 'lnbc1000u1p0x', '1000', '--from-token', 'usdb'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /invoice is for 45000 sats but 1000 was supplied/);
  });

  it('spark-send --from-token dry-run rejects an amount mismatch before any dispatch', async () => {
    const { code, stderr } = await runCli(['spark-send', 'lnbc1000u1p0x', '1', '--from-token', 'usdb', '--dry-run']);
    assert.notEqual(code, 0);
    assert.match(stderr, /invoice is for 45000 sats but 1 was supplied/);
  });

  it('spark-send --token with a BOLT-11 destination is rejected', async () => {
    const { code, stderr } = await runCli(['spark-send', 'lnbc1000u1p0x', '10', '--token', 'usdb', '--dry-run']);
    assert.notEqual(code, 0);
    assert.match(stderr, /Token sends require a Spark address or Spark invoice/);
  });

  // ── spark-lnaddress lifecycle (Blink-domain-pinned) ────────────────────────

  it('spark-lnaddress get reports registered:false when no address is registered', async () => {
    const { code, stdout } = await runCli(['spark-lnaddress', 'get']);
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.accountType, 'spark');
    assert.equal(j.registered, false);
    assert.equal(j.lightningAddress, null);
    assert.equal(j.lnurlDomain, 'blink.sv', 'the Blink domain is always reported');
  });

  // Field-test reproduction (2026-09-12): blink.sv management endpoints 404'd
  // while a registered address existed; getLightningAddress() read an empty
  // recovery cache and reported a FALSE registered:false. A cache miss is now
  // only trusted after probing the service.
  it("spark-lnaddress get reports registered:'unknown' and exits non-zero when the lookup service is unreachable", async () => {
    const { code, stdout, stderr } = await runCli(['spark-lnaddress', 'get'], {
      env: { SPARK_STUB_LN_LOOKUP_BROKEN: '1' },
    });
    assert.equal(code, 1, 'an unverifiable answer must fail loudly, not exit 0');
    const j = JSON.parse(stdout);
    assert.equal(j.registered, 'unknown');
    assert.equal(j.lightningAddress, null);
    assert.ok(j.lookupError, 'the probe error is surfaced');
    assert.match(j.message, /NOT a "no address" answer/i);
    assert.match(stderr, /UNKNOWN, not false/);
  });

  it("spark-info reports lnAddressStatus:'unverified' (exit 0) when the lookup service is unreachable", async () => {
    const { code, stdout } = await runCli(['spark-info'], {
      env: { SPARK_STUB_LN_LOOKUP_BROKEN: '1', SPARK_STUB_BALANCE: '2551' },
    });
    assert.equal(code, 0, 'spark-info stays non-fatal — but never presents null as a verified negative');
    const j = JSON.parse(stdout);
    assert.equal(j.lnAddressStatus, 'unverified');
    assert.equal(j.lightningAddress, null);
  });

  it('spark-lnaddress get reports a registered address with the Blink domain', async () => {
    const { code, stdout } = await runCli(['spark-lnaddress', 'get'], {
      env: { SPARK_STUB_LN_ADDRESS: 'satoshi@blink.sv' },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.registered, true);
    assert.equal(j.lightningAddress, 'satoshi@blink.sv');
    assert.equal(j.username, 'satoshi');
    assert.equal(j.lnurlDomain, 'blink.sv');
  });

  it('spark-lnaddress check reports availability', async () => {
    const { code, stdout } = await runCli(['spark-lnaddress', 'check', 'satoshi'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.available, true);
    assert.equal(j.lnurlDomain, 'blink.sv');
  });

  it('spark-lnaddress register claims the username on the Blink domain', async () => {
    const { code, stdout, stderr } = await runCli(
      ['spark-lnaddress', 'register', 'satoshi', '--description', 'Payments'],
      { env: { SPARK_STUB_ECHO: '1' } },
    );
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.status, 'REGISTERED');
    assert.equal(j.lightningAddress, 'satoshi@blink.sv', 'registered on the BLINK domain, never breez.tips');
    assert.equal(j.description, 'Payments');
    assert.match(stderr, /STUB_LN_REGISTER=satoshi/);
  });

  it('spark-lnaddress register refuses an unavailable username', async () => {
    const { code, stdout } = await runCli(['spark-lnaddress', 'register', 'satoshi'], {
      env: { SPARK_STUB_LN_AVAILABLE: '0' },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).status, 'UNAVAILABLE');
  });

  it('spark-lnaddress rejects invalid usernames client-side', async () => {
    for (const bad of ['ab', 'Has Space', '123', 'lnbc1x']) {
      const { code, stderr } = await runCli(['spark-lnaddress', 'check', bad]);
      assert.notEqual(code, 0, bad);
      assert.ok(stderr.length > 0);
    }
  });

  it('spark-lnaddress rejects uppercase client-side — never normalizes it onto the network (field test)', async () => {
    const { code, stderr } = await runCli(['spark-lnaddress', 'check', 'UPPERCASE1'], {
      env: { SPARK_STUB_ECHO: '1' },
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /lowercase/);
    assert.ok(!/STUB_LN_CHECK/.test(stderr), 'rejection must happen BEFORE any network call');
  });

  it('spark-lnaddress delete succeeds and reports the domain', async () => {
    const { code, stdout, stderr } = await runCli(['spark-lnaddress', 'delete'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.status, 'DELETED');
    assert.equal(j.lnurlDomain, 'blink.sv');
    assert.match(stderr, /STUB_LN_DELETE=1/);
  });

  it('the SDK is connected with lnurlDomain pinned to blink.sv (never the breez.tips default)', async () => {
    const { code, stdout } = await runCli(['spark-lnaddress', 'get'], { env: { SPARK_STUB_ECHO: '1' } });
    assert.equal(code, 0);
    // The domain in the output comes from the same lnurlDomainFor the real
    // connect() uses — this pins the default for the whole command family.
    assert.equal(JSON.parse(stdout).lnurlDomain, 'blink.sv');
  });

  it('SPARK_LNURL_DOMAIN=breez.tips is refused hard', async () => {
    const { code, stderr } = await runCli(['spark-lnaddress', 'get'], { env: { SPARK_LNURL_DOMAIN: 'breez.tips' } });
    assert.notEqual(code, 0);
    assert.match(stderr, /breez\.tips.*not permitted/s);
  });

  it('spark-info includes the recovered lightningAddress when registered', async () => {
    const { code, stdout } = await runCli(['spark-info'], {
      env: { SPARK_STUB_LN_ADDRESS: 'satoshi@blink.sv' },
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.lightningAddress, 'satoshi@blink.sv');
    assert.equal(j.lnurlDomain, 'blink.sv');
  });

  it('the standalone wrapper (direct script invocation) drains stdout and exits cleanly', async () => {
    // The require.main === module runner path is only reachable by invoking
    // the script directly — bin/blink.js requires the module instead.
    const scriptPath = path.resolve(__dirname, '..', 'blink', 'scripts', 'spark_info.js');
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--require', stubPath, scriptPath],
        { env: { ...process.env, SPARK_STUB_BALANCE: '777' }, timeout: 20000, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (err.code === undefined ? 1 : err.code) : 0,
            stdout,
            stderr,
            killed: err && err.killed,
          });
        },
      );
    });
    assert.ok(!result.killed, 'must not hang on the SDK event loop');
    assert.equal(result.code, 0);
    const j = JSON.parse(result.stdout);
    assert.equal(j.accountType, 'spark');
    assert.equal(j.balanceSats, 777);
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

  // Field test 3 (live): the wallet's real USDB receive surfaced as
  // amountSats: 999001 — a $0.999 receive presented as ~$770 of sats.
  // End-to-end through the CLI: token rows must carry base units + metadata.
  it('spark-transactions renders token rows in base units, never sats (FT3 defect)', async () => {
    const payments = JSON.stringify([
      {
        id: '07bc5d3e:0',
        paymentType: 'receive',
        status: 'completed',
        amount: '999001',
        fees: '0',
        timestamp: 1710000000,
        method: 'token',
        details: {
          type: 'token',
          metadata: { ticker: 'USDB', decimals: 6, name: 'USD Beacon', identifier: 'btkn1xgrvjwey5' },
        },
      },
    ]);
    const { code, stdout } = await runCli(['spark-transactions'], { env: { SPARK_STUB_PAYMENTS: payments } });
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.count, 1);
    const row = j.transactions[0];
    assert.equal(row.asset, 'token');
    assert.equal(row.amountSats, null, 'a $0.999 USDB receive must never appear as 999,001 sats');
    assert.equal(row.amountBaseUnits, '999001');
    assert.equal(row.amountFormatted, '0.999001');
    assert.equal(row.token.ticker, 'USDB');
    assert.equal(row.token.decimals, 6);
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

// ── l402-pay --spark through the public CLI (forceExit + full flow) ─────────

describe('CLI: l402-pay --spark lifecycle', () => {
  const http = require('node:http');

  /** Local server: 402 challenge without auth, 200 JSON with it. */
  function startServer() {
    let server;
    const ready = new Promise((resolve) => {
      server = http.createServer((req, res) => {
        if (req.headers.authorization) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(402, {
          'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"',
        });
        res.end();
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    return ready.then(() => server);
  }

  function seededHome(budget) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-cli-l402-'));
    fs.mkdirSync(path.join(home, '.blink'), { recursive: true });
    fs.writeFileSync(path.join(home, '.blink', 'budget.json'), JSON.stringify(budget), 'utf8');
    return home;
  }

  it('pays via the spark backend, retries, and terminates promptly (forceExit)', async () => {
    const server = await startServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    const { address, port } = server.address();
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, binPath, 'l402-pay', `http://${address}:${port}/resource`, '--spark', '--no-store'],
          {
            env: {
              ...process.env,
              HOME: home,
              SPARK_MNEMONIC: 'test seed words for the stub',
              BREEZ_API_KEY: 'breez-test-key',
            },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout) => resolve({ err, stdout }),
        );
      });
      assert.ok(!result.err || !result.err.killed, 'must terminate promptly — the SDK must not hang the CLI');
      const j = JSON.parse(result.stdout);
      assert.equal(j.event, 'l402_paid');
      assert.equal(j.backend, 'spark');
      assert.equal(j.paymentStatus, 'SUCCESS');
      const log = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'spending-log.json'), 'utf8'));
      assert.equal(log.length, 1);
      assert.equal(log[0].sats, 100000);
      assert.equal(log[0].state, undefined, 'finalized spend');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Field-test reproduction (2026-09-12): sendPayment resolved PENDING and the
  // caller aborted instantly — sats spent, no L402 token, no resource. The
  // payment now polls getPayment until the preimage appears.
  it('pays via spark when settlement is async: PENDING polls to SUCCESS and captures the token', async () => {
    const server = await startServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    const { address, port } = server.address();
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, binPath, 'l402-pay', `http://${address}:${port}/resource`, '--spark', '--no-store'],
          {
            env: {
              ...process.env,
              HOME: home,
              SPARK_MNEMONIC: 'test seed words for the stub',
              BREEZ_API_KEY: 'breez-test-key',
              SPARK_STUB_STATUS: 'PENDING',
              SPARK_STUB_SETTLE_AFTER_POLLS: '0', // first getPayment returns terminal + preimage
              BLINK_SPARK_POLL_INTERVAL_MS: '25',
            },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout) => resolve({ err, stdout }),
        );
      });
      assert.ok(!result.err || !result.err.killed, 'must terminate promptly');
      const j = JSON.parse(result.stdout);
      assert.equal(j.event, 'l402_paid');
      assert.equal(j.backend, 'spark');
      assert.equal(j.paymentStatus, 'SUCCESS', 'the PENDING payment settled within the poll window');
      const log = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'spending-log.json'), 'utf8'));
      assert.equal(log.length, 1, 'the settled payment is debited exactly once');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed --wait values outright (no silent prefix parsing, no infinite deadlines)', async () => {
    for (const bad of ['0.5', '1e2', '10seconds', '-1', '+5', '999999999999999999999']) {
      const { code, stderr } = await runCli(['l402-pay', 'https://example.com/x', '--spark', '--wait', bad]);
      assert.notEqual(code, 0, bad);
      // '-1' is caught earlier by the CLI's own dash-argument guard; every
      // rejection must name --wait and happen before any network activity.
      assert.match(stderr, /--wait/, bad);
      assert.ok(!stderr.includes('Requesting:'), 'rejected before any network activity');
    }
  });

  it('BLINK_SPARK_POLL_INTERVAL_MS=0 falls back to the default and still polls to settlement', async () => {
    // Review round 1: a zero interval was a non-terminating hot loop. The
    // caller-side validation must fall back to 3000ms — proven end-to-end by
    // a stub payment that settles on the first refresh.
    const server = await startServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    const { address, port } = server.address();
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, binPath, 'l402-pay', `http://${address}:${port}/resource`, '--spark', '--no-store'],
          {
            env: {
              ...process.env,
              HOME: home,
              SPARK_MNEMONIC: 'test seed words for the stub',
              BREEZ_API_KEY: 'breez-test-key',
              SPARK_STUB_STATUS: 'PENDING',
              SPARK_STUB_SETTLE_AFTER_POLLS: '0',
              BLINK_SPARK_POLL_INTERVAL_MS: '0',
              SPARK_STUB_ECHO: '1',
            },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }),
        );
      });
      assert.ok(!result.err || !result.err.killed, 'must terminate — no hot loop');
      assert.match(result.stderr, /STUB_GETPAYMENT=spark-1/, 'the refresh ran despite the invalid interval');
      const j = JSON.parse(result.stdout);
      assert.equal(j.event, 'l402_paid');
      assert.equal(j.paymentStatus, 'SUCCESS');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a payment stuck PENDING past --wait fails loudly with the payment id (and still debits)', async () => {
    const server = await startServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    const { address, port } = server.address();
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [
            '--require',
            stubPath,
            binPath,
            'l402-pay',
            `http://${address}:${port}/resource`,
            '--spark',
            '--no-store',
            '--wait',
            '1',
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              SPARK_MNEMONIC: 'test seed words for the stub',
              BREEZ_API_KEY: 'breez-test-key',
              SPARK_STUB_STATUS: 'PENDING',
              // no SPARK_STUB_SETTLE_AFTER_POLLS: getPayment never settles
              BLINK_SPARK_POLL_INTERVAL_MS: '25',
            },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }),
        );
      });
      assert.ok(result.err && result.err.code !== 0, 'must exit non-zero');
      assert.match(result.stderr, /still PENDING after 1s/);
      assert.match(result.stderr, /token was NOT captured/);
      assert.match(result.stderr, /spark-1/, 'names the payment id for spark-transactions follow-up');
      assert.match(result.stderr, /retrying pays again/);
      const log = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'spending-log.json'), 'utf8'));
      assert.equal(log.length, 1, 'the in-flight sats are debited — they are spent');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('direct node invocation of l402_pay.js terminates promptly after a spark payment', async () => {
    // The require.main runner path (not bin/blink.js) — the SDK's event-loop
    // handles must not hang a direct spark invocation after output is printed.
    const server = await startServer();
    const { address, port } = server.address();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    const scriptPath = path.resolve(__dirname, '..', 'blink', 'scripts', 'l402_pay.js');
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, scriptPath, `http://${address}:${port}/resource`, '--spark', '--no-store'],
          {
            env: {
              ...process.env,
              HOME: home,
              SPARK_MNEMONIC: 'test seed words for the stub',
              BREEZ_API_KEY: 'breez-test-key',
            },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout, stderr) =>
            resolve({ err, code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr }),
        );
      });
      assert.ok(!result.err || !result.err.killed, 'direct invocation must terminate promptly');
      assert.equal(result.code, 0);
      const j = JSON.parse(result.stdout);
      assert.equal(j.event, 'l402_paid');
      assert.equal(j.backend, 'spark');
      assert.equal(j.paymentStatus, 'SUCCESS');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('cached-token reuse emits the persisted backend field', async () => {
    const server = await startServer();
    const { address, port } = server.address();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-cli-l402-'));
    fs.mkdirSync(path.join(home, '.blink'), { recursive: true });
    const store = {};
    // extractStoreKey = hostname + pathname (no port)
    store[`127.0.0.1/resource`] = {
      macaroon: 'MAC',
      preimage: 'f'.repeat(64),
      invoice: 'lnbc1000u1p0x',
      satoshis: 100000,
      invoiceMsats: 100000000,
      budgetSats: 100000,
      backend: 'spark',
    };
    fs.writeFileSync(path.join(home, '.blink', 'l402-tokens.json'), JSON.stringify(store), 'utf8');
    try {
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, binPath, 'l402-pay', `http://127.0.0.1:${port}/resource`],
          { env: { ...process.env, HOME: home }, timeout: 15000, killSignal: 'SIGKILL' },
          (err, stdout, stderr) =>
            resolve({ err, code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr }),
        );
      });
      if (result.code !== 0) process.stderr.write('DEBUG-REUSE ' + result.stderr + '\n');
      assert.equal(result.code, 0);
      const j = JSON.parse(result.stdout);
      assert.equal(j.tokenReused, true);
      assert.equal(j.backend, 'spark');
    } finally {
      server.close();
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
