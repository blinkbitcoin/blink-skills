/**
 * v3.0.4: strict option parsing on EVERY script with a CLI-argument loop.
 *
 * v3.0.3 made the money-moving scripts strict (PR #26 review: a hand-rolled
 * loop that ignores what it doesn't recognize turned `--dry-run=true` into a
 * real payment). The rest still ignored or misread malformed options — most
 * consequentially `spark-lnaddress delete --network=regtest`, which parsed
 * `--network=regtest` as the (unused) username and DELETED THE MAINNET
 * ADDRESS. Every script now runs strictArgv (node:util parseArgs, strict),
 * like the `blink` CLI; free-text memos go after `--`.
 *
 * Run: node --test test/strict_args.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');
const binPath = path.resolve(__dirname, '..', 'bin', 'blink.js');
const load = (name) => require(path.join(scriptsDir, name));
const PARSE_ERROR = /Unknown option|does not take an argument|argument missing/;

// ── Parsers: malformed options refused, `--opt=value` honored ────────────────

describe('spark_lnaddress (the state-changing one)', () => {
  const { parseArgs } = load('spark_lnaddress.js');

  it('`delete --network=regtest` targets REGTEST (it used to delete on mainnet)', () => {
    const a = parseArgs(['delete', '--network=regtest']);
    assert.equal(a.subcommand, 'delete');
    assert.equal(a.network, 'regtest');
    assert.equal(a.username, null, 'the option is not misread as a username');
  });

  it('`get --network=regtest` reads regtest', () => {
    assert.equal(parseArgs(['get', '--network=regtest']).network, 'regtest');
  });

  it('a valueless --network and an unknown option are refused', () => {
    assert.throws(
      () => parseArgs(['get', '--network']),
      (e) => e.code === 'ARG_INVALID',
    );
    assert.throws(
      () => parseArgs(['register', 'alice', '--networks', 'regtest']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('control: the split form still works', () => {
    const a = parseArgs(['register', 'alice', '--network', 'regtest', '--description', 'hi']);
    assert.deepEqual([a.subcommand, a.username, a.network, a.description], ['register', 'alice', 'regtest', 'hi']);
  });
});

describe('the other Spark scripts honor --network=… and refuse junk', () => {
  for (const name of ['spark_balance.js', 'spark_info.js', 'spark_subscribe.js']) {
    it(name, () => {
      const { parseArgs } = load(name);
      assert.equal(parseArgs(['--network=regtest']).network, 'regtest');
      assert.throws(
        () => parseArgs(['--network']),
        (e) => e.code === 'ARG_INVALID',
      );
      assert.throws(
        () => parseArgs(['--bogus']),
        (e) => e.code === 'ARG_INVALID',
      );
    });
  }

  it('spark_token_info', () => {
    const { parseArgs } = load('spark_token_info.js');
    assert.deepEqual(parseArgs(['usdb', '--network=regtest']), { token: 'usdb', network: 'regtest' });
    assert.throws(
      () => parseArgs(['usdb', '--bogus']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('spark_transactions', () => {
    const { parseArgs } = load('spark_transactions.js');
    const a = parseArgs(['--limit=5', '--type=send', '--network=regtest']);
    assert.deepEqual([a.limit, a.type, a.network], [5, 'send', 'regtest']);
    assert.throws(
      () => parseArgs(['--limits', '5']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('spark_receive_token: extra words after `--` join the description literally', () => {
    const { parseArgs } = load('spark_receive_token.js');
    const a = parseArgs(['5', '--token=usdb', '--', '-x', 'y']);
    assert.deepEqual([a.amount, a.token, a.description], ['5', 'usdb', '-x y']);
    assert.throws(
      () => parseArgs(['5', '--base-units=true']),
      (e) => e.code === 'ARG_INVALID',
    );
  });
});

describe('invoice / subscription / listing scripts', () => {
  it('create_invoice: a memo word like `-50%` works after `--`; a typo is no longer swallowed as memo', () => {
    const { parseArgs } = load('create_invoice.js');
    const a = parseArgs(['10', '--no-subscribe', '--', '-50%', 'off']);
    assert.deepEqual([a.amountSats, a.noSubscribe, a.memo], [10, true, '-50% off']);
    // Before: `--no-sub` became memo text and the subscription still ran.
    assert.throws(
      () => parseArgs(['10', 'Coffee', '--no-sub']),
      (e) => e.code === 'ARG_INVALID',
    );
    assert.equal(parseArgs(['10', '--timeout=60']).timeoutSeconds, 60);
  });

  it('create_invoice_usd', () => {
    const { parseArgs } = load('create_invoice_usd.js');
    const a = parseArgs(['100', '--timeout=5', '--', '--literal', 'memo']);
    assert.deepEqual([a.amountCents, a.timeoutSeconds, a.memo], [100, 5, '--literal memo']);
    assert.throws(
      () => parseArgs(['100', '--no-subscribe=yes']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('create_invoice_lnaddress', () => {
    const { parseArgs } = load('create_invoice_lnaddress.js');
    const a = parseArgs(['alice@blink.sv', '10', '--no-verify', '--', '--weird', 'memo']);
    assert.deepEqual([a.address, a.amountSats, a.noVerify, a.memo], ['alice@blink.sv', 10, true, '--weird memo']);
    assert.throws(
      () => parseArgs(['alice@blink.sv', '10', '--qr=1']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('subscribe_invoice / subscribe_updates', () => {
    assert.equal(load('subscribe_invoice.js').parseArgs(['lnbc1', '--timeout=9']).timeoutSeconds, 9);
    const u = load('subscribe_updates.js').parseArgs(['--timeout=3', '--max=2']);
    assert.deepEqual([u.timeoutSeconds, u.maxCount], [3, 2]);
    assert.throws(
      () => load('subscribe_updates.js').parseArgs(['--maxx', '2']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('transactions', () => {
    const { parseArgs } = load('transactions.js');
    const a = parseArgs(['--first=5', '--wallet=USD', '--include-preimage']);
    assert.deepEqual([a.first, a.wallet, a.includePreimage], [5, 'USD', true]);
    assert.throws(
      () => parseArgs(['--include-preimage=yes']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('l402_discover', () => {
    const { parseArgs } = load('l402_discover.js');
    const a = parseArgs(['https://x.example/', '--method=POST', '--header=X-A:1', '--header', 'X-B:2']);
    assert.deepEqual([a.url, a.method, a.headers], ['https://x.example/', 'POST', { 'X-A': '1', 'X-B': '2' }]);
    assert.throws(
      () => parseArgs(['https://x.example/', '--metod', 'POST']),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('swap (already fail-closed) now also takes `--opt=value` and options before positionals', () => {
    const { parseCommonSwapArgs } = load('_swap_common.js');
    assert.equal(parseCommonSwapArgs(['usd-to-btc', '500', '--unit=cents']).unit, 'cents');
    assert.equal(parseCommonSwapArgs(['--unit', 'cents', 'usd-to-btc', '500']).direction, 'USD_TO_BTC');
    assert.match(parseCommonSwapArgs(['usd-to-btc', '500', '--dry-run=true']).error, PARSE_ERROR);
  });
});

// ── Direct invocation: refused before ANY network / credential / SDK work ────

describe('direct invocation refuses an unknown option before anything is sent', () => {
  function run(script, args) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-strict-sweep-'));
    return new Promise((resolve) =>
      execFile(
        process.execPath,
        [path.join(scriptsDir, script), ...args],
        {
          env: {
            ...process.env,
            HOME: home,
            BLINK_API_KEY: 'blink_test',
            BLINK_API_URL: 'http://127.0.0.1:9/graphql',
            SPARK_MNEMONIC: '',
            BREEZ_API_KEY: '',
          },
          timeout: 15000,
        },
        (err, stdout, stderr) => {
          fs.rmSync(home, { recursive: true, force: true });
          resolve({ code: err ? err.code : 0, stderr });
        },
      ),
    );
  }

  for (const [script, args] of [
    ['spark_lnaddress.js', ['delete', '--bogus']],
    ['spark_balance.js', ['--bogus']],
    ['spark_info.js', ['--bogus']],
    ['spark_token_info.js', ['usdb', '--bogus']],
    ['spark_subscribe.js', ['--bogus']],
    ['spark_transactions.js', ['--bogus']],
    ['spark_receive_token.js', ['5', '--bogus']],
    ['create_invoice.js', ['10', '--bogus']],
    ['create_invoice_usd.js', ['100', '--bogus']],
    ['create_invoice_lnaddress.js', ['alice@blink.sv', '10', '--bogus']],
    ['subscribe_invoice.js', ['lnbc1', '--bogus']],
    ['subscribe_updates.js', ['--bogus']],
    ['transactions.js', ['--bogus']],
    ['l402_discover.js', ['https://x.example/', '--bogus']],
    ['swap_execute.js', ['btc-to-usd', '1000', '--bogus']],
  ]) {
    it(`${script} ${args.join(' ')}`, async () => {
      const res = await run(script, args);
      assert.equal(res.code, 1, res.stderr);
      assert.match(res.stderr, PARSE_ERROR);
      assert.doesNotMatch(res.stderr, /fetch failed|ECONNREFUSED|SPARK_MNEMONIC|BREEZ_API_KEY|WebSocket/);
    });
  }
});

// ── CLI → script forwarding still works (guards the `--` memo handoff) ───────

describe('blink CLI forwards a dash-leading memo intact', () => {
  it('`blink create-invoice 10 --no-subscribe -- -50% off` gets past parsing (to the network)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-strict-cli-'));
    const res = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [binPath, 'create-invoice', '10', '--no-subscribe', '--', '-50%', 'off'],
        {
          env: { ...process.env, HOME: home, BLINK_API_KEY: 'blink_test', BLINK_API_URL: 'http://127.0.0.1:9/graphql' },
          timeout: 20000,
        },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }),
      ),
    );
    fs.rmSync(home, { recursive: true, force: true });
    assert.doesNotMatch(res.stderr, PARSE_ERROR, 'the memo must not be parsed as an option');
    assert.match(res.stderr, /fetch failed|ECONNREFUSED|request failed/i, 'it reached the (unroutable) API');
  });
});

// ── Repo-wide guards ─────────────────────────────────────────────────────────

describe('guards', () => {
  it('every script with a CLI-argument loop parses through strictArgv', () => {
    const offenders = [];
    for (const file of fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      const loops = /(?:argv\[i\]|\barg\b) === '--[a-z]/.test(src);
      if (loops && !/strictArgv\(/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  it('every flag bin/blink.js forwards to a script is declared in that script’s ARG_OPTIONS', () => {
    const src = fs.readFileSync(binPath, 'utf8');
    const problems = [];
    for (const m of src.matchAll(/commands\['([a-z0-9-]+)'\] = \{([\s\S]*?)\n\};/g)) {
      const [, cmd, block] = m;
      const action = block.split('action:')[1] || '';
      const req = action.match(/scriptsDir, '([a-z0-9_]+\.js)'/);
      if (!req) continue;
      const forwarded = [...new Set([...action.matchAll(/'--([a-z][a-z0-9-]*)'/g)].map((x) => x[1]))];
      if (forwarded.length === 0) continue;
      const mod = load(req[1]);
      if (!mod.ARG_OPTIONS) {
        problems.push(`${cmd} → ${req[1]}: no ARG_OPTIONS export`);
        continue;
      }
      for (const f of forwarded) if (!mod.ARG_OPTIONS[f]) problems.push(`${cmd} → ${req[1]}: --${f} undeclared`);
    }
    assert.deepEqual(problems, []);
  });
});

// ── Spark dry-run banner (FT9 note 1) ────────────────────────────────────────
//
// A dry run printed "⚠️ NON-CUSTODIAL SEND: … spends real bitcoin" although it
// only prepares — nothing is signed or sent. The banner prints before the SDK
// connects, so a connect stub that throws is enough to observe it.
describe('spark_send banner', () => {
  const sparkSdkPath = require.resolve(path.join(scriptsDir, '_spark_sdk.js'));
  const sendPath = require.resolve(path.join(scriptsDir, 'spark_send.js'));

  async function bannerFor(argv) {
    const saved = { cache: require.cache[sparkSdkPath], error: console.error, argv: process.argv };
    require.cache[sparkSdkPath] = {
      id: sparkSdkPath,
      filename: sparkSdkPath,
      loaded: true,
      exports: {
        connect: async () => {
          throw new Error('STOP_AFTER_BANNER');
        },
        feeFromPrepare: () => null,
        safeErrorDetail: (e) => String(e),
        resolveTokenIdentifier: async (t) => t,
        parseTokenAmount: (a) => a,
      },
    };
    delete require.cache[sendPath];
    let err = '';
    console.error = (s) => {
      err += `${s}\n`;
    };
    process.argv = [process.execPath, 'spark_send.js', ...argv];
    try {
      await assert.rejects(require(sendPath).main(), /STOP_AFTER_BANNER/);
    } finally {
      console.error = saved.error;
      process.argv = saved.argv;
      if (saved.cache) require.cache[sparkSdkPath] = saved.cache;
      else delete require.cache[sparkSdkPath];
      delete require.cache[sendPath];
    }
    return err;
  }

  it('a dry run says DRY RUN — not "spends real bitcoin"', async () => {
    const err = await bannerFor(['alice@blink.sv', '100', '--dry-run']);
    assert.match(err, /DRY RUN/);
    assert.doesNotMatch(err, /spends real bitcoin|moves real funds/);
  });

  it('a token dry run says DRY RUN too', async () => {
    const err = await bannerFor(['spark1abc', '1', '--token', 'usdb', '--dry-run']);
    assert.match(err, /DRY RUN/);
    assert.doesNotMatch(err, /moves real funds/);
  });

  it('control: a real send keeps the warning', async () => {
    const err = await bannerFor(['alice@blink.sv', '100']);
    assert.match(err, /NON-CUSTODIAL SEND: this signs a transaction with your account seed and spends real bitcoin/);
  });
});

// ── writeSecureFileAtomic temp file (ClawHub 3.0.3 ClawScan note) ───────────
//
// The atomic writer used a PREDICTABLE temp name (`<file>.<pid>.tmp`) opened
// without exclusive creation, so a symlink planted there would redirect the
// write of a 0600 state file (tokens, budget, root key) to its target. Now the
// temp name is random and created exclusively (O_EXCL), which also refuses a
// pre-existing symlink.
describe('writeSecureFileAtomic temp file', () => {
  const { writeSecureFileAtomic } = require(path.join(scriptsDir, '_secure_files.js'));

  it('a symlink planted at the predictable temp path never redirects the write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-atomic-'));
    try {
      const file = path.join(dir, 'l402-tokens.json');
      const target = path.join(dir, 'victim.txt');
      fs.writeFileSync(target, 'untouched');
      fs.symlinkSync(target, `${file}.${process.pid}.tmp`); // the old, predictable name
      writeSecureFileAtomic(file, '{"ok":true}');
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched', 'the symlink target was not written');
      assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
