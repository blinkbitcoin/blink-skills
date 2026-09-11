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

const { describe, it, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const spark = require('../blink/scripts/_spark_sdk');
const {
  parseArgs: parseSendArgs,
  feeFromPrepare,
  isLnurlPayInput,
  lnurlPayRequestFrom,
} = require('../blink/scripts/spark_send');

// ── budget isolation (must run before any spark_send re-load) ────────────────
//
// spark_send binds _budget.js at require time, and main() now both checks the
// budget and records spends on ~/.blink. Seed the require cache with a _budget
// instance whose BLINK_DIR resolves into a temp HOME, so every spark_send
// re-load in this file checks/writes a throwaway dir instead of the real one.
const budgetModulePath = require.resolve('../blink/scripts/_budget');
const budgetTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-budget-home-'));
{
  const realHomedir = os.homedir;
  os.homedir = () => budgetTmpHome;
  try {
    delete require.cache[budgetModulePath];
    require(budgetModulePath);
  } finally {
    os.homedir = realHomedir;
  }
}
after(() => fs.rmSync(budgetTmpHome, { recursive: true, force: true }));

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

  // A symlink in the MANAGED ANCESTOR chain (e.g. ~/.blink/spark -> elsewhere)
  // would redirect the wallet leaf through the link. lstat must catch it. This
  // exercises the real managed chain, so it builds a fake home and points
  // os.homedir() at it for the duration.
  it('rejects a symlink in the managed ancestor chain (~/.blink/spark)', (t) => {
    const os2 = require('node:os');
    const fakeHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkhome-'));
    const elsewhere = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkelse-'));
    const realHomedir = os2.homedir;
    t.after(() => {
      os2.homedir = realHomedir;
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    });
    os2.homedir = () => fakeHome;

    const blink = pathMod.join(fakeHome, '.blink');
    fs.mkdirSync(blink);
    fs.symlinkSync(elsewhere, pathMod.join(blink, 'spark')); // spark -> elsewhere
    const leaf = pathMod.join(blink, 'spark', 'mainnet-abc123');
    assert.throws(
      () => spark.ensureOwnerOnlyDir(leaf),
      (e) => e.code === 'SPARK_STORAGE_PERMISSIONS' && /symlink/.test(e.message),
    );
    assert.equal(
      fs.existsSync(pathMod.join(elsewhere, 'mainnet-abc123')),
      false,
      'leaf must not be created through the link',
    );
  });

  // The scan must NOT walk above the Blink-owned chain. A path outside home
  // (custom storage, or a tmpdir under a symlinked /var on macOS) must not be
  // refused just because a high ancestor is a symlink the tool doesn't own.
  it('does not walk above the managed chain for out-of-home paths', (t) => {
    const base = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    const elsewhere = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkelse-'));
    t.after(() => {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    });
    // Symlink a grandparent out of home and confirm the leaf is still usable —
    // the scan is leaf-only for out-of-home paths.
    const linkParent = pathMod.join(base, 'linkparent');
    fs.symlinkSync(elsewhere, linkParent);
    const leaf = pathMod.join(linkParent, 'wallet');
    assert.doesNotThrow(() => spark.ensureOwnerOnlyDir(leaf));
    assert.equal(modeOf(leaf), 0o700);
  });

  // On a filesystem where chmod is unsupported, an already-secure (0700) dir
  // must remain usable; only a permissive one should fail closed.
  it('continues when chmod is unsupported but the dir is already owner-only', (t) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.chmodSync(dir, 0o700); // already secure

    const realChmod = fs.chmodSync;
    t.after(() => {
      fs.chmodSync = realChmod;
    });
    fs.chmodSync = () => {
      throw new Error('EPERM: operation not supported');
    };

    assert.doesNotThrow(() => spark.ensureOwnerOnlyDir(dir));
  });

  it('still fails closed when chmod is unsupported AND the dir is permissive', (t) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sparkperm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.chmodSync(dir, 0o777);

    const realChmod = fs.chmodSync;
    t.after(() => {
      fs.chmodSync = realChmod;
    });
    fs.chmodSync = () => {
      throw new Error('EPERM: operation not supported');
    };

    assert.throws(
      () => spark.ensureOwnerOnlyDir(dir),
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

  it('parses --force', () => {
    const a = parseSendArgs(['dest', '1', '--force']);
    assert.equal(a.force, true);
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

  it('returns null (never NaN/Infinity) for non-finite SDK fee values', () => {
    assert.equal(feeFromPrepare({ feeSats: 'not-a-number' }), null, 'a garbage top-level fee reads as unknown');
    assert.equal(feeFromPrepare({ feeSats: Infinity }), null);
    assert.equal(feeFromPrepare({ paymentMethod: { lightningFeeSats: NaN } }), null);
    // One finite + one non-finite component: the finite part survives.
    assert.equal(feeFromPrepare({ paymentMethod: { lightningFeeSats: 3, sparkTransferFeeSats: 'garbage' } }), 3);
    assert.equal(feeFromPrepare({ paymentMethod: { lightningFeeSats: 'garbage', sparkTransferFeeSats: 2 } }), 2);
    assert.equal(feeFromPrepare({ paymentMethod: { fee: '∞' } }), null);
  });
});

// ── spark_send.classifyDestination ───────────────────────────────────────────

describe('spark_send.classifyDestination', () => {
  const { classifyDestination } = require('../blink/scripts/spark_send');

  it('routes lnUrlPay and lightningAddress to the lnurl path', () => {
    assert.equal(classifyDestination({ type: 'lnUrlPay' }).type, 'lnurl');
    assert.equal(classifyDestination({ type: 'lightningAddress' }).type, 'lnurl');
  });

  it('routes bolt11Invoice', () => {
    assert.equal(classifyDestination({ type: 'bolt11Invoice' }).type, 'bolt11');
  });

  it('routes sparkAddress', () => {
    assert.equal(classifyDestination({ type: 'sparkAddress' }).type, 'spark');
  });

  it('is case-insensitive on the discriminant', () => {
    assert.equal(classifyDestination({ type: 'BOLT11INVOICE' }).type, 'bolt11');
  });

  it('rejects every other SDK input type by name', () => {
    for (const t of ['bitcoinAddress', 'bolt12Invoice', 'crossChainAddress', 'url', 'lnurlWithdraw']) {
      assert.throws(
        () => classifyDestination({ type: t }),
        (e) => e.code === 'UNSUPPORTED_DESTINATION' && e.message.includes(`'${t.toLowerCase()}'`),
        `${t} must not fall into a payment path`,
      );
    }
  });

  it('rejects malformed parse results rather than guessing', () => {
    for (const bad of [null, undefined, {}, { type: '' }, 'bolt11Invoice']) {
      assert.throws(
        () => classifyDestination(bad),
        (e) => e.code === 'UNSUPPORTED_DESTINATION',
      );
    }
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
        feeFromPrepare: spark.feeFromPrepare,
        safeErrorDetail: spark.safeErrorDetail,
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

  // ── destination classification (review finding: exhaustive allowlist) ──────

  it('rejects an unsupported SDK destination type before any prepare call', async () => {
    installMock({ parseType: 'bitcoinAddress' });
    await assert.rejects(
      () => runMain(['bc1qxyz', '100']),
      (e) => {
        assert.match(e.message, /Unsupported destination type 'bitcoinaddress'/);
        assert.equal(e.code, 'UNSUPPORTED_DESTINATION');
        return true;
      },
    );
    assert.deepEqual(calls, ['parse'], 'must stop after parse, before any prepare/send');
  });

  it('routes a Spark address through prepareSendPayment and labels it spark', async () => {
    installMock({ parseType: 'sparkAddress' });
    const out = await runMain(['spark1qxyz', '100']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment', 'sendPayment']);
    const parsed = JSON.parse(out);
    assert.equal(parsed.destinationType, 'spark');
    assert.equal(parsed.status, 'COMPLETED');
  });

  it('dry-run to a Spark address labels destinationType spark', async () => {
    installMock({ parseType: 'sparkAddress' });
    const out = await runMain(['spark1qxyz', '100', '--dry-run']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment']);
    assert.equal(JSON.parse(out).destinationType, 'spark');
  });
});

// ── spark_send budget integration (mocked SDK + isolated budget) ─────────────
//
// spark-send is now under budget controls like the custodial pay commands:
// enforced when configured, allowed when not (explicit one-shot), recorded in
// the spending log unless the payment failed. The _budget instance here is the
// isolated one seeded at the top of the file, so these tests never touch ~/.blink.

// ── spark_send token/conversion budget integration (PR #10 review) ──────────
//
// The conversion branches must carry the SAME fail-closed budget lifecycle
// as the hardened BTC path: outcome-unknown keeps the reservation, only an
// explicit terminal failure releases it, --force actually overrides, and a
// missing/unusable estimate never silently disables enforcement.

describe('spark_send token/conversion budget integration', () => {
  const { beforeEach } = require('node:test');
  const sparkSdkPath = require.resolve('../blink/scripts/_spark_sdk');
  const sparkSendPath = require.resolve('../blink/scripts/spark_send');
  const budget = require(budgetModulePath); // the isolated instance

  let calls;
  let lastErr;
  let savedArgv;
  let savedLog;
  let savedErr;

  /**
   * Fake SDK for the token/conversion paths. Options:
   *   parseType: parse() result type ('sparkAddress' | 'bolt11Invoice')
   *   estimate:  { amountIn, amountOut } bigints, or null to OMIT the estimate
   *   prepareAmount: bigint for prepareResponse.amount (toBitcoin binding)
   *   throwOnSend / status: sendPayment behavior
   */
  function installTokenMock({
    parseType = 'sparkAddress',
    estimate = { amountIn: 50000n, amountOut: 1000000n },
    prepareAmount = 45000n,
    throwOnSend = false,
    status = 'completed',
  } = {}) {
    calls = [];
    const fakeSdk = {
      async parse() {
        calls.push('parse');
        return { type: parseType };
      },
      async getTokensMetadata() {
        calls.push('getTokensMetadata');
        return { tokensMetadata: [{ identifier: 'btkn1test', name: 'T', ticker: 'T', decimals: 6 }] };
      },
      async prepareSendPayment(req) {
        calls.push('prepareSendPayment');
        const isToBitcoin = req.conversionOptions && req.conversionOptions.conversionType.type === 'toBitcoin';
        const resp = {
          paymentMethod: { type: 'sparkAddress', address: 'sprt1x', fee: '0', tokenIdentifier: req.tokenIdentifier },
          amount: isToBitcoin ? prepareAmount : req.amount || 0n,
          feePolicy: { type: 'simple' },
        };
        if (req.conversionOptions && estimate) {
          resp.conversionEstimate = {
            options: req.conversionOptions,
            amountIn: estimate.amountIn,
            amountOut: estimate.amountOut,
            fee: 0n,
          };
        }
        return resp;
      },
      async sendPayment() {
        calls.push('sendPayment');
        if (throwOnSend) throw new Error('transport reset after dispatch');
        return { payment: { id: 'tok-1', status } };
      },
    };
    require.cache[sparkSdkPath] = {
      id: sparkSdkPath,
      filename: sparkSdkPath,
      loaded: true,
      exports: {
        async connect() {
          return { sdk: fakeSdk, disconnect: async () => {} };
        },
        feeFromPrepare: spark.feeFromPrepare,
        safeErrorDetail: spark.safeErrorDetail,
        resolveTokenIdentifier: (t) => (t === 'usdb' ? 'btkn1test' : t),
        parseTokenAmount: spark.parseTokenAmount,
        normalizeInfo: (info) => ({ balanceSats: Number(info && info.balanceSats) || 0 }),
        normalizeSdkValue: (v) => v,
        normalizeTokenBalances: () => ({}),
        async waitForStableBalance() {
          return { balanceSats: 0, stable: true };
        },
      },
    };
    delete require.cache[sparkSendPath];
  }

  beforeEach(() => {
    budget.resetLog({ force: true });
    try {
      fs.unlinkSync(budget.CONFIG_FILE);
    } catch {
      /* no config */
    }
  });

  afterEach(() => {
    delete require.cache[sparkSendPath];
    delete require.cache[sparkSdkPath];
    if (savedArgv) process.argv = savedArgv;
    if (savedLog) console.log = savedLog;
    if (savedErr) console.error = savedErr;
    savedArgv = savedLog = savedErr = null;
    process.exitCode = undefined;
  });

  async function runMain(argv) {
    savedArgv = process.argv;
    savedLog = console.log;
    savedErr = console.error;
    let out = '';
    lastErr = '';
    console.log = (s) => {
      out += s;
    };
    console.error = (s) => {
      lastErr += s + '\n';
    };
    process.argv = [process.execPath, path.basename(sparkSendPath), ...argv];
    const { main } = require(sparkSendPath);
    await main();
    return out;
  }

  const FROM_BTC = ['sprt1x', '10.5', '--token', 'usdb', '--from-btc'];
  const FROM_TOKEN = (sats) => ['lnbc1invoice', String(sats), '--from-token', 'usdb'];

  it('--from-btc: a post-dispatch outcome-unknown error KEEPS the reservation (HIGH 1)', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({ throwOnSend: true });
    await assert.rejects(() => runMain(FROM_BTC), /transport reset/);
    assert.ok(calls.includes('sendPayment'), 'dispatch happened');
    const log = budget.readLog();
    assert.equal(log.length, 1, 'the reservation must survive the outcome-unknown throw');
    assert.equal(log[0].state, 'reserved');
    assert.match(lastErr, /outcome is unknown.*stays in place/s);
  });

  it('--from-btc: an explicit terminal failed status RELEASES the reservation', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({ status: 'failed' });
    const out = await runMain(FROM_BTC);
    assert.equal(JSON.parse(out).status, 'failed');
    assert.deepEqual(budget.readLog(), [], 'explicit failure — budget freed');
    assert.equal(process.exitCode, 1);
  });

  it('--from-btc: a successful conversion SETTLES the reserved sats side', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({});
    const out = await runMain(FROM_BTC);
    assert.equal(JSON.parse(out).status, 'completed');
    const log = budget.readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].sats, 50000, 'the estimate sats side (amountIn)');
    assert.equal(log[0].state, undefined, 'finalized');
  });

  it('--from-token: a mismatching supplied amount is REJECTED before dispatch (HIGH 2)', async () => {
    installTokenMock({ parseType: 'bolt11Invoice' }); // invoice is 45000 sats
    await assert.rejects(() => runMain(FROM_TOKEN(1)), /invoice is for 45000 sats but 1 was supplied/);
    assert.deepEqual(
      calls.filter((x) => x === 'sendPayment'),
      [],
      'must not dispatch on a mismatch',
    );
  });

  it('--from-token: a matching amount dispatches and emits the AUTHORITATIVE amount', async () => {
    installTokenMock({ parseType: 'bolt11Invoice' });
    const out = await runMain(FROM_TOKEN(45000));
    assert.ok(calls.includes('sendPayment'));
    assert.equal(JSON.parse(out).amountSats, 45000);
  });

  it('--from-token: a prepared amount of zero is refused (unknown spend)', async () => {
    installTokenMock({ parseType: 'bolt11Invoice', prepareAmount: 0n });
    await assert.rejects(() => runMain(FROM_TOKEN(45000)), /Could not determine the invoice's BTC amount/);
  });

  it('--from-btc --force overrides an over-limit quote and records the spend (MEDIUM 1)', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    installTokenMock({});
    const out = await runMain([...FROM_BTC, '--force']);
    assert.ok(calls.includes('sendPayment'), 'forced over-limit conversion must reach dispatch');
    assert.equal(JSON.parse(out).status, 'completed');
    const log = budget.readLog();
    assert.equal(log.length, 1, 'the forced spend is recorded (no reservation — direct record)');
    assert.equal(log[0].state, undefined);
    assert.equal(log[0].sats, 50000);
  });

  it('--from-btc without --force respects the budget denial', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    installTokenMock({});
    await assert.rejects(() => runMain(FROM_BTC), /Budget exceeded.*--force/);
    assert.deepEqual(
      calls.filter((x) => x === 'sendPayment'),
      [],
      'must not dispatch',
    );
  });

  it('--from-btc: an ABSENT estimate is refused pre-dispatch unless forced (MEDIUM 2)', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({ estimate: null });
    await assert.rejects(() => runMain(FROM_BTC), /No usable conversion estimate.*--force/s);
    assert.deepEqual(
      calls.filter((x) => x === 'sendPayment'),
      [],
      'must not dispatch unreserved',
    );
  });

  it('--from-btc: zero, negative, and unsafe-integer estimates are refused', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    for (const amountIn of [0n, -5n, 2n ** 70n]) {
      installTokenMock({ estimate: { amountIn, amountOut: 1n } });
      await assert.rejects(() => runMain(FROM_BTC), /No usable conversion estimate/, `amountIn=${amountIn}`);
      assert.deepEqual(
        calls.filter((x) => x === 'sendPayment'),
        [],
        `must not dispatch for amountIn=${amountIn}`,
      );
    }
  });

  it('--from-btc --force with an absent estimate dispatches and warns the spend is unrecorded', async () => {
    installTokenMock({ estimate: null });
    const out = await runMain([...FROM_BTC, '--force']);
    assert.ok(calls.includes('sendPayment'));
    assert.equal(JSON.parse(out).status, 'completed');
    assert.deepEqual(budget.readLog(), [], 'no fabricated number is recorded');
    assert.match(lastErr, /unrecorded/);
  });

  it('a plain token send (--token, no conversion) moves no sats and records nothing', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({ estimate: null });
    const out = await runMain(['sprt1x', '10.5', '--token', 'usdb']);
    assert.equal(JSON.parse(out).status, 'completed');
    assert.deepEqual(budget.readLog(), []);
  });

  it('a TAGGED-OBJECT failed status on the token path exits non-zero and releases (isFailedStatus unification)', async () => {
    // The token branches used inline String(status) checks; a tagged-variant
    // status ({type:'failed'}) would have settled + exited 0. The shared seam
    // runs every branch through the hardened isFailedStatus.
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100000, allowlist: [] });
    installTokenMock({ status: { type: 'failed' }, estimate: { amountIn: 50000n, amountOut: 1n } });
    await runMain(['sprt1x', '10.5', '--token', 'usdb', '--from-btc']);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(budget.readLog(), [], 'terminal failure — budget freed');
  });
});

