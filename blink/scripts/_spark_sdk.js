/**
 * Blink Claw Skill — Breez Spark SDK wrapper (OPTIONAL, non-custodial)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPIKE / PROOF-OF-CONCEPT. This is the client-side path for NON-CUSTODIAL
 * (Spark) account operations that require signing — most importantly SEND, but
 * also balance/history reads straight from the wallet.
 *
 * It wraps the standalone Node.js build of the Breez Spark SDK,
 *   `@breeztech/breez-sdk-spark`
 * which is a WASM package that runs headless in Node (no React Native, no
 * browser `init()`). This is DISTINCT from `@breeztech/breez-sdk-spark-react-native`
 * that blink-mobile uses.
 *
 * WHY THIS IS DIFFERENT FROM THE REST OF blink-skills
 * ---------------------------------------------------
 *  - It requires the account's 12/24-word SEED (`SPARK_MNEMONIC`). Whoever runs
 *    it can spend the funds. This is a genuine custody shift: the whole point of
 *    a non-custodial account is that the user holds the keys. Handle with care.
 *  - It pulls a large (~63 MB) optional native/WASM dependency, breaking the
 *    project's "zero runtime dependencies" invariant. It is therefore an
 *    OPTIONAL dependency and lazy-loaded — nothing here runs unless a
 *    `spark-*` command is invoked.
 *  - It needs Node.js 22+ (WASM requirements of the SDK).
 *
 * SECURITY RULES (enforced/observed here):
 *  - The seed is read ONLY from the `SPARK_MNEMONIC` environment variable.
 *    Unlike BLINK_API_KEY, we do NOT scan shell rc files for a seed.
 *  - The seed is never logged, echoed, or written anywhere by this module.
 *  - No API change to Blink is involved — this is a pure client capability.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SPARK_PACKAGE = '@breeztech/breez-sdk-spark';
const DEFAULT_NETWORK = 'mainnet';

/**
 * Lazily load the Breez Spark SDK. Throws a clear, actionable error if the
 * optional dependency is not installed.
 * @returns {object} The SDK module (connect, defaultConfig, ...).
 */
function loadSdkModule() {
  // The SDK package probes for optional MySQL storage backends at require() time
  // and prints several noisy "mysql2 not found" warnings to the console before
  // any of our code runs. We use file storage (storageDir), so this is harmless
  // — silence console during the require, then restore it. This is the only way
  // to suppress it: the messages predate the SDK logger (initLogging).
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  try {
    return require(SPARK_PACKAGE);
  } catch (err) {
    // Restore before throwing so the error is actually visible.
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    throw new Error(
      `The Breez Spark SDK (${SPARK_PACKAGE}) is not installed.\n` +
        `Non-custodial send/balance/history requires it. Install with:\n` +
        `    npm install ${SPARK_PACKAGE}\n` +
        `and ensure you are on Node.js 22+.\n` +
        `Original load error: ${err.message}`,
    );
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

/**
 * Require Node 22+ (SDK constraint).
 */
function requireNode22() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) {
    throw new Error(`The Breez Spark SDK requires Node.js 22+. Current version: ${process.versions.node}.`);
  }
}

/**
 * Validate a mnemonic's BIP39 checksum.
 *
 * A word count alone is not validation: twelve arbitrary dictionary words pass
 * it, and a single mistyped word then derives a DIFFERENT, valid, empty wallet.
 * The user sees a zero balance and no error, which looks like fund loss.
 *
 * FAILS CLOSED. This function has exactly two outcomes: it returns true because
 * the checksum verified, or it throws. It must never return false, and it must
 * never conflate "the validator could not run" with "the seed is fine" — that
 * conflation IS the vulnerability, because it silently disables the very
 * control that prevents deriving the wrong wallet. A missing validator is
 * therefore a hard error, distinguishable by `e.code`:
 *
 *   MNEMONIC_VALIDATOR_UNAVAILABLE — `bip39` is not installed.
 *   MNEMONIC_INVALID_CHECKSUM      — the phrase is not a valid BIP39 mnemonic.
 *
 * @param {string} mnemonic
 * @returns {true}
 * @throws {Error} If the validator is unavailable or the checksum is invalid.
 */
