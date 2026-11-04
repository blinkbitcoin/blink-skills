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

// ── negated options (PR #23 review: the engines floor) ───────────────────────
//
// `--no-<opt>` relies on util.parseArgs({ allowNegative: true }), which only
// exists from Node 22.4.0 — that is what sets `engines >=22.4.0`. On 22.0–22.3
// strict parsing rejects these with "Unknown option". The non-numeric amount
// makes each command fail in coercion, which runs AFTER parseArgs, so reaching
// that error proves the negation parsed — with no network and no credentials.
// This is the test that turns red if the suite is run below the floor.

describe('CLI: documented negated options parse (Node 22.4+ floor)', () => {
  for (const args of [
    ['create-invoice', 'abc', '--no-subscribe'],
    ['create-invoice-usd', 'abc', '--no-subscribe'],
    ['create-invoice-lnaddress', 'user@blink.sv', 'abc', '--no-verify'],
  ]) {
    it(`${args[0]} accepts ${args[args.length - 1]}`, async () => {
      const { code, stderr } = await runCli(args, { stub: false });
      assert.doesNotMatch(stderr, /Unknown option/);
      assert.match(stderr, /'amount' must be a positive integer/);
      assert.equal(code, 1);
    });
  }

  // The inverse hazard (PR #23 review, High): with allowNegative, an option
  // DECLARED with a literal `no-` name is shadowed — `--no-x` parses as the
  // negation of a phantom `x`, so the declared option silently stays false.
  // Negatable options must be declared positive (`store`, default true) and
  // documented as `--no-store`. Scans every command's real --help output.
  it('no command declares a literal --no-* option (allowNegative would shadow it)', async () => {
    const { stdout } = await runCli(['--help'], { stub: false });
    const names = [...stdout.matchAll(/^ {2}([a-z][a-z0-9-]+) {2,}/gm)].map((m) => m[1]);
    assert.ok(names.length >= 30, `expected the full command list, got ${names.length}`);
    const offenders = [];
    await Promise.all(
      names.map(async (name) => {
        const help = await runCli([name, '--help'], { stub: false });
        assert.equal(help.code, 0, `${name} --help`);
        for (const m of help.stdout.matchAll(/^ {2}(--no-[a-z0-9-]+)/gm)) offenders.push(`${name} ${m[1]}`);
      }),
    );
    assert.deepEqual(offenders, []);
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
    // Security-audit fix: the domain allowlist now gates ALL non-dry-run
    // l402-pay outbound requests (pre-flight), not only payments — cached-token
    // reuse to a host that was never allowlisted is refused like any other.
    fs.writeFileSync(
      path.join(home, '.blink', 'budget.json'),
      JSON.stringify({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] }),
    );
    const store = {};
    // Store key = ORIGIN (scheme + host + port) + path — see storeKeyFor.
    store[`http://127.0.0.1:${port}/resource`] = {
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

  // PR #23 review (High): a literal `'no-store'` option is shadowed by
  // parseArgs({ allowNegative }) on Node 22.4+/20.16+ — it parsed as
  // {store:false, 'no-store':false}, so the CLI silently dropped --no-store and
  // cached the macaroon + preimage (a reusable bearer credential) despite the
  // opt-out. Self-validating: the counterfactual run WITHOUT --no-store must
  // persist the token, proving the absence check below can fail.
  it('--no-store reaches l402_pay.js through the CLI and prevents token persistence', async () => {
    const server = await startServer();
    const { address, port } = server.address();
    const pay = async (extra) => {
      const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--require', stubPath, binPath, 'l402-pay', `http://${address}:${port}/resource`, '--spark', ...extra],
          {
            env: { ...process.env, HOME: home, SPARK_MNEMONIC: 'test seed words for the stub', BREEZ_API_KEY: 'k' },
            timeout: 15000,
            killSignal: 'SIGKILL',
          },
          (err, stdout) => resolve({ err, stdout }),
        );
      });
      const storeFile = path.join(home, '.blink', 'l402-tokens.json');
      const stored = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : null;
      fs.rmSync(home, { recursive: true, force: true });
      return { j: JSON.parse(result.stdout), stored };
    };
    try {
      const control = await pay([]);
      assert.equal(control.j.event, 'l402_paid');
      assert.ok(
        control.stored && control.stored[`http://${address}:${port}/resource`],
        'counterfactual: default run persists the token',
      );

      const optedOut = await pay(['--no-store']);
      assert.equal(optedOut.j.event, 'l402_paid');
      assert.equal(optedOut.stored, null, '--no-store must not write ~/.blink/l402-tokens.json');
    } finally {
      server.close();
    }
  });

  // ClawHub review of v3.0.0: the token cache did not preserve service-origin
  // isolation. The key was hostname + path, so a macaroon + preimage paid for at
  // http://127.0.0.1:A/resource was replayed (Authorization header) to an
  // UNPAID service at http://127.0.0.1:B/resource — and likewise across
  // schemes (https → plaintext http). Reproduced before the fix: service B
  // received `L402 TESTMAC==:fff…` and served the request with tokenReused:true.

  /** L402 server that records every Authorization header it receives. */
  function recordingServer() {
    const seen = [];
    let server;
    const ready = new Promise((resolve) => {
      server = http.createServer((req, res) => {
        seen.push(req.headers.authorization || null);
        if (req.headers.authorization) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
        res.end();
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    return ready.then(() => ({ server, seen, port: server.address().port }));
  }

  function payViaRaw(home, port, extra = []) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--require', stubPath, binPath, 'l402-pay', `http://127.0.0.1:${port}/resource`, '--spark', ...extra],
        {
          env: { ...process.env, HOME: home, SPARK_MNEMONIC: 'test seed words for the stub', BREEZ_API_KEY: 'k' },
          timeout: 15000,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024 * 1024, // the piped-stdout tests print multi-MiB JSON
        },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  async function payVia(home, port, extra = []) {
    return JSON.parse((await payViaRaw(home, port, extra)).stdout);
  }

  /**
   * PR #24 review (High): a service that answers the credential-free HEAD
   * canonicalization itself but redirects the REAL request elsewhere. `status`
   * is the redirect code for non-HEAD methods. Records method + every header.
   */
  function headStaysRedirectsElsewhere(targetPort, status = 302) {
    const seen = [];
    let server;
    const ready = new Promise((resolve) => {
      server = http.createServer((req, res) => {
        seen.push({ method: req.method, headers: req.headers });
        if (req.method === 'HEAD') {
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(status, { location: `http://127.0.0.1:${targetPort}/resource` });
        res.end();
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    return ready.then(() => ({ server, seen, port: server.address().port }));
  }

  it('a token paid at one origin is never sent to another origin (different port, same host+path)', async () => {
    const a = await recordingServer();
    const b = await recordingServer();
    const home = seededHome({ dailyLimitSats: 400000, allowlist: ['127.0.0.1'] });
    try {
      const paidA = await payVia(home, a.port);
      assert.equal(paidA.tokenReused, false);

      // Control (self-validation): the SAME origin reuses the token, so the
      // cache works and the cross-origin assertion below can actually fail.
      const reuseA = await payVia(home, a.port);
      assert.equal(reuseA.tokenReused, true, 'same-origin reuse must still work');

      const atB = await payVia(home, b.port);
      assert.equal(atB.tokenReused, false, 'origin B must not reuse origin A’s token');
      assert.equal(atB.event, 'l402_paid', 'origin B is paid for fresh');
      // B's first credentialed request comes only AFTER its own payment: the
      // first two requests (canonicalization HEAD + initial request) carry no
      // Authorization at all.
      assert.deepEqual(b.seen.slice(0, 2), [null, null], 'A’s credential must never reach B');

      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.blink', 'l402-tokens.json'), 'utf8')));
      assert.deepEqual(
        keys.sort(),
        [`http://127.0.0.1:${a.port}/resource`, `http://127.0.0.1:${b.port}/resource`].sort(),
      );
    } finally {
      a.server.close();
      b.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // PR #24 review (High): the cache key and paid-retry target came from the
  // credential-free HEAD canonicalization, but the REAL request can follow a
  // different, method-dependent redirect. A answered HEAD itself, redirected
  // GET to B; B issued the 402. Before the fix: B's macaroon + preimage were
  // stored under A's key and the paid retry went to A FIRST — A received B's
  // credential before cross-origin header stripping could act, on every run.
  // The credential owner is the URL that actually issued the challenge.
  it('a token is bound to the origin that issued the 402, not the HEAD canonical URL (method-dependent redirect)', async () => {
    const b = await recordingServer();
    const a = await headStaysRedirectsElsewhere(b.port);
    const home = seededHome({ dailyLimitSats: 400000, allowlist: ['127.0.0.1'] });
    const aAuth = () => a.seen.filter((r) => r.headers.authorization).length;
    try {
      const first = await payVia(home, a.port);
      assert.equal(first.event, 'l402_paid');
      assert.equal(first.tokenReused, false);
      assert.equal(aAuth(), 0, 'A must never receive the credential B issued');
      assert.equal(first.challengeUrl, `http://127.0.0.1:${b.port}/resource`);
      assert.ok(
        b.seen.some((h) => h && h.startsWith('L402 TESTMAC==:')),
        'B, the issuer, receives its own credential',
      );

      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.blink', 'l402-tokens.json'), 'utf8')));
      assert.deepEqual(keys, [`http://127.0.0.1:${b.port}/resource`], 'stored under the issuing origin only');

      const bCredsBefore = b.seen.filter(Boolean).length;
      const second = await payVia(home, a.port);
      assert.equal(second.tokenReused, true, 'the cached token is reused — at B');
      assert.equal(aAuth(), 0, 'A still never receives it on cache reuse');
      assert.equal(b.seen.filter(Boolean).length, bCredsBefore + 1, 'cache reuse sends it to B exactly once');
    } finally {
      a.server.close();
      b.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('operator headers are withheld from a cross-origin challenge URL on the direct retry', async () => {
    // Guards the NEW direct hop to the challenge URL: in-chain redirects strip
    // operator headers cross-origin, so a direct retry must not reintroduce them.
    const b = http.createServer((req, res) => {
      b.seenHeaders.push(req.headers['x-api-key'] || null);
      if (req.headers.authorization) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
      res.end();
    });
    b.seenHeaders = [];
    await new Promise((r) => b.listen(0, '127.0.0.1', r));
    const a = await headStaysRedirectsElsewhere(b.address().port);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const out = await payVia(home, a.port, ['--header', 'X-Api-Key:operator-secret']);
      assert.equal(out.event, 'l402_paid');
      assert.ok(
        a.seen.some((r) => r.headers['x-api-key'] === 'operator-secret'),
        'A (the supplied origin) gets it',
      );
      assert.deepEqual(b.seenHeaders.filter(Boolean), [], 'B (a different origin) must never receive operator headers');
    } finally {
      a.server.close();
      b.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('an operator body is refused (URL_POLICY) before payment when the 402 came from another origin', async () => {
    // A 302s the POST; WHATWG semantics turn it into a body-less GET at B. Replaying
    // the original POST + body directly to B would disclose it in a form the
    // redirect never produced — refuse, and pay nothing.
    const b = await recordingServer();
    const a = await headStaysRedirectsElsewhere(b.port, 302);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payViaRaw(home, a.port, ['--method', 'POST', '--body', '{"secret":1}']);
      assert.notEqual(res.code, 0);
      assert.match(res.stdout + res.stderr, /URL_POLICY|refusing/i);
      assert.ok(!fs.existsSync(path.join(home, '.blink', 'l402-tokens.json')), 'no token stored');
      const logFile = path.join(home, '.blink', 'spending-log.json');
      const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
      assert.equal(log.length, 0, 'nothing paid');
      assert.equal(a.seen.filter((r) => r.headers.authorization).length, 0);
    } finally {
      a.server.close();
      b.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // PR #24 review round 2 (Medium): the direct credentialed retries rebuilt the
  // request from the ORIGINAL --method/--body, discarding the redirect walker's
  // WHATWG rewrites (301/302 POST→GET, 303 non-GET/HEAD→GET, body dropped).
  // A same-origin POST /start → 302 → GET /resource got the 402, then the paid
  // retry sent POST /resource WITH the body. The retry must repeat exactly the
  // request that was challenged; a dropped operator body is refused pre-payment.

  /**
   * `/start`: HEAD → 200 (canonicalization stays here); any other method →
   * `status` redirect to `/resource` on this server or on `targetPort`.
   * `/resource`: records { method, body, auth } of every request; 402 without
   * a credential, 200 with one.
   */
  function rewriteServer(status, targetPort = null) {
    const hits = [];
    let server;
    const ready = new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (req.url === '/start') {
            res.writeHead(req.method === 'HEAD' ? 200 : status, {
              location: targetPort ? `http://127.0.0.1:${targetPort}/resource` : '/resource',
            });
            res.end();
            return;
          }
          const isL402 = /^L402 /.test(req.headers.authorization || '');
          hits.push({
            method: req.method,
            body,
            auth: isL402 ? req.headers.authorization : null,
            headers: req.headers,
          });
          if (isL402) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
            return;
          }
          res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
          res.end();
        });
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    return ready.then(() => ({ server, hits, port: server.address().port }));
  }

  function payStart(home, port, extra) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--require', stubPath, binPath, 'l402-pay', `http://127.0.0.1:${port}/start`, '--spark', ...extra],
        {
          env: { ...process.env, HOME: home, SPARK_MNEMONIC: 'test seed words for the stub', BREEZ_API_KEY: 'k' },
          timeout: 15000,
          killSignal: 'SIGKILL',
        },
        (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  const credentialed = (hits) => hits.filter((h) => h.auth).map(({ method, body }) => ({ method, body }));

  /**
   * PR #24 review round 3: the invariant behind all three rounds. Every
   * credentialed request must be EXACTLY the uncredentialed request that
   * received the 402 — method, body, and the full header map as the server saw
   * it (incl. the client's own defaults) — plus the L402 Authorization, and
   * nothing else. Any field reconstructed from the original --method/--header/
   * --body instead of replayed fails here.
   */
  function assertReplaysChallenged(hits) {
    const view = ({ method, body, headers }) => {
      const { authorization: _auth, ...rest } = headers;
      return { method, body, headers: rest };
    };
    let challenged = null;
    let checked = 0;
    for (const h of hits) {
      if (!h.auth) {
        challenged = h;
        continue;
      }
      assert.ok(challenged, 'a credentialed request must follow a challenged one');
      assert.deepEqual(view(h), view(challenged), 'credentialed request = challenged request + L402 Authorization');
      assert.match(h.auth, /^L402 TESTMAC==:[0-9a-f]+$/, 'the only Authorization is the L402 bearer');
      checked++;
    }
    assert.ok(checked > 0, 'at least one credentialed request was checked');
  }

  function assertRefusedBeforePayment(home, res, hits) {
    assert.notEqual(res.code, 0, 'must not succeed');
    assert.match(res.stdout + res.stderr, /URL_POLICY|refusing/i);
    assert.ok(!fs.existsSync(path.join(home, '.blink', 'l402-tokens.json')), 'no token stored');
    const logFile = path.join(home, '.blink', 'spending-log.json');
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
    assert.equal(log.length, 0, 'nothing paid');
    assert.deepEqual(credentialed(hits), [], 'no credentialed request');
  }

  for (const [status, method] of [
    [302, 'POST'],
    [301, 'POST'],
    [303, 'PUT'],
  ]) {
    it(`a same-origin ${status} that drops a ${method} --body is refused before payment`, async () => {
      const s = await rewriteServer(status);
      const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
      try {
        const res = await payStart(home, s.port, ['--method', method, '--body', '{"secret":1}']);
        assert.deepEqual(
          { method: s.hits[0].method, body: s.hits[0].body, auth: s.hits[0].auth },
          { method: 'GET', body: '', auth: null },
          'the walker rewrote it to GET',
        );
        assertRefusedBeforePayment(home, res, s.hits);
      } finally {
        s.server.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('a body-less DELETE rewritten by a same-origin 303 is retried as GET — paid and on cache reuse', async () => {
    const s = await rewriteServer(303);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const first = await payStart(home, s.port, ['--method', 'DELETE']);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(JSON.parse(first.stdout).event, 'l402_paid');
      const second = await payStart(home, s.port, ['--method', 'DELETE']);
      assert.equal(JSON.parse(second.stdout).tokenReused, true);
      assert.deepEqual(credentialed(s.hits), [
        { method: 'GET', body: '' },
        { method: 'GET', body: '' },
      ]);
      assertReplaysChallenged(s.hits);
    } finally {
      s.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a body-less POST rewritten by a cross-origin 302 is retried at the issuer as GET', async () => {
    const b = await rewriteServer(302);
    const a = await rewriteServer(302, b.port);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payStart(home, a.port, ['--method', 'POST']);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).event, 'l402_paid');
      assert.deepEqual(a.hits, [], 'A only redirects; its /resource is never hit');
      assert.deepEqual(credentialed(b.hits), [{ method: 'GET', body: '' }]);
      assertReplaysChallenged(b.hits);
    } finally {
      a.server.close();
      b.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('control: a same-origin 307 preserves POST + body, and so does the credentialed retry', async () => {
    const s = await rewriteServer(307);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payStart(home, s.port, ['--method', 'POST', '--body', '{"x":1}']);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).event, 'l402_paid');
      assert.deepEqual(credentialed(s.hits), [{ method: 'POST', body: '{"x":1}' }]);
      assertReplaysChallenged(s.hits);
    } finally {
      s.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // PR #24 review round 3 (Medium): the retries rebuilt operator headers from
  // --header, but the walker's header state evolves too: a cross-origin hop
  // clears it for the rest of the chain (A → B → A ends at A with NONE), and a
  // rewrite strips body-associated headers. The paid retry reattached them.

  it('A → B → A: operator headers cleared mid-chain are not reattached (paid and cache reuse)', async () => {
    // A: HEAD /start → 200; GET /start → 302 B/middle; /resource records.
    // B: /middle → 302 back to A/resource.
    const hits = [];
    let aPort;
    const b = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${aPort}/resource` });
      res.end();
    });
    await new Promise((r) => b.listen(0, '127.0.0.1', r));
    const a = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/start') {
          res.writeHead(req.method === 'HEAD' ? 200 : 302, {
            location: `http://127.0.0.1:${b.address().port}/middle`,
          });
          res.end();
          return;
        }
        const isL402 = /^L402 /.test(req.headers.authorization || '');
        hits.push({ method: req.method, body, auth: isL402 ? req.headers.authorization : null, headers: req.headers });
        if (isL402) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
        res.end();
      });
    });
    await new Promise((r) => a.listen(0, '127.0.0.1', r));
    aPort = a.address().port;
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const first = await payStart(home, aPort, ['--header', 'X-Operator-Marker:1']);
      assert.equal(JSON.parse(first.stdout).event, 'l402_paid', first.stderr);
      const second = await payStart(home, aPort, ['--header', 'X-Operator-Marker:1']);
      assert.equal(JSON.parse(second.stdout).tokenReused, true);
      assert.ok(
        hits.every((h) => !('x-operator-marker' in h.headers)),
        'the marker was cleared at A → B and must never reappear at A/resource',
      );
      assertReplaysChallenged(hits);
    } finally {
      a.close();
      b.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a rewrite that strips body headers is replayed without them (body-less POST + Content-Type, 302)', async () => {
    const s = await rewriteServer(302);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payStart(home, s.port, ['--method', 'POST', '--header', 'Content-Type:application/json']);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(
        s.hits.every((h) => !('content-type' in h.headers)),
        'the GET the walker produced carries no Content-Type, nor may its replay',
      );
      assertReplaysChallenged(s.hits);
    } finally {
      s.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('an operator Authorization header never overrides or joins the paid L402 bearer', async () => {
    const s = await rewriteServer(307);
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payStart(home, s.port, ['--header', 'authorization:Bearer operator-token']);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).event, 'l402_paid');
      const creds = s.hits.filter((h) => h.auth);
      assert.equal(creds.length, 1);
      assert.match(creds[0].auth, /^L402 TESTMAC==:[0-9a-f]+$/, 'only the L402 bearer, no operator value');
      assert.match(res.stderr, /Authorization/i, 'the dropped operator header is reported on stderr');
    } finally {
      s.server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // PR #25 review: the new failure events must reach a PIPED stdout intact
  // through the real CLI (no hard process.exit racing the write). The server
  // kills the connection on the credentialed request, as in FT7.
  it('a connection killed after payment yields complete l402_paid_retry_failed JSON on piped stdout, exit 1', async () => {
    const server = http.createServer((req, res) => {
      if (/^L402 /.test(req.headers.authorization || '')) {
        req.socket.destroy();
        return;
      }
      res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payViaRaw(home, server.address().port);
      assert.equal(res.code, 1, res.stderr);
      const out = JSON.parse(res.stdout); // throws if truncated or empty
      assert.equal(out.event, 'l402_paid_retry_failed');
      assert.equal(out.backend, 'spark');
      assert.equal(out.tokenStored, true);
      assert.ok(out.error && out.error.length > 0);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // PR #25 review round 4 (Medium): the non-200 branches printed JSON and then
  // called process.exit(1), which can cut a PIPED stdout mid-write. The output
  // includes the server's body (`data`), so a large body made it deterministic:
  // the agent got truncated, unparseable JSON — after money moved, on the paid path.
  const BIG = 'x'.repeat(4 * 1024 * 1024); // far past the pipe buffer

  function bigErrorServer() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (/^L402 /.test(req.headers.authorization || '')) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: BIG }));
          return;
        }
        res.writeHead(402, { 'www-authenticate': 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0x"' });
        res.end();
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  it('a cached token answered with a large non-200 yields COMPLETE l402_error JSON on piped stdout, exit 1', async () => {
    const server = await bigErrorServer();
    const { port } = server.address();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    fs.writeFileSync(
      path.join(home, '.blink', 'l402-tokens.json'),
      JSON.stringify({
        [`http://127.0.0.1:${port}/resource`]: { macaroon: 'TESTMAC==', preimage: 'f'.repeat(64), satoshis: 100000 },
      }),
      'utf8',
    );
    try {
      const res = await payViaRaw(home, port);
      assert.equal(res.code, 1, res.stderr.slice(0, 500));
      const out = JSON.parse(res.stdout); // throws if truncated
      assert.equal(out.event, 'l402_error');
      assert.equal(out.tokenReused, true);
      assert.equal(out.status, 500);
      assert.equal(out.data.error.length, BIG.length, 'the whole body arrived');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a paid retry answered with a large non-200 yields COMPLETE l402_paid JSON on piped stdout, exit 1', async () => {
    const server = await bigErrorServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    try {
      const res = await payViaRaw(home, server.address().port);
      assert.equal(res.code, 1, res.stderr.slice(0, 500));
      const out = JSON.parse(res.stdout); // throws if truncated
      assert.equal(out.event, 'l402_paid');
      assert.equal(out.paymentStatus, 'SUCCESS', 'money moved — the agent must see it');
      assert.equal(out.tokenReused, false);
      assert.equal(out.data.error.length, BIG.length, 'the whole body arrived');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a pre-3.0.1 host+path cache entry is never sent (origin unknown) — fresh payment instead', async () => {
    const s = await recordingServer();
    const home = seededHome({ dailyLimitSats: 200000, allowlist: ['127.0.0.1'] });
    fs.writeFileSync(
      path.join(home, '.blink', 'l402-tokens.json'),
      JSON.stringify({ '127.0.0.1/resource': { macaroon: 'LEGACYMAC', preimage: 'e'.repeat(64), satoshis: 100000 } }),
      'utf8',
    );
    try {
      const out = await payVia(home, s.port);
      assert.equal(out.tokenReused, false);
      assert.ok(!s.seen.some((h) => h && h.includes('LEGACYMAC')), 'the legacy credential must never be sent');
      const store = JSON.parse(fs.readFileSync(path.join(home, '.blink', 'l402-tokens.json'), 'utf8'));
      assert.ok(store['127.0.0.1/resource'], 'legacy entry is kept (ignored, not deleted)');
    } finally {
      s.server.close();
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