describe('spark_send budget integration', () => {
  const sparkSdkPath = require.resolve('../blink/scripts/_spark_sdk');
  const sparkSendPath = require.resolve('../blink/scripts/spark_send');
  const budget = require(budgetModulePath); // the isolated instance

  const { before, beforeEach } = require('node:test');

  let calls;
  let savedArgv;
  let savedLog;
  let savedErr;
  let lastErr;

  before(() => {
    // The mocked routing tests above also record spends; start this suite clean.
    budget.resetLog({ force: true });
  });

  beforeEach(() => {
    budget.resetLog({ force: true });
    try {
      fs.unlinkSync(budget.CONFIG_FILE);
    } catch {
      /* no config was written */
    }
  });

  function installMock({ status = 'COMPLETED' } = {}) {
    calls = [];
    const fakeSdk = {
      async parse() {
        calls.push('parse');
        return { type: 'bolt11Invoice' };
      },
      async prepareSendPayment() {
        calls.push('prepareSendPayment');
        return { paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 3 } };
      },
      async sendPayment() {
        calls.push('sendPayment');
        return { payment: { id: 'bolt-1', status } };
      },
    };
    require.cache[sparkSdkPath] = {
      id: sparkSdkPath,
      filename: sparkSdkPath,
      loaded: true,
      exports: {
        async connect() {
          return { sdk: fakeSdk, disconnect: async () => {} };
        },
        feeFromPrepare: spark.feeFromPrepare,
        safeErrorDetail: spark.safeErrorDetail,
      },
    };
    delete require.cache[sparkSendPath];
  }

  afterEach(() => {
    delete require.cache[sparkSendPath];
    delete require.cache[sparkSdkPath];
    if (savedArgv) process.argv = savedArgv;
    if (savedLog) console.log = savedLog;
    if (savedErr) console.error = savedErr;
    savedArgv = savedLog = savedErr = null;
    process.exitCode = undefined;
    // Reset budget state so tests cannot leak limits/log entries into each other.
    try {
      fs.unlinkSync(budget.CONFIG_FILE);
    } catch {
      /* no config was written */
    }
    budget.resetLog({ force: true });
  });

  async function runMain(argv) {
    savedArgv = process.argv;
    savedLog = console.log;
    savedErr = console.error;
    let out = '';
    lastErr = '';
    console.log = (s) => {
      out += s;
    };
    console.error = (s) => {
      lastErr += s + '\n';
    };
    process.argv = [process.execPath, path.basename(sparkSendPath), ...argv];
    const { main } = require(sparkSendPath);
    await main();
    return out;
  }

  it('a failed budget-log recording warns on stderr but never masks the payment', async () => {
    // Real path: this test holds the budget lock while the command runs, so
    // settleSpend's recordSpend times out and must surface a warning — the
    // payment result is unaffected.
    installMock({});
    budget.setLockTiming({ acquireTimeoutMs: 60 });
    const token = budget.acquireLogLock();
    try {
      const out = await runMain(['lnbc100n1p...', '100']);
      assert.equal(JSON.parse(out).status, 'COMPLETED', 'the payment result is still emitted');
      assert.ok(!process.exitCode);
      assert.match(lastErr, /could not record the spend in the budget log.*Timed out/s);
    } finally {
      budget.releaseLogLock(token);
      budget.setLockTiming({ acquireTimeoutMs: 2000 });
    }
  });

  it('a failed finalization leaves the reservation counting (fail-closed) and warns', async () => {
    // Real path: the lock is held only for the finalize window (grabbing it
    // earlier would block the reservation itself), so finalizeOrRecord times
    // out and settleSpend warns; the reservation stays fail-closed.
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 500, allowlist: [] });
    installMock({});
    budget.setLockTiming({ acquireTimeoutMs: 60 });
    let token = null;
    // Hook: hold the lock once the reservation exists (send time).
    const sdkPath = require.resolve('../blink/scripts/_spark_sdk');
    const held = require.cache[sdkPath].exports;
    const origConnect = held.connect;
    held.connect = async (opts) => {
      const r = await origConnect(opts);
      const sdk = r.sdk;
      const origSend = sdk.sendPayment.bind(sdk);
      sdk.sendPayment = async (req) => {
        token = budget.acquireLogLock(); // reservation already exists now
        return origSend(req);
      };
      return { sdk, disconnect: r.disconnect };
    };
    try {
      const out = await runMain(['lnbc100n1p...', '100']);
      assert.equal(JSON.parse(out).status, 'COMPLETED', 'the payment result is still emitted');
      assert.match(lastErr, /could not record the spend in the budget log.*Timed out/s);
      const log = budget.readLog();
      assert.equal(log.length, 1);
      assert.equal(log[0].state, 'reserved', 'the orphaned reservation must keep blocking the budget');
    } finally {
      if (token) budget.releaseLogLock(token);
      held.connect = origConnect;
      budget.setLockTiming({ acquireTimeoutMs: 2000 });
    }
  });

  it('an outcome-unknown SDK error after dispatch KEEPS the reservation (fail-closed)', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 500, allowlist: [] });
    installMock({});
    // Replace sendPayment with a transport-level failure after dispatch.
    const sdkPath = require.resolve('../blink/scripts/_spark_sdk');
    const fake = require.cache[sdkPath].exports;
    const fakeSdk = {
      async parse() {
        return { type: 'bolt11Invoice' };
      },
      async prepareSendPayment() {
        return { paymentMethod: { type: 'bolt11Invoice', lightningFeeSats: 3 } };
      },
      async sendPayment() {
        throw new Error('transport reset after dispatch');
      },
    };
    fake.connect = async () => ({ sdk: fakeSdk, disconnect: async () => {} });
    delete require.cache[sparkSendPath];
    await assert.rejects(() => runMain(['lnbc100n1p...', '100']), /transport reset/);
    const log = budget.readLog();
    assert.equal(log.length, 1, 'the reservation must stay — the payment may still settle');
    assert.equal(log[0].state, 'reserved');
    assert.match(lastErr, /outcome is unknown.*25h prune/s);
  });

  it('an unconfigured budget allows an explicit send and records the spend', async () => {
    installMock({});
    const out = await runMain(['lnbc100n1p...', '100']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment', 'sendPayment']);
    assert.equal(JSON.parse(out).status, 'COMPLETED');
    const entries = budget.readLog();
    assert.equal(entries.length, 1, 'exactly one spend entry');
    assert.equal(entries[0].sats, 100);
    assert.equal(entries[0].command, 'spark-send');
  });

  it('a configured budget blocks an over-limit send BEFORE the SDK send call', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 50, allowlist: [] });
    installMock({});
    await assert.rejects(() => runMain(['lnbc100n1p...', '100']), /Budget exceeded/);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment'], 'must stop after prepare, before send');
    assert.equal(budget.readLog().length, 0, 'nothing recorded for a blocked send');
  });

  it('a within-budget send proceeds and records the spend', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 500, allowlist: [] });
    installMock({});
    await runMain(['lnbc100n1p...', '100']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment', 'sendPayment']);
    assert.equal(budget.readLog().length, 1);
  });

  it('--force bypasses the budget check and records the spend', async () => {
    budget.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 50, allowlist: [] });
    installMock({});
    const out = await runMain(['lnbc100n1p...', '100', '--force']);
    assert.deepEqual(calls, ['parse', 'prepareSendPayment', 'sendPayment']);
    assert.equal(JSON.parse(out).status, 'COMPLETED');
    assert.equal(budget.readLog().length, 1);
  });

  it('a failed payment is not recorded', async () => {
    installMock({ status: 'failed' });
    await runMain(['lnbc100n1p...', '100']);
    assert.equal(process.exitCode, 1);
    assert.equal(budget.readLog().length, 0);
  });

  it('a pending payment is recorded (in flight, same rule as custodial)', async () => {
    installMock({ status: 'pending' });
    await runMain(['lnbc100n1p...', '100']);
    assert.ok(!process.exitCode, 'pending is not a failure');
    assert.equal(budget.readLog().length, 1);
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

// ── spark_transactions.parseArgs ─────────────────────────────────────────────

describe('spark_transactions.parseArgs', () => {
  const { parseArgs } = require('../blink/scripts/spark_transactions');

  it('defaults to limit 20, offset 0, no type filter', () => {
    const a = parseArgs([]);
    assert.equal(a.limit, 20);
    assert.equal(a.offset, 0);
    assert.equal(a.type, null);
  });

  it('parses --limit, --offset and --type', () => {
    const a = parseArgs(['--limit', '5', '--offset', '40', '--type', 'receive']);
    assert.equal(a.limit, 5);
    assert.equal(a.offset, 40);
    assert.equal(a.type, 'receive');
  });

  it('normalizes --type casing', () => {
    assert.equal(parseArgs(['--type', 'SEND']).type, 'send');
  });

  it('rejects a negative offset', () => {
    assert.throws(() => parseArgs(['--offset', '-1']), /non-negative integer/);
  });

  it('rejects an invalid --type', () => {
    assert.throws(() => parseArgs(['--type', 'sideways']), /must be 'send' or 'receive'/);
  });
});

// ── spark_balance.parseArgs ──────────────────────────────────────────────────

describe('spark_balance.parseArgs', () => {
  const { parseArgs } = require('../blink/scripts/spark_balance');
  const savedEnv = process.env.SPARK_NETWORK;

  const restoreEnv = () => {
    if (savedEnv === undefined) delete process.env.SPARK_NETWORK;
    else process.env.SPARK_NETWORK = savedEnv;
  };

  it('defaults to mainnet with no args and no env var', () => {
    delete process.env.SPARK_NETWORK;
    try {
      assert.equal(parseArgs([]).network, 'mainnet');
    } finally {
      restoreEnv();
    }
  });

  it('falls back to SPARK_NETWORK when the flag is absent', () => {
    process.env.SPARK_NETWORK = 'regtest';
    try {
      assert.equal(parseArgs([]).network, 'regtest');
    } finally {
      restoreEnv();
    }
  });

  it('parses --network and lets the flag win over the env var', () => {
    process.env.SPARK_NETWORK = 'mainnet';
    try {
      assert.equal(parseArgs(['--network', 'regtest']).network, 'regtest');
    } finally {
      restoreEnv();
    }
  });

  it('ignores a trailing --network without a value', () => {
    delete process.env.SPARK_NETWORK;
    try {
      assert.equal(parseArgs(['--network']).network, 'mainnet');
    } finally {
      restoreEnv();
    }
  });
});

// ── _spark_sdk.normalizeSdkValue ─────────────────────────────────────────────

describe('_spark_sdk.normalizeSdkValue', () => {
  const { normalizeSdkValue } = require('../blink/scripts/_spark_sdk');

  it('converts a Map to a plain object with normalized values', () => {
    const map = new Map([['token-a', { balance: 5000n, tokenMetadata: { name: 'A' } }]]);
    assert.deepEqual(normalizeSdkValue(map), {
      'token-a': { balance: 5000, tokenMetadata: { name: 'A' } },
    });
  });

  it('keeps safe bigints as numbers and unsafe bigints as strings (no unsafe rounding)', () => {
    assert.equal(normalizeSdkValue(5n), 5);
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const out = normalizeSdkValue(huge);
    assert.equal(out, huge.toString());
    assert.equal(typeof out, 'string');
  });

  it('recurses into arrays and plain objects', () => {
    assert.deepEqual(normalizeSdkValue({ list: [1n, { m: new Map([['k', 2n]]) }] }), {
      list: [1, { m: { k: 2 } }],
    });
  });

  it('passes primitives through', () => {
    assert.equal(normalizeSdkValue('x'), 'x');
    assert.equal(normalizeSdkValue(null), null);
    assert.equal(normalizeSdkValue(42), 42);
  });

  it('a wallet WITH tokens no longer reports an empty object (jsonSafe regression)', () => {
    // The pinned SDK returns tokenBalances as Map<string, TokenBalance>;
    // JSON.stringify(new Map(...)) is "{}", hiding real holdings.
    const out = normalizeSdkValue({ tokenBalances: new Map([['tok-1', { balance: 7n }]]) });
    assert.deepEqual(out.tokenBalances, { 'tok-1': { balance: 7 } });
  });
});

// ── _spark_sdk token helpers ──────────────────────────────────────────────────

describe('_spark_sdk token helpers', () => {
  const sdk = require('../blink/scripts/_spark_sdk');
  const USDB = 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87';

  describe('resolveTokenIdentifier', () => {
    it("'usdb' resolves to the documented mainnet constant", () => {
      assert.equal(sdk.resolveTokenIdentifier('usdb', 'mainnet'), USDB);
    });
    it('SPARK_USDB_TOKEN env var wins over the constant', () => {
      const saved = process.env.SPARK_USDB_TOKEN;
      process.env.SPARK_USDB_TOKEN = 'btkn1test';
      try {
        assert.equal(sdk.resolveTokenIdentifier('usdb', 'regtest'), 'btkn1test');
      } finally {
        if (saved === undefined) delete process.env.SPARK_USDB_TOKEN;
        else process.env.SPARK_USDB_TOKEN = saved;
      }
    });
    it('non-usdb passes through unchanged', () => {
      assert.equal(sdk.resolveTokenIdentifier('btkn1other', 'regtest'), 'btkn1other');
    });
    it("'usdb' off-mainnet without the env var fails with the hint", () => {
      const saved = process.env.SPARK_USDB_TOKEN;
      delete process.env.SPARK_USDB_TOKEN;
      try {
        assert.throws(() => sdk.resolveTokenIdentifier('usdb', 'regtest'), /SPARK_USDB_TOKEN/);
      } finally {
        if (saved !== undefined) process.env.SPARK_USDB_TOKEN = saved;
      }
    });
  });

  describe('parseTokenAmount', () => {
    it('converts a decimal amount at the token decimals (10.5 @ 6 -> 10500000)', () => {
      assert.equal(sdk.parseTokenAmount('10.5', 6), 10500000n);
    });
    it('zero decimals keeps whole units', () => {
      assert.equal(sdk.parseTokenAmount('7', 0), 7n);
    });
    it('pads short fractions to full precision', () => {
      assert.equal(sdk.parseTokenAmount('0.5', 6), 500000n);
      assert.equal(sdk.parseTokenAmount('1.000001', 6), 1000001n);
    });
    it('rejects more decimals than the token supports', () => {
      assert.throws(() => sdk.parseTokenAmount('1.1234567', 6), /decimal places/);
    });
    it('rejects garbage and negatives', () => {
      assert.throws(() => sdk.parseTokenAmount('abc', 6), /Invalid token amount/);
      assert.throws(() => sdk.parseTokenAmount('-5', 6), /Invalid token amount/);
    });
  });

  describe('formatTokenAmount', () => {
    it('renders base units with the token decimals', () => {
      assert.equal(sdk.formatTokenAmount(10500000n, 6), '10.500000');
    });
    it('handles zero-decimal tokens', () => {
      assert.equal(sdk.formatTokenAmount(7n, 0), '7');
    });
  });

  describe('normalizeTokenBalances', () => {
    it('flattens a Map into precision-preserving JSON entries', () => {
      const balances = new Map([
        [
          USDB,
          {
            balance: 10500000n,
            tokenMetadata: {
              identifier: USDB,
              name: 'Bitcoin USD',
              ticker: 'USDB',
              decimals: 6,
              issuerPublicKey: '02ff',
            },
          },
        ],
      ]);
      const out = sdk.normalizeTokenBalances(balances);
      assert.equal(out[USDB].balance, '10500000', 'balance stays a string (BigInt precision)');
      assert.equal(out[USDB].balanceFormatted, '10.500000');
      assert.equal(out[USDB].ticker, 'USDB');
      assert.equal(out[USDB].decimals, 6);
    });
    it('empty/absent maps normalize to {}', () => {
      assert.deepEqual(sdk.normalizeTokenBalances(undefined), {});
      assert.deepEqual(sdk.normalizeTokenBalances(new Map()), {});
    });
  });
});

// ── spark_send conversionEstimateFrom ────────────────────────────────────────

describe('spark_send.conversionEstimateFrom / prepareToken', () => {
  const { conversionEstimateFrom, parseArgs } = require('../blink/scripts/spark_send');

  it('extracts a JSON-safe conversion estimate', () => {
    const est = conversionEstimateFrom({
      conversionEstimate: {
        options: { conversionType: { type: 'fromBitcoin' } },
        amountIn: 50000n,
        amountOut: 1000000n,
        fee: 0n,
      },
    });
    assert.deepEqual(est, {
      amountIn: '50000',
      amountOut: '1000000',
      fee: '0',
      conversionType: 'fromBitcoin',
    });
  });

  it('returns null when there is no estimate', () => {
    assert.equal(conversionEstimateFrom({}), null);
    assert.equal(conversionEstimateFrom(null), null);
  });

  it('parseArgs keeps the RAW amount string whenever --token appears (any position)', () => {
    const a = parseArgs(['sprt1xyz', '10.5', '--token', 'usdb']); // flag AFTER amount
    assert.equal(a.amountSats, '10.5', 'must not parseInt a decimal token amount');
    assert.equal(a.token, 'usdb');
  });

  it('parseArgs still integer-validates BTC amounts without --token', () => {
    assert.throws(() => parseArgs(['dest', 'abc']), /positive integer/);
    assert.throws(() => parseArgs(['dest', '0']), /positive integer/);
    const ok = parseArgs(['dest', '100']);
    assert.equal(ok.amountSats, 100);
  });

  it('parseArgs parses the conversion flags', () => {
    const a = parseArgs(['dest', '100', '--from-btc', '--slippage-bps', '75']);
    assert.equal(a.fromBtc, true);
    assert.equal(a.slippageBps, 75);
    const b = parseArgs(['dest', '100', '--from-token', 'usdb', '--base-units']);
    assert.equal(b.fromToken, 'usdb');
    assert.equal(b.baseUnits, true);
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