function validateMnemonicChecksum(mnemonic) {
  let bip39;
  try {
    bip39 = require('bip39');
  } catch (err) {
    const e = new Error(
      'Cannot verify SPARK_MNEMONIC: the `bip39` package is not installed, so the BIP39 ' +
        'checksum check cannot run. Refusing to continue unverified — an unnoticed typo in ' +
        'the seed derives a different, valid, EMPTY wallet, which looks exactly like losing ' +
        'your funds. Install it with:\n' +
        '    npm install bip39\n' +
        'Note that `npm install --omit=optional` and `--omit=dev` both skip it.\n' +
        `Original load error: ${err.message}`,
    );
    e.code = 'MNEMONIC_VALIDATOR_UNAVAILABLE';
    throw e;
  }
  if (!bip39.validateMnemonic(mnemonic)) {
    // Deliberately does not echo the mnemonic or name the offending word.
    const e = new Error(
      'SPARK_MNEMONIC failed BIP39 checksum validation. The word count is right but the ' +
        'phrase is not a valid BIP39 mnemonic — usually a mistyped or transposed word. ' +
        'Connecting anyway would silently derive a different, empty wallet.',
    );
    e.code = 'MNEMONIC_INVALID_CHECKSUM';
    throw e;
  }
  return true;
}

/**
 * Read the non-custodial account seed from the environment.
 *
 * SECURITY: env var only — no rc-file scanning for seeds. Never logged.
 *
 * Fails closed: the BIP39 checksum MUST verify before the seed is returned. If
 * the validator cannot run, this throws rather than proceeding unverified.
 *
 * @returns {string} The BIP39 mnemonic.
 * @throws {Error} If unset, the wrong length, or the checksum cannot be verified.
 */
function getMnemonic() {
  const mnemonic = process.env.SPARK_MNEMONIC;
  if (!mnemonic || !mnemonic.trim()) {
    throw new Error(
      'SPARK_MNEMONIC not set. Non-custodial operations that sign transactions require the ' +
        'account seed (12/24 BIP39 words) in the SPARK_MNEMONIC environment variable. ' +
        'This grants spend authority — never share or log it.',
    );
  }
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error('SPARK_MNEMONIC must be a 12 or 24 word BIP39 mnemonic.');
  }
  const normalized = words.join(' ');
  validateMnemonicChecksum(normalized);
  return normalized;
}

/**
 * Resolve the Breez API key (required by the SDK to reach the Spark service).
 * @returns {string}
 */
function getBreezApiKey() {
  const key = process.env.BREEZ_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('BREEZ_API_KEY not set. The Breez Spark SDK requires a Breez API key to connect.');
  }
  return key.trim();
}

/**
 * Compute a stable, per-seed storage directory for the SDK's local state.
 * We derive a non-reversible id from the mnemonic so different accounts get
 * different dirs, without writing the seed to disk in any readable form.
 * @param {string} mnemonic
 * @param {string} network
 * @returns {string}
 */
function storageDirFor(mnemonic, network) {
  const id = crypto.createHash('sha256').update(mnemonic).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.blink', 'spark', `${network}-${id}`);
}

/**
 * Verify the SDK's SQLite storage backend can actually be opened.
 *
 * The Node build of the Spark SDK stores wallet state in SQLite via
 * `better-sqlite3`, a NATIVE module that must be compiled at install time. When
 * npm runs with `--ignore-scripts` (common in CI, sandboxes and locked-down
 * corporate installs) the package is unpacked but never built, and the SDK
 * SUPPRESSES the resulting warning. `require()` of the SDK then succeeds, so
 * everything looks installed — and each `spark-*` command instead fails deep
 * inside `connect()` with `Could not locate the bindings file`.
 *
 * We do NOT probe the SDK's own `defaultStorage()` factory: in 0.23.1 that
 * factory is lazy — it returns an object without opening a database, so the
 * probe passes even when the native binding is absent, which is exactly the
 * failure this preflight exists to catch. Instead we require `better-sqlite3`
 * directly and open a database ourselves. `better-sqlite3` is already the
 * SDK's own dependency, so this adds nothing new to the install.
 *
 * @throws {Error} If the native binding cannot be required or a database cannot
 *         be opened.
 */
function assertStorageAvailable() {
  let betterSqlite3;
  try {
    // Resolve from the SDK's own tree so we test the SAME copy the SDK will
    // load, not a possibly-different hoisted one.
    const sdkPath = require.resolve(SPARK_PACKAGE);
    betterSqlite3 = require(require.resolve('better-sqlite3', { paths: [sdkPath] }));
  } catch (err) {
    // If we cannot even resolve the SDK package, the problem is the SDK install
    // layout, not better-sqlite3's compilation — name it differently so the
    // remediation isn't a rebuild that can't help.
    if (err && err.code === 'MODULE_NOT_FOUND' && /breez-sdk-spark/.test(String(err.message))) {
      const e = new Error(
        `Could not resolve the Breez Spark SDK (${SPARK_PACKAGE}) to probe its storage backend. ` +
          `Reinstall it: npm install ${SPARK_PACKAGE}. Original error: ${err.message}`,
      );
      e.code = 'SPARK_STORAGE_UNAVAILABLE';
      throw e;
    }
    throw storageUnavailableError(err);
  }

  try {
    const probe = new betterSqlite3(':memory:');
    try {
      probe.prepare('SELECT 1 AS ok').get();
    } finally {
      probe.close();
    }
  } catch (err) {
    // The bindings file is missing or unloadable: present, but not compiled.
    throw storageUnavailableError(err);
  }
}

