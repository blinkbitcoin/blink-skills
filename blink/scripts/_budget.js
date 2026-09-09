/**
 * Blink Wallet — Budget Controls Module
 *
 * Provides rolling spend limits (per-hour, per-day) and domain allowlist
 * for L402 auto-pay. Used by all outbound payment scripts.
 *
 * Configuration resolves in this order (env vars take precedence):
 *   1. BLINK_BUDGET_HOURLY_SATS / BLINK_BUDGET_DAILY_SATS env vars
 *   2. BLINK_L402_ALLOWED_DOMAINS env var (comma-separated)
 *   3. ~/.blink/budget.json config file
 *
 * Spending log persisted at ~/.blink/spending-log.json.
 * Entries older than 25 hours are auto-pruned on every write.
 *
 * Zero external dependencies — Node.js 18+ built-ins only.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Paths ────────────────────────────────────────────────────────────────────

const BLINK_DIR = path.join(os.homedir(), '.blink');
const CONFIG_FILE = path.join(BLINK_DIR, 'budget.json');
const LOG_FILE = path.join(BLINK_DIR, 'spending-log.json');

// ── Time constants ───────────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const PRUNE_THRESHOLD_MS = 25 * ONE_HOUR_MS; // keep 25h for safe daily window

// ── Config resolution ────────────────────────────────────────────────────────

/**
 * Read budget config from env vars and ~/.blink/budget.json.
 * Env vars take precedence over the config file.
 *
 * @returns {{
 *   hourlyLimitSats: number|null,
 *   dailyLimitSats: number|null,
 *   allowlist: string[],
 *   enabled: boolean
 * }}
 */
function getConfig() {
  // Read config file (if it exists)
  let fileConfig = {};
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    fileConfig = JSON.parse(content);
  } catch {
    // No config file or invalid JSON — use defaults
  }

  // Env vars override file config
  const envHourly = process.env.BLINK_BUDGET_HOURLY_SATS;
  const envDaily = process.env.BLINK_BUDGET_DAILY_SATS;
  const envDomains = process.env.BLINK_L402_ALLOWED_DOMAINS;

  const hourlyLimitSats =
    envHourly !== undefined ? parsePositiveIntOrNull(envHourly) : (fileConfig.hourlyLimitSats ?? null);
  const dailyLimitSats =
    envDaily !== undefined ? parsePositiveIntOrNull(envDaily) : (fileConfig.dailyLimitSats ?? null);

  let allowlist;
  if (envDomains !== undefined) {
    allowlist = envDomains
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  } else {
    allowlist = Array.isArray(fileConfig.allowlist)
      ? fileConfig.allowlist.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
      : [];
  }

  const enabled = hourlyLimitSats !== null || dailyLimitSats !== null;

  return { hourlyLimitSats, dailyLimitSats, allowlist, enabled };
}

/**
 * Write budget config to ~/.blink/budget.json.
 *
 * @param {object} config
 */
