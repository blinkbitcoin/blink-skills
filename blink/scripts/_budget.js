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
const LOCK_STALE_MS = 5000;

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
 * Acquire an inter-process lock for spending-log updates (check-and-record
 * spans two processes only via this file). Uses O_EXCL creation as the mutex;
 * a lock older than LOCK_STALE_MS is treated as abandoned by a crashed process
 * and broken. Returns false instead of wedging a payment command when the lock
 * cannot be obtained in time.
 *
 * @returns {boolean} true when the lock is held (must be released), false when
 *   the caller should proceed unlocked rather than block.
 */
function acquireLogLock() {
  fs.mkdirSync(BLINK_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOG_LOCK_FILE, 'wx');
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOG_LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOG_LOCK_FILE);
          continue;
        }
      } catch {
        continue; // lock vanished between stat and our next attempt
      }
      if (Date.now() >= deadline) return false;
      sleepSync(10);
    }
  }
}

/**
 * Release the spending-log lock. Best effort: a missing lock file is fine.
 */
function releaseLogLock() {
  try {
    fs.unlinkSync(LOG_LOCK_FILE);
  } catch {
    /* already gone */
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
      reason:
        'NO_BUDGET_CONFIGURED: autonomous payment requires explicit spending limits. ' +
        'Set BLINK_BUDGET_HOURLY_SATS / BLINK_BUDGET_DAILY_SATS (env) or run ' +
        '`blink budget set --hourly <sats> --daily <sats>` before auto-paying.',
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
 * The read-modify-write runs under the inter-process lock so two concurrent
 * payment commands cannot overwrite each other's entry. Throws on failure —
 * callers decide whether a failed recording is fatal for them (payment
 * commands surface it as a warning; the payment itself already happened).
 *
 * @param {object}  entry
 * @param {number}  entry.sats     Amount spent in satoshis.
 * @param {string}  entry.command  Command name (e.g. 'pay-invoice', 'spark-send').
 * @param {string|null} entry.domain  Domain (for L402 payments) or null.
 */
function recordSpend({ sats, command, domain = null }) {
  const locked = acquireLogLock();
  try {
    const log = readLog();
    log.push({ ts: Date.now(), sats, command, domain });
    writeLog(log);
  } finally {
    if (locked) releaseLogLock();
  }
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
 * Clear the spending log.
 *
 * @returns {number}  Number of entries removed.
 */
function resetLog() {
  const log = readLog();
  const count = log.length;
  writeLog([]);
  return count;
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
  BLINK_DIR,

  // Config
  getConfig,
  writeConfig,

  // Log
  readLog,
  writeLog,
  recordSpend,
  getLog,
  resetLog,

  // Budget
  sumSpending,
  checkBudget,
  getStatus,

  // Domain
  checkDomainAllowed,
};