/**
 * Build the actionable SPARK_STORAGE_UNAVAILABLE error. The remediation names
 * the package-manager build-script approval step, because on pnpm/yarn and on
 * npm with an install-scripts allowlist, a bare `npm rebuild` exits 0 while
 * still not producing a usable binding — verify by opening a database, not by
 * trusting the rebuild exit code.
 *
 * @param {Error} err
 * @returns {Error}
 */
function storageUnavailableError(err) {
  const e = new Error(
    `The Breez Spark SDK is installed but its SQLite storage backend is not usable.\n` +
      `${SPARK_PACKAGE} stores wallet state through the native module \`better-sqlite3\`,\n` +
      `which must be COMPILED during install.\n\n` +
      `This usually means the install ran without build scripts enabled. Approve and\n` +
      `run the build for your package manager, then VERIFY it by opening a database —\n` +
      `a rebuild can exit 0 while still not producing a working binding:\n` +
      `    npm:    npm rebuild better-sqlite3   (if scripts were blocked, allow them)\n` +
      `    pnpm:   pnpm approve-builds  then  pnpm rebuild better-sqlite3\n` +
      `    yarn:   yarn rebuild better-sqlite3\n` +
      `Building requires python3, make and a C++ compiler (build-essential).\n` +
      `Original storage error: ${err.message}`,
  );
  e.code = 'SPARK_STORAGE_UNAVAILABLE';
  return e;
}

/**
 * Create the wallet-state dir owner-only and FAIL CLOSED if that cannot be
 * established.
 *
 * Without `mode`, mkdirSync honours the umask (0775 under a typical 022), so
 * group users could traverse or modify state belonging to a seed-controlled
 * Bitcoin wallet. We therefore:
 *   1. reject a symlink (or any non-directory) at the target — a pre-placed
 *      symlink could redirect the wallet state somewhere an attacker controls;
 *   2. create with mode 0700 and chmod unconditionally so a permissively
 *      created dir from an earlier run is repaired;
 *   3. VERIFY the postcondition — no group or world bits may remain — and throw
 *      if they do. A swallowed chmod failure that left the dir at 0777 must be
 *      a hard error, not a silent pass, because connect() is about to write
 *      seed-controlled wallet state there.
 *
 * @param {string} dir
 * @throws {Error} SPARK_STORAGE_PERMISSIONS if owner-only cannot be established.
 */
function ensureOwnerOnlyDir(dir) {
  const fs = require('fs');

  // Reject a symlink/non-directory BEFORE creating, using lstat so we see the
  // link itself rather than following it.
  try {
    const lst = fs.lstatSync(dir);
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      const e = new Error(
        `Refusing to use wallet-state path '${dir}': it exists but is a ${lst.isSymbolicLink() ? 'symlink' : 'non-directory'}. ` +
          'Remove it or point the storage elsewhere; a pre-placed symlink could redirect wallet state.',
      );
      e.code = 'SPARK_STORAGE_PERMISSIONS';
      throw e;
    }
  } catch (err) {
    if (err && err.code === 'SPARK_STORAGE_PERMISSIONS') throw err;
    // ENOENT: doesn't exist yet — fall through to create.
    if (!err || err.code !== 'ENOENT') throw err;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    const e = new Error(
      `Could not make the wallet-state dir owner-only at '${dir}': ${err.message}. ` +
        'Wallet state belongs to a seed-controlled account and must not be group/world accessible.',
    );
    e.code = 'SPARK_STORAGE_PERMISSIONS';
    throw e;
  }

  // Verify the postcondition rather than trusting the calls above.
  const mode = fs.statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const e = new Error(
      `Wallet-state dir '${dir}' has mode ${mode.toString(8)} after hardening; group/world bits must be 0. ` +
        'Refusing to write seed-controlled wallet state there.',
    );
    e.code = 'SPARK_STORAGE_PERMISSIONS';
    throw e;
  }
}

/**
 * Connect to the Breez Spark SDK using the seed from SPARK_MNEMONIC.
 *
 * @param {object} [opts]
 * @param {string} [opts.network]  "mainnet" (default) or "regtest".
 * @returns {Promise<{ sdk: object, disconnect: () => Promise<void> }>}
 */
