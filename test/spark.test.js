/**
 * Unit tests for the non-custodial (Spark) layer: _spark_sdk.js helpers and
 * the spark_send fee/arg helpers.
 *
 * The Breez SDK (@breeztech/breez-sdk-spark) is NOT installed in CI; these
 * tests exercise only the pure helpers and arg parsing, and assert that the
 * SDK loader fails with a clear, actionable message when the dep is absent.
 *
 * Run: node --test test/spark.test.js
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const spark = require('../blink/scripts/_spark_sdk');
const {
  parseArgs: parseSendArgs,
  feeFromPrepare,
  isLnurlPayInput,
  lnurlPayRequestFrom,
} = require('../blink/scripts/spark_send');

// ── getMnemonic (env-only, never rc files) ────────────────────────────────────

describe('_spark_sdk.getMnemonic', () => {
  it('throws when SPARK_MNEMONIC is unset', () => {
    const saved = process.env.SPARK_MNEMONIC;
    delete process.env.SPARK_MNEMONIC;
    try {
      assert.throws(() => spark.getMnemonic(), /SPARK_MNEMONIC not set/);
    } finally {
      if (saved !== undefined) process.env.SPARK_MNEMONIC = saved;
    }
  });

  it('rejects a seed that is not 12 or 24 words', () => {
    const saved = process.env.SPARK_MNEMONIC;
    process.env.SPARK_MNEMONIC = 'one two three';
    try {
      assert.throws(() => spark.getMnemonic(), /12 or 24 word/);
    } finally {
      if (saved !== undefined) process.env.SPARK_MNEMONIC = saved;
      else delete process.env.SPARK_MNEMONIC;
    }
  });

  it('rejects a 12-word seed with an invalid BIP39 checksum', () => {
    // "abandon" x12 has a valid word count and valid words, but the checksum
    // demands "about" as the 12th. This is the mistyped-word case that would
    // otherwise silently derive a different, empty wallet.
    //
    // Review finding #2: this used to accept the seed when `bip39` was absent,
    // because "validator unavailable" and "seed is fine" were the same return
    // value. Whichever way the dependency falls, the seed must NOT be accepted.
    const saved = process.env.SPARK_MNEMONIC;
    process.env.SPARK_MNEMONIC = new Array(12).fill('abandon').join(' ');
    try {
      assert.throws(
        () => spark.getMnemonic(),
        (e) => e.code === 'MNEMONIC_INVALID_CHECKSUM' || e.code === 'MNEMONIC_VALIDATOR_UNAVAILABLE',
        'an invalid-checksum seed must never be returned, validator present or not',
      );
    } finally {
      if (saved !== undefined) process.env.SPARK_MNEMONIC = saved;
      else delete process.env.SPARK_MNEMONIC;
    }
  });

  it('fails closed when the bip39 validator cannot be loaded', (t) => {
    // Simulate the --omit=optional install: make require('bip39') throw, and
    // assert we abort rather than proceeding unverified.
    const Module = require('node:module');
    const realResolve = Module._resolveFilename;
    // Resolve (and evict) BEFORE patching — afterwards the path is unresolvable.
    const bip39Path = require.resolve('bip39');
    delete require.cache[bip39Path];
    t.after(() => {
      Module._resolveFilename = realResolve;
      delete require.cache[bip39Path];
    });
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'bip39') {
        const e = new Error("Cannot find module 'bip39'");
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      return realResolve.call(this, request, ...rest);
    };

    assert.throws(
      () =>
        spark.validateMnemonicChecksum(
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        ),
      (e) => e.code === 'MNEMONIC_VALIDATOR_UNAVAILABLE',
      'a missing validator must abort, not silently pass',
    );
  });

  it('never returns false — it returns true or throws', () => {
    // The vulnerability was a falsy return being treated as "no problem" by the
    // caller. Pin the contract so it cannot regress into a tri-state.
    const valid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    assert.equal(spark.validateMnemonicChecksum(valid), true);
  });

  it('never includes the mnemonic in the checksum failure message', () => {
    const secret = new Array(12).fill('abandon').join(' ');
    try {
      spark.validateMnemonicChecksum(secret);
    } catch (err) {
      assert.equal(err.message.includes('abandon'), false);
    }
  });

  it('accepts and normalizes a 12-word seed', () => {
    const saved = process.env.SPARK_MNEMONIC;
    process.env.SPARK_MNEMONIC =
      '  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about  ';
    try {
      const m = spark.getMnemonic();
      assert.equal(m.split(' ').length, 12);
      assert.equal(m.startsWith('abandon'), true);
    } finally {
      if (saved !== undefined) process.env.SPARK_MNEMONIC = saved;
      else delete process.env.SPARK_MNEMONIC;
    }
  });
});

// ── storageDirFor (stable, non-reversible) ────────────────────────────────────

describe('_spark_sdk.storageDirFor', () => {
  it('is deterministic for the same seed + network', () => {
    const a = spark.storageDirFor('seed words here', 'mainnet');
    const b = spark.storageDirFor('seed words here', 'mainnet');
    assert.equal(a, b);
  });

  it('differs by seed', () => {
    const a = spark.storageDirFor('seed one', 'mainnet');
    const b = spark.storageDirFor('seed two', 'mainnet');
    assert.notEqual(a, b);
  });

  it('does not embed the raw seed in the path', () => {
    const dir = spark.storageDirFor('super secret seed phrase', 'mainnet');
    assert.equal(dir.includes('super secret'), false);
  });
});

// ── wallet-state directory permissions (review finding #4) ──────────────────

describe('_spark_sdk.ensureOwnerOnlyDir', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const pathMod = require('node:path');

  function modeOf(dir) {
    return fs.statSync(dir).mode & 0o777;
  }

  it('creates the wallet dir owner-only (0700)', (t) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-')) + '/wallet';
    t.after(() => fs.rmSync(pathMod.dirname(dir), { recursive: true, force: true }));
    spark.ensureOwnerOnlyDir(dir);
    assert.equal(modeOf(dir), 0o700, 'a seed-controlled wallet dir must not be group/other accessible');
  });

  it('tightens an existing permissive dir on the next connect', (t) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.chmodSync(dir, 0o755); // simulate an earlier permissive creation
    spark.ensureOwnerOnlyDir(dir);
    assert.equal(modeOf(dir), 0o700, 'must repair a pre-existing permissive dir');
  });

  // Fail-closed: a chmod failure must NOT be swallowed while the dir stays
  // permissive — connect() would then write seed-controlled state into it.
  it('fails closed when chmod cannot make the dir owner-only', (t) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.chmodSync(dir, 0o777); // permissive starting point

    const realChmod = fs.chmodSync;
    t.after(() => {
      fs.chmodSync = realChmod;
    });
    fs.chmodSync = () => {
      throw new Error('EPERM: operation not permitted');
    };

    assert.throws(
      () => spark.ensureOwnerOnlyDir(dir),
      (e) => e.code === 'SPARK_STORAGE_PERMISSIONS',
      'a chmod failure on a permissive dir must be a hard error, not a silent pass',
    );
  });

  it('rejects a symlink at the wallet-state path', (t) => {
    const base = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const real = pathMod.join(base, 'real');
    fs.mkdirSync(real);
    const link = pathMod.join(base, 'wallet');
    fs.symlinkSync(real, link);
    assert.throws(
      () => spark.ensureOwnerOnlyDir(link),
      (e) => e.code === 'SPARK_STORAGE_PERMISSIONS' && /symlink/.test(e.message),
    );
  });

  it('rejects a non-directory at the wallet-state path', (t) => {
    const base = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const file = pathMod.join(base, 'wallet');
    fs.writeFileSync(file, 'x');
    assert.throws(
      () => spark.ensureOwnerOnlyDir(file),
      (e) => e.code === 'SPARK_STORAGE_PERMISSIONS',
    );
  });
});

// ── loadSdkModule (optional dep may or may not be present) ───────────────────

describe('_spark_sdk.loadSdkModule', () => {
  // The SDK is an optionalDependency, so it may be absent (CI without it,
  // Node < 22) or present. Assert the contract for whichever holds, rather
  // than assuming one — a test that only passes when a dep is missing
  // silently inverts as soon as someone installs it.
  it('either loads the SDK or throws an actionable install error', () => {
    let mod;
    try {
      mod = spark.loadSdkModule();
    } catch (err) {
      assert.match(err.message, /is not installed|npm install/);
      return;
    }
    assert.equal(typeof mod.connect, 'function');
    assert.equal(typeof mod.defaultConfig, 'function');
  });
});

// ── normalizeInfo / normalizePayment ──────────────────────────────────────────

describe('_spark_sdk.normalizeInfo', () => {
  it('coerces BigInt balanceSats to Number', () => {
    assert.deepEqual(spark.normalizeInfo({ balanceSats: 12345n }), { balanceSats: 12345 });
  });
  it('defaults to 0 when missing', () => {
    assert.deepEqual(spark.normalizeInfo({}), { balanceSats: 0 });
  });
});

describe('_spark_sdk.normalizePayment', () => {
  it('reads the SDK v0.18 Payment shape (amount + fees, BigInt)', () => {
    const p = spark.normalizePayment({
      id: 'p1',
      paymentType: 'send',
      status: 'completed',
      amount: 1000n,
      fees: 5n,
      timestamp: 1700000000,
    });
    assert.equal(p.id, 'p1');
    assert.equal(p.type, 'send');
    assert.equal(p.amountSats, 1000);
    assert.equal(p.feeSats, 5); // was previously null due to reading the wrong field
    assert.equal(p.timestamp, 1700000000);
  });

  it('falls back to older field names (amountSats/feesSats)', () => {
    const p = spark.normalizePayment({ paymentType: 'receive', amountSats: 200, feesSats: 0 });
    assert.equal(p.amountSats, 200);
    assert.equal(p.feeSats, 0);
  });

  it('returns null fee when no fee field is present', () => {
    const p = spark.normalizePayment({ amount: 200n });
    assert.equal(p.feeSats, null);
    assert.equal(p.amountSats, 200);
  });
});

describe('_spark_sdk.waitForStableBalance', () => {
  it('returns stable when two consecutive reads agree', async () => {
    let n = 0;
    const sdk = {
      async getInfo() {
        n += 1;
        return { balanceSats: 2200n };
      },
    };
    const r = await spark.waitForStableBalance(sdk, { maxWaitMs: 3000, intervalMs: 1 });
    assert.equal(r.balanceSats, 2200);
    assert.equal(r.stable, true);
    assert.ok(n >= 2, 'polls at least twice to confirm stability');
  });

  it('settles after a transient low read (mid-sync)', async () => {
    const seq = [1176n, 2200n, 2200n];
    let i = 0;
    const sdk = {
      async getInfo() {
        const v = seq[Math.min(i, seq.length - 1)];
        i += 1;
        return { balanceSats: v };
      },
    };
    const r = await spark.waitForStableBalance(sdk, { maxWaitMs: 3000, intervalMs: 1 });
    assert.equal(r.balanceSats, 2200);
    assert.equal(r.stable, true);
  });

  it('returns the last read (stable=false) if it never settles before the cap', async () => {
    let v = 100;
    const sdk = {
      async getInfo() {
        v += 100; // never repeats
        return { balanceSats: BigInt(v) };
      },
    };
    const r = await spark.waitForStableBalance(sdk, { maxWaitMs: 20, intervalMs: 5 });
    assert.equal(r.stable, false);
    assert.equal(typeof r.balanceSats, 'number');
  });
});

// ── spark_send helpers ────────────────────────────────────────────────────────

describe('spark_send.parseArgs', () => {
  it('parses destination + amount', () => {
    const a = parseSendArgs(['lnbc10u1p...', '1000']);
    assert.equal(a.destination, 'lnbc10u1p...');
    assert.equal(a.amountSats, 1000);
    assert.equal(a.dryRun, false);
  });

  it('parses --dry-run and --network', () => {
    const a = parseSendArgs(['alice@blink.sv', '500', '--dry-run', '--network', 'regtest']);
    assert.equal(a.dryRun, true);
    assert.equal(a.network, 'regtest');
  });

  it('rejects a non-positive amount', () => {
    assert.throws(() => parseSendArgs(['dest', '0']), /positive integer/);
  });
});

describe('spark_send.isLnurlPayInput', () => {
  it('detects an lnUrlPay parse result', () => {
    assert.equal(isLnurlPayInput({ type: 'lnUrlPay' }), true);
  });
  it('detects a lightningAddress parse result', () => {
    assert.equal(isLnurlPayInput({ type: 'lightningAddress' }), true);
  });
  it('is case-insensitive', () => {
    assert.equal(isLnurlPayInput({ type: 'LNURLPAY' }), true);
  });
  it('returns false for a bolt11 invoice', () => {
    assert.equal(isLnurlPayInput({ type: 'bolt11Invoice' }), false);
  });
  it('returns false for a spark address', () => {
    assert.equal(isLnurlPayInput({ type: 'sparkAddress' }), false);
  });
  it('returns false for null / missing type', () => {
    assert.equal(isLnurlPayInput(null), false);
    assert.equal(isLnurlPayInput({}), false);
  });
});

describe('spark_send.lnurlPayRequestFrom', () => {
  it('extracts payRequest for a lightningAddress parse result', () => {
    const parsed = {
      type: 'lightningAddress',
      address: 'a@b',
      payRequest: { callback: 'https://x', minSendable: 1000 },
    };
    assert.deepEqual(lnurlPayRequestFrom(parsed), { callback: 'https://x', minSendable: 1000 });
  });
  it('returns the object itself for an lnurlPay parse result (details are top-level)', () => {
    const parsed = { type: 'lnurlPay', callback: 'https://x', minSendable: 1000 };
    assert.deepEqual(lnurlPayRequestFrom(parsed), parsed);
  });
});

describe('spark_send.feeFromPrepare', () => {
  it('reads a top-level feeSats (LNURL prepare response)', () => {
    assert.equal(feeFromPrepare({ feeSats: 7 }), 7);
  });
  it('reads a nested paymentMethod.feeSats (older builds)', () => {
    assert.equal(feeFromPrepare({ paymentMethod: { type: 'bolt11Invoice', feeSats: 4 } }), 4);
  });
  it('reads bolt11 lightningFeeSats', () => {
    assert.equal(feeFromPrepare({ paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 6 } }), 6);
  });
  it('sums lightningFeeSats + sparkTransferFeeSats when both present', () => {
    assert.equal(
      feeFromPrepare({ paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 6, sparkTransferFeeSats: 2 } }),
      8,
    );
  });
  it('reads a sparkAddress string fee', () => {
    assert.equal(feeFromPrepare({ paymentMethod: { type: 'sparkAddress', fee: '3' } }), 3);
  });
  it('returns null when unknown', () => {
    assert.equal(feeFromPrepare({}), null);
    assert.equal(feeFromPrepare(null), null);
    assert.equal(feeFromPrepare({ paymentMethod: {} }), null);
  });
});

// ── spark_send main() branch selection (mocked SDK) ───────────────────────────
//
// We inject a fake `_spark_sdk` module into the require cache so spark_send.js
// runs its full main() against a fake sdk. No real Breez dep, no live calls.
// This proves a Lightning Address routes through prepareLnurlPay/lnurlPay and a
// BOLT-11 invoice routes through prepareSendPayment/sendPayment.

describe('spark_send main() destination routing', () => {
  const sparkSdkPath = require.resolve('../blink/scripts/_spark_sdk');
  const sparkSendPath = require.resolve('../blink/scripts/spark_send');

  let calls;
  let savedArgv;
  let savedLog;
  let savedErr;

  let lastArgs;

  function installMock({ parseType, status = 'COMPLETED' }) {
    calls = [];
    lastArgs = {};
    const fakeSdk = {
      async parse() {
        calls.push('parse');
        // lightningAddress result nests details under payRequest; lnurlPay is flat.
        if (parseType === 'lightningAddress') {
          return { type: parseType, address: 'alice@blink.sv', payRequest: { callback: 'https://blink.sv/cb' } };
        }
        return { type: parseType, callback: 'https://blink.sv/cb' };
      },
      async prepareLnurlPay(req) {
        calls.push('prepareLnurlPay');
        lastArgs.prepareLnurlPay = req;
        return { feeSats: 2 };
      },
      async lnurlPay() {
        calls.push('lnurlPay');
        return { payment: { id: 'ln-1', status } };
      },
      async prepareSendPayment(req) {
        calls.push('prepareSendPayment');
        lastArgs.prepareSendPayment = req;
        return { paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 3 } };
      },
      async sendPayment() {
        calls.push('sendPayment');
        return { payment: { id: 'bolt-1', status } };
      },
    };
    // Replace the cached _spark_sdk module with a fake connect().
    require.cache[sparkSdkPath] = {
      id: sparkSdkPath,
      filename: sparkSdkPath,
      loaded: true,
      exports: {
        async connect() {
          return { sdk: fakeSdk, disconnect: async () => {} };
        },
      },
    };
    // Force spark_send to be re-required so it binds to the mocked connect.
    delete require.cache[sparkSendPath];
  }

  afterEach(() => {
    delete require.cache[sparkSendPath];
    delete require.cache[sparkSdkPath];
    if (savedArgv) process.argv = savedArgv;
    if (savedLog) console.log = savedLog;
    if (savedErr) console.error = savedErr;
    savedArgv = savedLog = savedErr = null;
    // main() communicates failure via process.exitCode; leaking it would fail
    // the whole test run.
    process.exitCode = undefined;
  });

  async function runMain(argv) {
    savedArgv = process.argv;
    savedLog = console.log;
    savedErr = console.error;
    let out = '';
    console.log = (s) => {
      out += s;
    };
    console.error = () => {};
    process.argv = [process.execPath, path.basename(sparkSendPath), ...argv];
    const { main } = require(sparkSendPath);
    await main();
    return out;
  }

  it('routes a Lightning Address through prepareLnurlPay + lnurlPay', async () => {
    installMock({ parseType: 'lnUrlPay' });
    const out = await runMain(['alice@blink.sv', '100']);
    assert.deepEqual(calls, ['parse', 'prepareLnurlPay', 'lnurlPay']);
    const parsed = JSON.parse(out);
    assert.equal(parsed.destinationType, 'lnurl');
    assert.equal(parsed.status, 'COMPLETED');
    assert.equal(parsed.feeSats, 2);
  });

  it('routes a BOLT-11 invoice through prepareSendPayment + sendPayment', async () => {
    installMock({ parseType: 'bolt11Invoice' });
    const out = await runMain(['lnbc100n1p...', '100']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment', 'sendPayment']);
    // Regression guard for the bug found in the wild: the SDK needs a tagged
    // PaymentRequest object, NOT a raw string.
    assert.deepEqual(lastArgs.prepareSendPayment.paymentRequest, { type: 'input', input: 'lnbc100n1p...' });
    assert.equal(lastArgs.prepareSendPayment.amount, 100n);
    const parsed = JSON.parse(out);
    assert.equal(parsed.destinationType, 'bolt11');
    assert.equal(parsed.status, 'COMPLETED');
    assert.equal(parsed.feeSats, 3); // from lightningFeeSats
  });

  it('--dry-run prepares but does not send (LNURL)', async () => {
    installMock({ parseType: 'lightningAddress' });
    const out = await runMain(['alice@blink.sv', '100', '--dry-run']);
    assert.deepEqual(calls, ['parse', 'prepareLnurlPay']);
    const parsed = JSON.parse(out);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.destinationType, 'lnurl');
  });

  // ── exit semantics (review finding #6) ─────────────────────────────────────
  //
  // The SDK RESOLVES for a failed payment rather than throwing, so without an
  // explicit check the command exits 0 and every caller — shell, CI, agent —
  // reads a payment that did not happen as a success.

  it('exits non-zero when the payment status is failed (bolt11)', async () => {
    installMock({ parseType: 'bolt11Invoice', status: 'failed' });
    const out = await runMain(['lnbc100n1p...', '100']);
    assert.equal(JSON.parse(out).status, 'failed', 'still emits explicit JSON');
    assert.equal(process.exitCode, 1);
  });

  it('exits non-zero when the payment status is failed (lnurl)', async () => {
    installMock({ parseType: 'lnUrlPay', status: 'failed' });
    await runMain(['alice@blink.sv', '100']);
    assert.equal(process.exitCode, 1);
  });

  it('is not fooled by SDK status casing', async () => {
    installMock({ parseType: 'bolt11Invoice', status: 'FAILED' });
    await runMain(['lnbc100n1p...', '100']);
    assert.equal(process.exitCode, 1);
  });

  it('exits zero for a pending payment, which is still in flight', async () => {
    installMock({ parseType: 'bolt11Invoice', status: 'pending' });
    await runMain(['lnbc100n1p...', '100']);
    assert.ok(!process.exitCode, 'pending is not a failure');
  });

  it('exits zero for a completed payment', async () => {
    installMock({ parseType: 'bolt11Invoice', status: 'COMPLETED' });
    await runMain(['lnbc100n1p...', '100']);
    assert.ok(!process.exitCode);
  });
});

// ── isFailedStatus ───────────────────────────────────────────────────────────

describe('spark_send.isFailedStatus', () => {
  const { isFailedStatus } = require('../blink/scripts/spark_send');

  it('matches failed in any casing', () => {
    assert.equal(isFailedStatus('failed'), true);
    assert.equal(isFailedStatus('FAILED'), true);
    assert.equal(isFailedStatus('Failed'), true);
  });

  it('does not match the non-failure statuses', () => {
    for (const s of ['completed', 'COMPLETED', 'pending', 'SUBMITTED', '', null, undefined]) {
      assert.equal(isFailedStatus(s), false, `${s} must not count as failed`);
    }
  });
});

// ── storage preflight (review finding #1) ────────────────────────────────────
//
// The probe must require better-sqlite3 DIRECTLY and open a database, because
// the SDK's own defaultStorage() factory is lazy in 0.23.1 — it returns an
// object without opening SQLite, so probing it passes even when the native
// binding is absent. We simulate the binding being present or broken by
// intercepting require of better-sqlite3.

describe('_spark_sdk.assertStorageAvailable', () => {
  // The probe resolves better-sqlite3 from inside the SDK package, so both must
  // be installed for a require-cache stub to bind. Where the optional SDK is
  // absent (this checkout, minimal CI) we instead drive the same code path by
  // patching Module._resolveFilename, so the tests run in every environment.
  const Module = require('node:module');

  function withStubbedSqlite(t, impl) {
    const realLoad = Module._load;
    const realResolve = Module._resolveFilename;
    t.after(() => {
      Module._load = realLoad;
      Module._resolveFilename = realResolve;
    });

    // The probe resolves the SDK package first (to find its own better-sqlite3
    // tree). Where the SDK is absent, give it a path so we reach the probe.
    Module._resolveFilename = function (request, ...rest) {
      if (request === '@breeztech/breez-sdk-spark') {
        try {
          return realResolve.call(this, request, ...rest);
        } catch {
          return require('node:path').join(__dirname, 'fixtures', 'fake_spark_sdk.js');
        }
      }
      if (request === 'better-sqlite3') {
        if (impl === null) {
          const e = new Error("Cannot find module 'better-sqlite3'");
          e.code = 'MODULE_NOT_FOUND';
          throw e;
        }
        // Return a path so require.resolve succeeds; _load below supplies the
        // actual fake implementation regardless of the path.
        return require('node:path').join(__dirname, 'fixtures', 'fake_better_sqlite3.js');
      }
      return realResolve.call(this, request, ...rest);
    };

    if (impl !== null) {
      Module._load = function (request, parent, isMain) {
        // The probe requires better-sqlite3 by NAME and then by the RESOLVED
        // PATH; intercept both so the fake is returned regardless.
        if (request === 'better-sqlite3' || /fake_better_sqlite3\.js$/.test(String(request))) return impl;
        return realLoad.call(this, request, parent, isMain);
      };
    }
  }

  it('passes when better-sqlite3 can open and query a database', (t) => {
    function FakeDatabase() {
      return {
        prepare: () => ({ get: () => ({ ok: 1 }) }),
        close: () => {},
      };
    }
    withStubbedSqlite(t, FakeDatabase);
    assert.doesNotThrow(() => spark.assertStorageAvailable());
  });

  it('fails with an actionable error when the native binding cannot be constructed', (t) => {
    function BrokenDatabase() {
      throw new Error('Could not locate the bindings file. Tried: .../better_sqlite3.node');
    }
    withStubbedSqlite(t, BrokenDatabase);
    assert.throws(
      () => spark.assertStorageAvailable(),
      (e) =>
        e.code === 'SPARK_STORAGE_UNAVAILABLE' &&
        /better-sqlite3/.test(e.message) &&
        /approve-builds|rebuild/.test(e.message),
    );
  });

  it('fails with an actionable error when better-sqlite3 is not installed at all', (t) => {
    withStubbedSqlite(t, null);
    assert.throws(
      () => spark.assertStorageAvailable(),
      (e) => e.code === 'SPARK_STORAGE_UNAVAILABLE',
    );
  });
});