function writeConfig(config) {
  fs.mkdirSync(BLINK_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ── Spending log I/O ─────────────────────────────────────────────────────────

const LOG_LOCK_FILE = path.join(BLINK_DIR, '.spending-log.lock');
const crypto = require('node:crypto');

// How long a caller waits for the lock before failing closed. Mutable via
// setLockTiming so tests can exercise timeouts without real waits.
// NOTE: there is deliberately NO automatic stale takeover. Pathname-based
// mtime staleness cannot validate ownership atomically (a successor can be
// unlinked mid-takeover; an old owner can clobber a successor), and this repo
// takes no native deps, so no OS-backed advisory lock is available. The safe
// alternative — and the one reviewers recommended — is fail-closed on
// timeout with explicit operator recovery (delete the lock file by hand).
const lockTiming = { acquireTimeoutMs: 2000 };
function setLockTiming({ acquireTimeoutMs } = {}) {
  if (acquireTimeoutMs !== undefined) lockTiming.acquireTimeoutMs = acquireTimeoutMs;
}

/**
 * Synchronous sleep that does not spin the CPU where supported.
 * Atomics.wait throws on the main thread in some environments; busy-wait then.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * Acquire an inter-process lock for spending-log mutations. O_EXCL creation is
 * the mutex; the file content is a unique OWNERSHIP TOKEN so release can never
 * delete a successor's lock.
 *
 * Failure is loud, never fail-open: a lock that cannot be acquired in time
 * throws BUDGET_LOCK_TIMEOUT (the caller must not mutate the log unlocked)
 * and the message includes the explicit operator recovery for a lock left by
 * a crashed process. There is NO automatic stale takeover — see the note at
 * lockTiming for why pathname-based staleness was removed.
 *
 * @returns {string} the ownership token (pass to releaseLogLock).
 * @throws {Error} code BUDGET_LOCK_TIMEOUT.
 */
function acquireLogLock() {
  fs.mkdirSync(BLINK_DIR, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + lockTiming.acquireTimeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(LOG_LOCK_FILE, 'wx');
      try {
        fs.writeFileSync(fd, token, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        const err = new Error(
          `Timed out after ${lockTiming.acquireTimeoutMs}ms waiting for the budget lock — refusing to mutate the spending log unlocked. ` +
            `If no budget command is running, a crashed process may have left the lock behind; remove it manually: rm ${LOG_LOCK_FILE}`,
        );
        err.code = 'BUDGET_LOCK_TIMEOUT';
        throw err;
      }
      sleepSync(10);
    }
  }
}

/**
 * Release the spending-log lock — but ONLY if we still own it. A missing file
 * is fine (already released); a file holding someone else's token is left
 * strictly alone.
 *
 * @param {string} token  The token returned by acquireLogLock.
 */
function releaseLogLock(token) {
  let content;
  try {
    content = fs.readFileSync(LOG_LOCK_FILE, 'utf8');
  } catch {
    return; // already gone — nothing to release
  }
  if (content === token) {
    try {
      fs.unlinkSync(LOG_LOCK_FILE);
    } catch {
      /* vanished or replaced — the successor's lock must not be touched */
    }
  }
}

/**
 * Run a log MUTATION under the inter-process lock: lock -> read -> mutate ->
 * atomic write -> release. Every writer must go through this primitive so no
 * mutation path can bypass the lock (recordSpend, resetLog, reservations).
 * The lock is never held across a payment — mutations are short.
 *
 * Ownership is re-checked before the write: if our lock was declared stale
 * and replaced while a mutation stalled, writing would clobber the
 * successor's state — refuse loudly instead.
 *
 * @param {(log: Array) => any} mutator  Mutates the log array in place; its
 *   return value is passed through.
 */
function mutateLog(mutator) {
  const token = acquireLogLock();
  try {
    const log = readLog();
    const result = mutator(log);
    let current;
    try {
      current = fs.readFileSync(LOG_LOCK_FILE, 'utf8');
    } catch {
      current = null; // vanished — could be a stale break + replacement
    }
    if (current !== token) {
      const err = new Error(
        'Budget lock was lost to staleness before the write completed — refusing to clobber a successor\u2019s log state.',
      );
      err.code = 'BUDGET_LOCK_LOST';
      throw err;
    }
    writeLog(log);
    return result;
  } finally {
    releaseLogLock(token);
  }
}

/**
 * Read the spending log from disk.
 * Returns an empty array if the file does not exist.
 *
 * @returns {Array<{ ts: number, sats: number, command: string, domain: string|null }>}
 */
function readLog() {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write the spending log, pruning entries older than 25 hours.
 *
 * The write is ATOMIC: content goes to a temp file that is renamed over the
 * log. A concurrent reader therefore never sees a half-written file, and a
 * crash cannot leave a truncated log behind. (This closes the torn-read half
 * of the race; the read-modify-write half is handled by acquireLogLock in
 * recordSpend.)
 *
 * @param {Array} entries
 */
function writeLog(entries) {
  const cutoff = Date.now() - PRUNE_THRESHOLD_MS;
  const pruned = entries.filter((e) => e.ts > cutoff);
  fs.mkdirSync(BLINK_DIR, { recursive: true });
  const tmp = `${LOG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), 'utf8');
  fs.renameSync(tmp, LOG_FILE);
}

// ── Budget check ─────────────────────────────────────────────────────────────

/**
 * Calculate spending in rolling windows.
 *
 * @param {Array}  log         Spending log entries.
 * @param {number} [nowMs]     Override current time for testing.
 * @returns {{ hourlySpent: number, dailySpent: number }}
 */
function sumSpending(log, nowMs) {
  const now = nowMs ?? Date.now();
  const hourAgo = now - ONE_HOUR_MS;
  const dayAgo = now - ONE_DAY_MS;
  let hourlySpent = 0;
  let dailySpent = 0;
  for (const entry of log) {
    if (entry.ts > dayAgo) {
      dailySpent += entry.sats;
      if (entry.ts > hourAgo) {
        hourlySpent += entry.sats;
      }
    }
  }
  return { hourlySpent, dailySpent };
}

/**
 * Check if a payment of `amountSats` is within budget.
 *
 * Returns { allowed: true } or { allowed: false, reason, ... } with details.
 *
 * Fails closed by default: an unconfigured budget DENIES the payment, matching
 * checkDomainAllowed. Callers that are explicitly user-initiated — the one-shot
 * pay-invoice / pay-lnaddress / pay-lnurl commands, and reporting-only readers
 * such as dry-run output — opt out with `requireConfigured: false`.
 *
 * The safe behaviour is the default deliberately. These two functions are the
 * two halves of one spending guard, so opposite defaults would mean a future
 * autonomous caller that forgets the flag silently spends without limits.
 * Opting out is now a visible, greppable decision at each call site.
 *
 * @param {number}  amountSats
 * @param {object}  [opts]
 * @param {boolean} [opts.requireConfigured=true]  Deny when no budget is configured.
 * @param {number}  [opts.nowMs]  Override current time for testing.
 * @returns {{
 *   allowed: boolean,
 *   reason?: string,
 *   hourlySpent: number,
 *   dailySpent: number,
 *   hourlyLimit: number|null,
 *   dailyLimit: number|null,
 *   hourlyRemaining: number|null,
 *   dailyRemaining: number|null,
 *   effectiveRemaining: number|null
 * }}
 */
function checkBudget(amountSats, opts = {}) {
  const requireConfigured = opts.requireConfigured !== false;
  const config = getConfig();

  if (!config.enabled && requireConfigured) {
    return {
      allowed: false,
      reason: NO_BUDGET_CONFIGURED_REASON,
      hourlySpent: 0,
      dailySpent: 0,
      hourlyLimit: null,
      dailyLimit: null,
      hourlyRemaining: null,
      dailyRemaining: null,
      effectiveRemaining: null,
    };
  }

  if (!config.enabled) {
    return {
      allowed: true,
      hourlySpent: 0,
      dailySpent: 0,
      hourlyLimit: null,
      dailyLimit: null,
      hourlyRemaining: null,
      dailyRemaining: null,
      effectiveRemaining: null,
    };
  }

  const log = readLog();
  const { hourlySpent, dailySpent } = sumSpending(log, opts.nowMs);

  const hourlyRemaining = config.hourlyLimitSats !== null ? config.hourlyLimitSats - hourlySpent : null;
  const dailyRemaining = config.dailyLimitSats !== null ? config.dailyLimitSats - dailySpent : null;

  const effectiveParts = [hourlyRemaining, dailyRemaining].filter((v) => v !== null);
  const effectiveRemaining = effectiveParts.length > 0 ? Math.min(...effectiveParts) : null;

  const base = {
    hourlySpent,
    dailySpent,
    hourlyLimit: config.hourlyLimitSats,
    dailyLimit: config.dailyLimitSats,
    hourlyRemaining,
    dailyRemaining,
    effectiveRemaining,
  };

  if (config.hourlyLimitSats !== null && hourlySpent + amountSats > config.hourlyLimitSats) {
    return {
      allowed: false,
      reason: `Hourly budget exceeded: ${hourlySpent} + ${amountSats} = ${hourlySpent + amountSats} sats > ${config.hourlyLimitSats} sats limit. Remaining: ${Math.max(0, config.hourlyLimitSats - hourlySpent)} sats.`,
      ...base,
    };
  }

  if (config.dailyLimitSats !== null && dailySpent + amountSats > config.dailyLimitSats) {
    return {
      allowed: false,
      reason: `Daily budget exceeded: ${dailySpent} + ${amountSats} = ${dailySpent + amountSats} sats > ${config.dailyLimitSats} sats limit. Remaining: ${Math.max(0, config.dailyLimitSats - dailySpent)} sats.`,
      ...base,
    };
  }

  return { allowed: true, ...base };
}

/**
 * Get current budget status (for `blink budget status`).
 *
 * @param {object}  [opts]
 * @param {number}  [opts.nowMs]
 * @returns {object}
 */
function getStatus(opts = {}) {
  const config = getConfig();
  const log = readLog();
  const { hourlySpent, dailySpent } = sumSpending(log, opts.nowMs);

  const hourlyRemaining = config.hourlyLimitSats !== null ? Math.max(0, config.hourlyLimitSats - hourlySpent) : null;
  const dailyRemaining = config.dailyLimitSats !== null ? Math.max(0, config.dailyLimitSats - dailySpent) : null;

  const effectiveParts = [hourlyRemaining, dailyRemaining].filter((v) => v !== null);
  const effectiveRemaining = effectiveParts.length > 0 ? Math.min(...effectiveParts) : null;

  return {
    enabled: config.enabled,
    hourlyLimit: config.hourlyLimitSats,
    dailyLimit: config.dailyLimitSats,
    hourlySpent,
    dailySpent,
    hourlyRemaining,
    dailyRemaining,
    effectiveRemaining,
    allowlist: config.allowlist,
    logEntries: log.length,
  };
}

// ── Domain allowlist ─────────────────────────────────────────────────────────

/**
 * Check if a domain is allowed for L402 auto-pay.
 *
 * Fail closed: when the allowlist is empty, autonomous payments are denied
 * (pass `requireConfigured: false` for reporting-only callers that just want
 * to display current status). Matching is case-insensitive on the hostname.
 *
 * @param {string}  domain  Hostname to check.
 * @param {object}  [opts]
 * @param {boolean} [opts.requireConfigured=true]  Deny when allowlist is empty.
 * @returns {{ allowed: boolean, reason?: string, allowlist: string[] }}
 */
function checkDomainAllowed(domain, opts = {}) {
  const requireConfigured = opts.requireConfigured !== false;
  const config = getConfig();
  if (config.allowlist.length === 0) {
    if (requireConfigured) {
      return {
        allowed: false,
        reason:
          'NO_ALLOWLIST_CONFIGURED: L402 auto-pay requires an explicit domain ' +
          `allowlist. Add "${domain}" with: blink budget allowlist add ${domain}`,
        allowlist: [],
      };
    }
    return { allowed: true, allowlist: [] };
  }
  const normalized = domain.toLowerCase();
  const allowed = config.allowlist.includes(normalized);
  return {
    allowed,
    ...(allowed ? {} : { reason: `Domain "${domain}" is not in the L402 allowlist.` }),
    allowlist: config.allowlist,
  };
}

// ── Record spend ─────────────────────────────────────────────────────────────

/**
 * Record a successful outbound payment in the spending log.
 *
 * Runs under the inter-process lock so concurrent payment commands cannot
 * overwrite each other's entry. Throws on failure — callers decide whether a
 * failed recording is fatal for them (payment commands surface it as a
 * warning; the payment itself already happened).
 *
 * @param {object}  entry
 * @param {number}  entry.sats     Amount spent in satoshis.
 * @param {string}  entry.command  Command name (e.g. 'pay-invoice', 'spark-send').
 * @param {string|null} entry.domain  Domain (for L402 payments) or null.
 */
function recordSpend({ sats, command, domain = null }) {
  return mutateLog((log) => {
    log.push({ ts: Date.now(), sats, command, domain });
  });
}

// ── Reservations ─────────────────────────────────────────────────────────────
//
// checkBudget -> send -> recordSpend is not atomic: two concurrent sends can
// both observe the same remaining budget and both execute, exceeding a
// configured LIMIT. The fix is to RESERVE the amount under the same lock that
// arbitrates the log, before the payment executes:
//
//   reserveBudget()   decision + reservation append in ONE critical section
//   ... payment executes ...
//   finalizeReservation()  reservation becomes a normal spend entry
//   releaseReservation()   payment failed — remove the reservation
//
// A reservation that is never finalized (crash between send and finalize)
// keeps counting against the budget — fail-closed — until the 25h pruning
// removes it. sumSpending counts reserved entries exactly like spends.

const NO_BUDGET_CONFIGURED_REASON =
  'NO_BUDGET_CONFIGURED: autonomous payment requires explicit spending limits. ' +
  'Set BLINK_BUDGET_HOURLY_SATS / BLINK_BUDGET_DAILY_SATS (env) or run ' +
  '`blink budget set --hourly <sats> --daily <sats>` before auto-paying.';

/**
 * Reserve `sats` against the configured budget and return a reservation id.
 *
 * The limit decision and the reservation write happen under the same lock, so
 * two concurrent payments can never both pass the same remaining budget.
 * When no budget is configured the result is `{ allowed: true, id: null }`
 * (or a denial with the NO_BUDGET_CONFIGURED reason when called with
 * `requireConfigured: true` — the fail-closed default of autonomous callers).
 * With `id: null` there is nothing to finalize; callers record the spend with
 * recordSpend() after success instead, preserving unconfigured logging.
 *
 * @param {object} entry       { sats, command, domain }
 * @param {object} [opts]      { requireConfigured = true, nowMs }
 * @returns {{ allowed: true, id: string|null } | { allowed: false, reason: string }}
 */
function reserveBudget({ sats, command, domain = null }, opts = {}) {
  const requireConfigured = opts.requireConfigured !== false;
  const config = getConfig();

  if (!config.enabled) {
    if (requireConfigured) {
      return {
        allowed: false,
        reason: NO_BUDGET_CONFIGURED_REASON,
        hourlySpent: 0,
        dailySpent: 0,
        hourlyLimit: null,
        dailyLimit: null,
        hourlyRemaining: null,
        dailyRemaining: null,
        effectiveRemaining: null,
      };
    }
    return { allowed: true, id: null };
  }

  return mutateLog((log) => {
    const { hourlySpent, dailySpent } = sumSpending(log, opts.nowMs);
    const hourlyRemaining = config.hourlyLimitSats !== null ? config.hourlyLimitSats - hourlySpent : null;
    const dailyRemaining = config.dailyLimitSats !== null ? config.dailyLimitSats - dailySpent : null;
    const effectiveParts = [hourlyRemaining, dailyRemaining].filter((v) => v !== null);
    const effectiveRemaining = effectiveParts.length > 0 ? Math.min(...effectiveParts) : null;
    const base = {
      hourlySpent,
      dailySpent,
      hourlyLimit: config.hourlyLimitSats,
      dailyLimit: config.dailyLimitSats,
      hourlyRemaining,
      dailyRemaining,
      effectiveRemaining,
    };

    if (config.hourlyLimitSats !== null && hourlySpent + sats > config.hourlyLimitSats) {
      return {
        allowed: false,
        reason: `Hourly budget exceeded: ${hourlySpent} + ${sats} = ${hourlySpent + sats} sats > ${config.hourlyLimitSats} sats limit. Remaining: ${Math.max(0, config.hourlyLimitSats - hourlySpent)} sats.`,
        ...base,
      };
    }
    if (config.dailyLimitSats !== null && dailySpent + sats > config.dailyLimitSats) {
      return {
        allowed: false,
        reason: `Daily budget exceeded: ${dailySpent} + ${sats} = ${dailySpent + sats} sats > ${config.dailyLimitSats} sats limit. Remaining: ${Math.max(0, config.dailyLimitSats - dailySpent)} sats.`,
        ...base,
      };
    }

    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    log.push({ ts: opts.nowMs ?? Date.now(), sats, command, domain, state: 'reserved', id });
    return { allowed: true, id };
  });
}

/**
 * Convert a reservation into a normal spend entry (the payment succeeded or
 * is legitimately pending). Returns false when the reservation no longer
 * exists — e.g. it was pruned — in which case the budget already counted it.
 */
function finalizeReservation(id) {
  return mutateLog((log) => {
    const i = log.findIndex((e) => e.state === 'reserved' && e.id === id);
    if (i === -1) return false;
    const { ts, sats, command, domain } = log[i];
    log[i] = { ts, sats, command, domain };
    return true;
  });
}

/**
 * Remove a reservation (the payment failed or was never attempted). Returns
 * false when the reservation no longer exists.
 */
function releaseReservation(id) {
  return mutateLog((log) => {
    const i = log.findIndex((e) => e.state === 'reserved' && e.id === id);
    if (i === -1) return false;
    log.splice(i, 1);
    return true;
  });
}

/**
 * Finalize a reservation OR restore accounting when it is missing. Idempotent.
 *
 * `budget reset --force` clears active reservations while a payment may still
 * be in flight; if the reservation is gone when finalize arrives, finalize
 * alone would return false and the settled payment would escape the log
 * entirely — later budget checks would overestimate what is left. This helper
 * writes a normal spend entry in that case (conservative restoration) and
 * returns 'finalized', 'restored', or 'dropped' so the caller can warn.
 *
 * Finalized/restored entries CARRY the reservation id, so calling again with
 * the same id is a no-op ('finalized') instead of appending a duplicate.
 *
 * @returns {'finalized' | 'restored' | 'dropped'}  'dropped' only when id is null.
 */
function finalizeOrRecord(id, { sats, command, domain = null } = {}) {
  if (id === null || id === undefined) return 'dropped';
  return mutateLog((log) => {
    const i = log.findIndex((e) => e.state === 'reserved' && e.id === id);
    if (i !== -1) {
      const { ts } = log[i];
      log[i] = { ts, sats, command, domain, id };
      return 'finalized';
    }
    // Idempotency: already finalized/restored with this id — do not duplicate.
    if (log.some((e) => e.id === id)) return 'finalized';
    // Reservation was erased externally (budget reset --force) or pruned: the
    // payment moved funds, so restore the accounting with a normal spend entry.
    log.push({ ts: Date.now(), sats, command, domain, id });
    return 'restored';
  });
}

// ── Log management ───────────────────────────────────────────────────────────

/**
 * Get recent spending log entries.
 *
 * @param {number} [limit=20]
 * @returns {Array}
 */
function getLog(limit = 20) {
  const log = readLog();
  // Return newest first, limited
  return log.slice(-limit).reverse();
}

/**
 * Clear the spending log — under the same lock as every other mutation.
 *
 * Default semantics preserve ACTIVE RESERVATIONS: a payment may be in flight
 * with its reservation already reserved; clearing it would reopen the
 * allowance window and let a concurrent payment exceed the configured limit.
 * Completed/finalized history is cleared.
 *
 * `{ force: true }` clears EVERYTHING including active reservations — the
 * escape hatch for wedged reservations. An in-flight payment whose
 * reservation was force-cleared is still recorded by finalizeOrRecord, but
 * the freed allowance can be reused in the interim (brief exceed window) —
 * so --force must be documented as unsafe while payments run.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  Also clear active reservations.
 * @returns {{ removed: number, keptReserved: number }}
 */
function resetLog({ force = false } = {}) {
  return mutateLog((log) => {
    if (force) {
      const removed = log.length;
      log.length = 0;
      return { removed, keptReserved: 0 };
    }
    const kept = log.filter((e) => e.state === 'reserved');
    const removed = log.length - kept.length;
    log.length = 0;
    log.push(...kept);
    return { removed, keptReserved: kept.length };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePositiveIntOrNull(value) {
  const n = parseInt(value, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Paths (for testing)
  CONFIG_FILE,
  LOG_FILE,
  LOG_LOCK_FILE,
  BLINK_DIR,

  // Config
  getConfig,
  writeConfig,

  // Log
  readLog,
  writeLog,
  mutateLog,
  recordSpend,
  getLog,
  resetLog,

  // Budget
  sumSpending,
  checkBudget,
  getStatus,

  // Reservations (reserve before the payment executes; finalize or release after)
  reserveBudget,
  finalizeReservation,
  finalizeOrRecord,
  releaseReservation,

  // Domain
  checkDomainAllowed,

  // Lock internals (exported for tests)
  setLockTiming,
  acquireLogLock,
  releaseLogLock,
};