async function connect({ network = DEFAULT_NETWORK } = {}) {
  requireNode22();
  const mod = loadSdkModule();
  const mnemonic = getMnemonic();
  const apiKey = getBreezApiKey();

  const config = mod.defaultConfig(network);
  config.apiKey = apiKey;

  const storageDir = storageDirFor(mnemonic, network);
  ensureOwnerOnlyDir(storageDir);

  // Fail fast with a build-tools message rather than an opaque bindings error.
  assertStorageAvailable();

  const sdk = await mod.connect({
    config,
    seed: { type: 'mnemonic', mnemonic, passphrase: undefined },
    storageDir,
  });

  const disconnect = async () => {
    // Bounded: the SDK's disconnect can hang; never let cleanup block the caller.
    try {
      await Promise.race([sdk.disconnect(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    } catch {
      // best-effort
    }
  };

  return { sdk, disconnect };
}

/**
 * Normalize the SDK's getInfo() response into a stable shape.
 * The SDK exposes balance as `balanceSats` (a BigInt in some builds).
 * @param {object} info
 * @returns {{ balanceSats: number }}
 */
function normalizeInfo(info) {
  const raw = info && info.balanceSats !== null && info.balanceSats !== undefined ? info.balanceSats : 0;
  return { balanceSats: Number(raw) };
}

/**
 * Read a balance that is stable, not a mid-sync transient.
 *
 * Right after an incoming Spark payment, `getInfo({ ensureSynced: true })` can
 * return before the payment finishes claiming, so a naive read can be
 * transiently low (observed live: 2000 -> 1176 -> 2200). This polls until the
 * balance repeats across two consecutive reads, or a bounded timeout elapses,
 * whichever comes first.
 *
 * The deadline starts AFTER the first read, not before it. The first read
 * carries the sync and can cost more than the entire polling budget (measured
 * 6.35s against SDK 0.23.1, versus a 5s default budget); timing from before it
 * meant the loop never ran, `prev` stayed null, and the final `cur === prev`
 * compared against null — reporting `stable: false` for a balance that had not
 * moved. Subsequent reads are effectively free (~0-1ms) once synced.
 *
 * @param {object} sdk
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs]   Cap on the comparison window, excluding
 *                                    the initial sync read (default 5000).
 * @param {number} [opts.intervalMs]  Poll interval (default 1000).
 * @returns {Promise<{ balanceSats: number, stable: boolean }>}
 */
async function waitForStableBalance(sdk, { maxWaitMs = 5000, intervalMs = 1000 } = {}) {
  let prev = null;
  // First read — carries the sync, so it is timed separately from the window.
  let cur = normalizeInfo(await sdk.getInfo({ ensureSynced: true })).balanceSats;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (prev !== null && cur === prev) {
      return { balanceSats: cur, stable: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    prev = cur;
    cur = normalizeInfo(await sdk.getInfo({ ensureSynced: true })).balanceSats;
  }
  // Timed out — return the last read, flagged as not confirmed-stable. `prev`
  // is null when only one read was taken, which is unconfirmed, not equal.
  return { balanceSats: cur, stable: prev !== null && cur === prev };
}

/**
 * Normalize a single Payment record from listPayments() defensively across
 * SDK versions.
 * @param {object} p
 * @returns {object}
 */
function normalizePayment(p) {
  if (!p || typeof p !== 'object') return { raw: p };
  const has = (v) => v !== null && v !== undefined;

  // The SDK `Payment` shape (v0.18) uses `amount` and `fees` (both bigint).
  // Fall back to older/alt field names defensively.
  const amount = has(p.amount) ? p.amount : p.amountSats;
  let fee = null;
  if (has(p.fees)) fee = p.fees;
  else if (has(p.feesSats)) fee = p.feesSats;
  else if (has(p.feeSats)) fee = p.feeSats;

  return {
    id: p.id || p.paymentHash || p.txId || null,
    type: p.paymentType || p.type || null, // "send" | "receive"
    status: p.status || null,
    amountSats: has(amount) ? Number(amount) : null,
    feeSats: has(fee) ? Number(fee) : null,
    timestamp: has(p.timestamp) ? Number(p.timestamp) : null,
  };
}

module.exports = {
  SPARK_PACKAGE,
  DEFAULT_NETWORK,
  loadSdkModule,
  requireNode22,
  validateMnemonicChecksum,
  getMnemonic,
  getBreezApiKey,
  storageDirFor,
  ensureOwnerOnlyDir,
  assertStorageAvailable,
  connect,
  normalizeInfo,
  waitForStableBalance,
  normalizePayment,
};
