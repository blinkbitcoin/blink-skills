/**
 * Unit tests for Phase 2b — Budget Controls.
 *
 * Covers:
 *   - _budget.js: config resolution, spending log, budget checks, domain allowlist
 *   - budget.js: CLI subcommands (status, set, log, reset, allowlist)
 *
 * Uses a temp directory for all config/log files to avoid polluting ~/.blink/.
 *
 * Run: node --test test/budget.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');

// ── Test isolation: use a temp dir for all budget files ──────────────────────

let tmpDir;
let origEnv;

function setupTempDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-budget-test-'));
}

function cleanupTempDir() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Save/restore env vars ────────────────────────────────────────────────────

function saveEnv() {
  origEnv = {
    BLINK_BUDGET_HOURLY_SATS: process.env.BLINK_BUDGET_HOURLY_SATS,
    BLINK_BUDGET_DAILY_SATS: process.env.BLINK_BUDGET_DAILY_SATS,
    BLINK_L402_ALLOWED_DOMAINS: process.env.BLINK_L402_ALLOWED_DOMAINS,
  };
  delete process.env.BLINK_BUDGET_HOURLY_SATS;
  delete process.env.BLINK_BUDGET_DAILY_SATS;
  delete process.env.BLINK_L402_ALLOWED_DOMAINS;
}

function restoreEnv() {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
}

/**
 * Load a fresh _budget module with HOME redirected to tmpDir.
 * This causes BLINK_DIR to resolve to tmpDir/.blink instead of ~/.blink.
 */
let origHomedir;
function patchHomedir() {
  origHomedir = os.homedir;
  os.homedir = () => tmpDir;
}
function restoreHomedir() {
  if (origHomedir) os.homedir = origHomedir;
}
function freshBudgetModule() {
  delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
  return require(path.join(scriptsDir, '_budget.js'));
}

// ── sumSpending ──────────────────────────────────────────────────────────────

describe('sumSpending', () => {
  let mod;
  before(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });

  it('returns zeros for empty log', () => {
    const { hourlySpent, dailySpent } = mod.sumSpending([]);
    assert.equal(hourlySpent, 0);
    assert.equal(dailySpent, 0);
  });

  it('sums entries within the last hour', () => {
    const now = Date.now();
    const log = [
      { ts: now - 30 * 60 * 1000, sats: 100, command: 'test' }, // 30min ago
      { ts: now - 10 * 60 * 1000, sats: 200, command: 'test' }, // 10min ago
    ];
    const { hourlySpent, dailySpent } = mod.sumSpending(log, now);
    assert.equal(hourlySpent, 300);
    assert.equal(dailySpent, 300);
  });

  it('separates hourly vs daily entries', () => {
    const now = Date.now();
    const log = [
      { ts: now - 2 * 60 * 60 * 1000, sats: 500, command: 'test' }, // 2h ago (daily only)
      { ts: now - 30 * 60 * 1000, sats: 100, command: 'test' }, // 30min ago (both)
    ];
    const { hourlySpent, dailySpent } = mod.sumSpending(log, now);
    assert.equal(hourlySpent, 100);
    assert.equal(dailySpent, 600);
  });

  it('excludes entries older than 24 hours', () => {
    const now = Date.now();
    const log = [
      { ts: now - 25 * 60 * 60 * 1000, sats: 9999, command: 'test' }, // 25h ago
      { ts: now - 100, sats: 50, command: 'test' }, // just now
    ];
    const { hourlySpent, dailySpent } = mod.sumSpending(log, now);
    assert.equal(hourlySpent, 50);
    assert.equal(dailySpent, 50);
  });
});

// ── getConfig ────────────────────────────────────────────────────────────────

describe('getConfig', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    delete process.env.BLINK_BUDGET_HOURLY_SATS;
    delete process.env.BLINK_BUDGET_DAILY_SATS;
    delete process.env.BLINK_L402_ALLOWED_DOMAINS;
  });

  it('returns defaults when no config file and no env vars', () => {
    const config = mod.getConfig();
    assert.equal(config.hourlyLimitSats, null);
    assert.equal(config.dailyLimitSats, null);
    assert.deepEqual(config.allowlist, []);
    assert.equal(config.enabled, false);
  });

  it('reads env vars', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '500';
    process.env.BLINK_BUDGET_DAILY_SATS = '2000';
    const config = mod.getConfig();
    assert.equal(config.hourlyLimitSats, 500);
    assert.equal(config.dailyLimitSats, 2000);
    assert.equal(config.enabled, true);
  });

  it('reads domain allowlist from env var', () => {
    process.env.BLINK_L402_ALLOWED_DOMAINS = 'satring.com, l402.services , L402.DIRECTORY';
    const config = mod.getConfig();
    assert.deepEqual(config.allowlist, ['satring.com', 'l402.services', 'l402.directory']);
  });

  it('env vars override config file', () => {
    // Write a config file
    fs.mkdirSync(path.dirname(mod.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(mod.CONFIG_FILE, JSON.stringify({ hourlyLimitSats: 100, dailyLimitSats: 500 }), 'utf8');
    // Set env var that overrides hourly only
    process.env.BLINK_BUDGET_HOURLY_SATS = '999';
    const config = mod.getConfig();
    assert.equal(config.hourlyLimitSats, 999);
    assert.equal(config.dailyLimitSats, 500); // from file
    // Cleanup
    try {
      fs.unlinkSync(mod.CONFIG_FILE);
    } catch {
      /* ok */
    }
  });

  it('a garbage env var names the variable and the correct recovery (not the file)', () => {
    process.env.BLINK_BUDGET_DAILY_SATS = 'abc';
    assert.throws(
      () => mod.getConfig(),
      (e) =>
        e.code === 'BUDGET_ENV_INVALID' &&
        e.message.includes('BLINK_BUDGET_DAILY_SATS') &&
        /unset it/.test(e.message) &&
        !/budget\.json/.test(e.message),
    );
  });

  it('a corrupt config file fails closed instead of disabling limits', () => {
    fs.mkdirSync(path.dirname(mod.CONFIG_FILE), { recursive: true });
    fs.writeFileSync(mod.CONFIG_FILE, '{"hourlyLimitSats":', 'utf8');
    try {
      assert.throws(
        () => mod.getConfig(),
        (e) => e.code === 'BUDGET_CONFIG_CORRUPT',
      );
    } finally {
      fs.unlinkSync(mod.CONFIG_FILE);
    }
  });

  it('structurally invalid config values fail closed', () => {
    const bad = [
      JSON.stringify({ hourlyLimitSats: -50 }), // negative limit
      JSON.stringify({ dailyLimitSats: 1.5 }), // fractional
      JSON.stringify({ dailyLimitSats: '1000' }), // wrong type
      JSON.stringify({ allowlist: 'satring.com' }), // allowlist must be an array
      '[1, 2]', // top-level must be an object
    ];
    fs.mkdirSync(path.dirname(mod.CONFIG_FILE), { recursive: true });
    try {
      for (const content of bad) {
        fs.writeFileSync(mod.CONFIG_FILE, content, 'utf8');
        assert.throws(
          () => mod.getConfig(),
          (e) => e.code === 'BUDGET_CONFIG_CORRUPT',
          content,
        );
      }
    } finally {
      fs.unlinkSync(mod.CONFIG_FILE);
    }
  });

  it('an empty-string env var still means unset (documented idiom)', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '';
    const config = mod.getConfig();
    assert.equal(config.hourlyLimitSats, null);
  });
});

// ── checkBudget ──────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    delete process.env.BLINK_BUDGET_HOURLY_SATS;
    delete process.env.BLINK_BUDGET_DAILY_SATS;
    // Clear log
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('denies when no limits are set (fail closed by default)', () => {
    const result = mod.checkBudget(999999);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /NO_BUDGET_CONFIGURED/);
  });

  it('allows any amount when no limits set and the caller opts out', () => {
    // Explicitly user-initiated payments (pay-invoice and friends) stay usable
    // without any budget configuration.
    const result = mod.checkBudget(999999, { requireConfigured: false });
    assert.equal(result.allowed, true);
    assert.equal(result.hourlyLimit, null);
    assert.equal(result.dailyLimit, null);
  });

  it('reports null limits and zero spend in the unconfigured denial', () => {
    const result = mod.checkBudget(10, { requireConfigured: true });
    assert.equal(result.allowed, false);
    assert.equal(result.hourlySpent, 0);
    assert.equal(result.dailySpent, 0);
    assert.equal(result.hourlyLimit, null);
    assert.equal(result.effectiveRemaining, null);
  });

  it('does not deny for unconfigured budget once limits exist', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '1000';
    const result = mod.checkBudget(10);
    assert.equal(result.allowed, true);
    assert.equal(result.hourlyLimit, 1000);
  });

  it('allows when within hourly limit', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '1000';
    const result = mod.checkBudget(500);
    assert.equal(result.allowed, true);
    assert.equal(result.hourlyRemaining, 1000);
  });

  it('denies when exceeding hourly limit', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '100';
    // Write a log entry for 80 sats spent in last hour
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([{ ts: now - 10 * 60 * 1000, sats: 80, command: 'test' }]));
    const result = mod.checkBudget(50, { nowMs: now });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Hourly budget exceeded/);
    assert.equal(result.hourlySpent, 80);
  });

  it('allows exactly at limit', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '100';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([{ ts: now - 5 * 60 * 1000, sats: 50, command: 'test' }]));
    const result = mod.checkBudget(50, { nowMs: now });
    assert.equal(result.allowed, true);
  });

  it('denies when exceeding daily limit', () => {
    process.env.BLINK_BUDGET_DAILY_SATS = '500';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([{ ts: now - 3 * 60 * 60 * 1000, sats: 400, command: 'test' }]));
    const result = mod.checkBudget(200, { nowMs: now });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Daily budget exceeded/);
  });

  it('returns effectiveRemaining as min of hourly and daily', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '100';
    process.env.BLINK_BUDGET_DAILY_SATS = '500';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([{ ts: now - 30 * 60 * 1000, sats: 70, command: 'test' }]));
    const result = mod.checkBudget(10, { nowMs: now });
    assert.equal(result.allowed, true);
    assert.equal(result.hourlyRemaining, 30);
    assert.equal(result.dailyRemaining, 430);
    assert.equal(result.effectiveRemaining, 30);
  });
});

// ── checkDomainAllowed ───────────────────────────────────────────────────────

describe('checkDomainAllowed', () => {
  let mod;
  before(() => {
    saveEnv();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreEnv();
  });
  afterEach(() => {
    delete process.env.BLINK_L402_ALLOWED_DOMAINS;
  });

  it('denies all domains when allowlist is empty (fail closed)', () => {
    const result = mod.checkDomainAllowed('anything.com');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /NO_ALLOWLIST_CONFIGURED/);
    // reporting-only callers can opt out of the configured check
    const report = mod.checkDomainAllowed('anything.com', { requireConfigured: false });
    assert.equal(report.allowed, true);
  });

  it('allows a domain in the allowlist', () => {
    process.env.BLINK_L402_ALLOWED_DOMAINS = 'satring.com,l402.services';
    const result = mod.checkDomainAllowed('satring.com');
    assert.equal(result.allowed, true);
  });

  it('denies a domain not in the allowlist', () => {
    process.env.BLINK_L402_ALLOWED_DOMAINS = 'satring.com,l402.services';
    const result = mod.checkDomainAllowed('evil.com');
    assert.equal(result.allowed, false);
    assert.deepEqual(result.allowlist, ['satring.com', 'l402.services']);
  });

  it('matching is case-insensitive', () => {
    process.env.BLINK_L402_ALLOWED_DOMAINS = 'Satring.COM';
    const result = mod.checkDomainAllowed('satring.com');
    assert.equal(result.allowed, true);
  });
});

// ── recordSpend + writeLog pruning ───────────────────────────────────────────

describe('recordSpend and log pruning', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('appends an entry to the spending log', () => {
    mod.recordSpend({ sats: 100, command: 'pay-invoice', domain: null });
    const log = mod.readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].sats, 100);
    assert.equal(log[0].command, 'pay-invoice');
    assert.equal(log[0].domain, null);
    assert.ok(typeof log[0].ts === 'number');
  });

  it('appends multiple entries', () => {
    mod.recordSpend({ sats: 50, command: 'l402-pay', domain: 'satring.com' });
    mod.recordSpend({ sats: 75, command: 'l402-pay', domain: 'l402.services' });
    const log = mod.readLog();
    assert.equal(log.length, 2);
  });

  it('writeLog prunes entries older than 25 hours', () => {
    const now = Date.now();
    const entries = [
      { ts: now - 26 * 60 * 60 * 1000, sats: 999, command: 'old' }, // 26h ago — pruned
      { ts: now - 1 * 60 * 60 * 1000, sats: 100, command: 'recent' }, // 1h ago — kept
    ];
    mod.writeLog(entries);
    const log = mod.readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].command, 'recent');
  });

  // ── atomicity / locking (review finding: non-atomic check-and-record) ──────

  it('writeLog is atomic: the log is replaced by rename, leaving no temp file', () => {
    mod.writeLog([{ ts: Date.now(), sats: 1, command: 'x' }]);
    const dir = path.dirname(mod.LOG_FILE);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'a crash-resilient write must not leave temp files behind');
    assert.equal(mod.readLog().length, 1, 'the renamed log is valid JSON with the entry');
  });

  it('releases the lock after a successful record', () => {
    const lock = path.join(path.dirname(mod.LOG_FILE), '.spending-log.lock');
    mod.recordSpend({ sats: 3, command: 'lock-release-test' });
    assert.equal(fs.existsSync(lock), false);
  });
});

// ── lock ownership / timeouts (review: fail-open and lock-takeover paths) ────

describe('spending-log lock ownership', () => {
  let mod;
  let lockPath;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
    lockPath = path.join(path.dirname(mod.LOG_FILE), '.spending-log.lock');
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    mod.setLockTiming({ acquireTimeoutMs: 2000 });
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('fails closed with a recovery hint when the lock is held too long (no stale takeover)', () => {
    mod.setLockTiming({ acquireTimeoutMs: 60 });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'foreign-owner', 'utf8');
    try {
      assert.throws(
        () => mod.recordSpend({ sats: 1, command: 'x' }),
        (e) =>
          e.code === 'BUDGET_LOCK_TIMEOUT' &&
          /remove it manually/.test(e.message) &&
          e.message.includes('.spending-log.lock'),
        'the operator must be told how to recover from a crashed lock holder',
      );
      assert.equal(fs.readFileSync(lockPath, 'utf8'), 'foreign-owner', 'no automatic unlink, stale or not');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it('releaseLogLock never deletes a lock acquired by someone else', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const token = mod.acquireLogLock();
    try {
      fs.writeFileSync(lockPath, 'successor-owner', 'utf8'); // takeover while we hold
      mod.releaseLogLock(token);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), 'successor-owner', 'a holder must never unlink a successor lock');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });
});

// ── reservations (review: reserve the amount before the payment executes) ────

describe('reserveBudget / finalizeOrRecord / releaseReservation', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  beforeEach(() => {
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(mod.CONFIG_FILE);
    } catch {
      /* ok */
    }
  });

  it('with no budget configured: allowed with id null (nothing to finalize)', () => {
    const r = mod.reserveBudget({ sats: 100, command: 'x' }, { requireConfigured: false });
    assert.equal(r.allowed, true);
    assert.equal(r.id, null);
  });

  it('requireConfigured denies an unconfigured budget (autonomous callers)', () => {
    const r = mod.reserveBudget({ sats: 100, command: 'x' });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /NO_BUDGET_CONFIGURED/);
  });

  it('a reservation blocks a concurrent reservation of the same remaining budget', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    const r1 = mod.reserveBudget({ sats: 60, command: 'send-a' }, { requireConfigured: false });
    assert.equal(r1.allowed, true);
    assert.ok(r1.id, 'a configured reservation must have an id');
    const r2 = mod.reserveBudget({ sats: 60, command: 'send-b' }, { requireConfigured: false });
    assert.equal(r2.allowed, false, '60 + 60 must exceed the 100-sat limit');
    assert.match(r2.reason, /Daily budget exceeded/);
    const r3 = mod.reserveBudget({ sats: 40, command: 'send-c' }, { requireConfigured: false });
    assert.equal(r3.allowed, true, 'the remaining 40 sats are still reservable');
  });

  it('reserved entries count against checkBudget and getStatus', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    mod.reserveBudget({ sats: 60, command: 'x' }, { requireConfigured: false });
    assert.equal(mod.getStatus().dailySpent, 60);
    assert.equal(mod.checkBudget(50, { requireConfigured: false }).allowed, false);
    assert.equal(mod.checkBudget(40, { requireConfigured: false }).allowed, true);
  });

  it('releaseReservation removes the reservation and frees the budget', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    const r = mod.reserveBudget({ sats: 60, command: 'x' }, { requireConfigured: false });
    assert.equal(mod.releaseReservation(r.id), true);
    assert.deepEqual(mod.readLog(), []);
    const again = mod.reserveBudget({ sats: 100, command: 'x' }, { requireConfigured: false });
    assert.equal(again.allowed, true, 'the full limit must be available after release');
  });

  it('an orphaned reservation keeps blocking (fail-closed) and self-heals via pruning', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    // Simulate a crash after payment: reserve with a 26h-old timestamp and
    // never finalize it.
    const orphan = mod.reserveBudget(
      { sats: 60, command: 'crashed' },
      { requireConfigured: false, nowMs: Date.now() - 26 * 60 * 60 * 1000 },
    );
    assert.equal(orphan.allowed, true);
    // While it is inside the window it blocks; the PRUNE removes it because it
    // is older than 25h, so the next mutation heals the log.
    const next = mod.reserveBudget({ sats: 60, command: 'x' }, { requireConfigured: false });
    assert.equal(next.allowed, true, 'the pruned orphan must no longer count');
    const log = mod.readLog();
    assert.equal(
      log.some((e) => e.id === orphan.id),
      false,
      'the orphan was pruned away',
    );
  });

  it('reset preserves active reservations: a concurrent payment cannot reuse the freed window', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    const a = mod.reserveBudget({ sats: 100, command: 'payment-a' }, { requireConfigured: false });
    assert.equal(a.allowed, true);
    const { removed, keptReserved } = mod.resetLog();
    assert.equal(removed, 0, 'nothing finalized to remove');
    assert.equal(keptReserved, 1, 'the in-flight reservation must survive an ordinary reset');
    const b = mod.reserveBudget({ sats: 100, command: 'payment-b' }, { requireConfigured: false });
    assert.equal(b.allowed, false, 'the limit must still protect the in-flight payment after reset');
    assert.equal(mod.finalizeOrRecord(a.id, { sats: 100, command: 'payment-a' }), 'finalized');
    assert.equal(mod.readLog().length, 1);
  });

  it('reset --force clears everything, and the in-flight finalize is restored afterwards', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    const a = mod.reserveBudget({ sats: 100, command: 'payment-a' }, { requireConfigured: false });
    const { removed, keptReserved } = mod.resetLog({ force: true });
    assert.deepEqual({ removed, keptReserved }, { removed: 1, keptReserved: 0 });
    // Documented consequence: the freed window can now be reserved by someone else.
    assert.equal(mod.reserveBudget({ sats: 100, command: 'payment-b' }, { requireConfigured: false }).allowed, true);
    const outcome = mod.finalizeOrRecord(a.id, { sats: 100, command: 'payment-a' });
    assert.equal(outcome, 'restored', 'the settled payment must still be recorded after a force reset');
  });

  it('finalizeOrRecord is idempotent: a retry with the same id appends no duplicate', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    const r = mod.reserveBudget({ sats: 60, command: 'x' }, { requireConfigured: false });
    assert.equal(mod.finalizeOrRecord(r.id, { sats: 60, command: 'x' }), 'finalized');
    assert.equal(mod.finalizeOrRecord(r.id, { sats: 60, command: 'x' }), 'finalized');
    const log = mod.readLog();
    assert.equal(log.length, 1, 'a retried finalize must not double-count the spend');
  });

  it('finalizeOrRecord with a null id is a no-op', () => {
    assert.equal(mod.finalizeOrRecord(null, { sats: 1, command: 'x' }), 'dropped');
    assert.deepEqual(mod.readLog(), []);
  });
});

// ── mutateLog ownership loss (stale break + takeover while stalled) ──────────

describe('mutateLog ownership re-check', () => {
  let mod;
  let lockPath;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
    lockPath = path.join(path.dirname(mod.LOG_FILE), '.spending-log.lock');
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('refuses to write when the lock was taken over mid-mutation (BUDGET_LOCK_LOST)', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Simulate: we acquire, stall past staleness, a successor breaks the lock
    // and writes its own token before our mutation finishes.
    assert.throws(
      () =>
        mod.mutateLog((log) => {
          log.push({ ts: Date.now(), sats: 1, command: 'stalled' });
          fs.writeFileSync(lockPath, 'successor-token', 'utf8'); // takeover during our "stall"
        }),
      (e) => e.code === 'BUDGET_LOCK_LOST',
      'a lost lock must fail loudly instead of clobbering the successor',
    );
    assert.deepEqual(mod.readLog(), [], 'the takeover state must not be clobbered by our write');
  });

  it('does not falsely trip when we still hold the lock', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    mod.mutateLog((log) => {
      log.push({ ts: Date.now(), sats: 1, command: 'ok' });
    });
    assert.equal(mod.readLog().length, 1);
  });
});

// ── corrupt spending log fails closed (review: malformed log read as empty) ──

describe('corrupt spending log fails closed', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(mod.CONFIG_FILE);
    } catch {
      /* ok */
    }
  });

  function writeRaw(content) {
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, content, 'utf8');
  }

  it('a missing file still reads as empty (ENOENT)', () => {
    assert.deepEqual(mod.readLog(), []);
  });

  it('truncated JSON throws BUDGET_LOG_CORRUPT for reads, checks, status, and log views', () => {
    // checkBudget reads the log only when limits are configured.
    mod.writeConfig({ hourlyLimitSats: 1000, dailyLimitSats: 1000, allowlist: [] });
    writeRaw('[{"ts": 1');
    for (const fn of [
      () => mod.readLog(),
      () => mod.checkBudget(100, { requireConfigured: false }),
      () => mod.getStatus(),
      () => mod.getLog(),
    ]) {
      assert.throws(fn, (e) => e.code === 'BUDGET_LOG_CORRUPT' && /reset --force/.test(e.message));
    }
  });

  it('a non-array top-level value throws', () => {
    writeRaw(JSON.stringify({ entries: [] }));
    assert.throws(
      () => mod.readLog(),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
  });

  it('entries missing budget-relevant fields throw', () => {
    writeRaw(JSON.stringify([{ ts: Date.now(), command: 'x' }])); // no sats
    assert.throws(() => mod.readLog(), /entry 0 is malformed/);
  });

  it('a reserved entry without an id throws', () => {
    writeRaw(JSON.stringify([{ ts: Date.now(), sats: 1, command: 'x', state: 'reserved' }]));
    assert.throws(
      () => mod.readLog(),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
  });

  it('semantic entry validation: values that could inflate the budget are rejected', () => {
    const bad = [
      [{ ts: Date.now(), sats: -1000, command: 'x' }], // negative — would CREDIT the budget
      [{ ts: Date.now(), sats: 0, command: 'x' }], // zero
      [{ ts: Date.now(), sats: 1.5, command: 'x' }], // fractional
      [{ ts: Date.now(), sats: Number.MAX_SAFE_INTEGER + 1, command: 'x' }], // unsafe integer
      [{ ts: Date.now(), sats: 1e21, command: 'x' }], // overflow magnitude
      [{ ts: Date.now(), sats: '100', command: 'x' }], // wrong type
      [{ ts: 0, sats: 1, command: 'x' }], // zero timestamp
      [{ ts: -5, sats: 1, command: 'x' }], // negative timestamp
      [{ ts: Date.now() + 10 * 60_000, sats: 1, command: 'x' }], // far-future timestamp
      [{ ts: Date.now(), sats: 1, command: 'x', state: 'pending' }], // unknown state
      [{ ts: Date.now(), sats: 1, command: 'x', domain: 42 }], // wrong-type domain
      [{ ts: Date.now(), sats: 1, command: '' }], // empty command
    ];
    for (const entries of bad) {
      writeRaw(JSON.stringify(entries));
      assert.throws(
        () => mod.readLog(),
        (e) => e.code === 'BUDGET_LOG_CORRUPT',
        `must be rejected: ${JSON.stringify(entries)}`,
      );
    }
  });

  it('duplicate ids are rejected (reservation idempotency relies on uniqueness)', () => {
    writeRaw(
      JSON.stringify([
        { ts: Date.now(), sats: 1, command: 'a', id: 'same' },
        { ts: Date.now(), sats: 1, command: 'b', id: 'same' },
      ]),
    );
    assert.throws(() => mod.readLog(), /duplicate id/);
  });

  it('legacy finalized entries (no state/id) remain valid', () => {
    writeRaw(JSON.stringify([{ ts: Date.now(), sats: 10, command: 'pay-invoice', domain: null }]));
    assert.equal(mod.readLog().length, 1);
  });

  it('a read error (non-ENOENT) throws instead of returning empty', () => {
    const realRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (String(p) === mod.LOG_FILE) {
        const e = new Error('EACCES');
        e.code = 'EACCES';
        throw e;
      }
      return realRead(p, ...rest);
    };
    try {
      assert.throws(
        () => mod.readLog(),
        (e) => e.code === 'BUDGET_LOG_CORRUPT',
      );
    } finally {
      fs.readFileSync = realRead;
    }
  });

  it('recordSpend on a corrupt log throws and does NOT overwrite the damaged file', () => {
    writeRaw('not json');
    assert.throws(
      () => mod.recordSpend({ sats: 5, command: 'x' }),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
    assert.equal(fs.readFileSync(mod.LOG_FILE, 'utf8'), 'not json', 'the damaged file must not be replaced');
  });

  it('reserveBudget on a corrupt log throws (no new reservation over unknown spend)', () => {
    mod.writeConfig({ hourlyLimitSats: null, dailyLimitSats: 100, allowlist: [] });
    writeRaw('garbage[');
    assert.throws(
      () => mod.reserveBudget({ sats: 10, command: 'x' }, { requireConfigured: false }),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
  });

  it('ordinary reset on a corrupt log fails closed and leaves the file untouched', () => {
    writeRaw('garbage');
    assert.throws(
      () => mod.resetLog(),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
    assert.equal(fs.readFileSync(mod.LOG_FILE, 'utf8'), 'garbage', 'unknown in-flight state must not be discarded');
  });

  it('mixed valid-reservation + malformed entry: ordinary reset preserves, --force discards', () => {
    writeRaw(
      JSON.stringify([
        { ts: Date.now(), sats: 60, command: 'x', state: 'reserved', id: 'r1' },
        { ts: Date.now(), sats: 'NaN-ish', command: 'bad' },
      ]),
    );
    // The log is corrupt overall — readLog throws — so an ordinary reset must
    // not silently discard the (possibly in-flight) reservation.
    assert.throws(
      () => mod.resetLog(),
      (e) => e.code === 'BUDGET_LOG_CORRUPT',
    );
    const before = fs.readFileSync(mod.LOG_FILE, 'utf8');
    assert.ok(before.includes('r1'), 'file untouched');
    const r = mod.resetLog({ force: true });
    assert.equal(r.discardedCorrupt, true);
    assert.deepEqual(mod.readLog(), []);
  });

  it('budget reset --force also recovers from a corrupt log', () => {
    writeRaw('[{"ts":');
    const r = mod.resetLog({ force: true });
    assert.equal(r.discardedCorrupt, true);
    assert.deepEqual(mod.readLog(), []);
  });

  it('reset on a healthy log reports discardedCorrupt false', () => {
    mod.recordSpend({ sats: 1, command: 'x' });
    const r = mod.resetLog();
    assert.equal(r.discardedCorrupt, false);
  });

  it('writers refuse reader-invalid entries (writer/reader share one schema)', () => {
    // reserveBudget with sats 0 is the sub-satoshi BOLT-11 path: decodeBolt11
    // rounds 10p to 0, and a plain !== null guard lets it through.
    assert.throws(
      () => mod.reserveBudget({ sats: 0, command: 'x' }, { requireConfigured: false }),
      (e) => e.code === 'BUDGET_INVALID_AMOUNT',
    );
    assert.throws(
      () => mod.reserveBudget({ sats: -100, command: 'x' }, { requireConfigured: false }),
      (e) => e.code === 'BUDGET_INVALID_AMOUNT',
    );
    assert.throws(
      () => mod.recordSpend({ sats: 0, command: 'x' }),
      (e) => e.code === 'BUDGET_INVALID_AMOUNT',
    );
    assert.throws(
      () => mod.finalizeOrRecord('some-id', { sats: 0.5, command: 'x' }),
      (e) => e.code === 'BUDGET_INVALID_AMOUNT',
    );
    assert.throws(
      () => mod.recordSpend({ sats: 10, command: '' }),
      (e) => e.code === 'BUDGET_INVALID_ENTRY',
    );
    assert.throws(
      () => mod.recordSpend({ sats: 10, command: 'x', domain: 42 }),
      (e) => e.code === 'BUDGET_INVALID_ENTRY',
    );
    assert.deepEqual(mod.readLog(), [], 'nothing was persisted that the reader would reject');
  });

  it('writeConfig refuses to persist a value the reader would reject', () => {
    assert.throws(
      () => mod.writeConfig({ dailyLimitSats: 9007199254740992 }),
      (e) => e.code === 'BUDGET_CONFIG_CORRUPT',
    );
    assert.doesNotThrow(() => mod.getConfig(), 'nothing was written');
  });
});

// ── getLog / resetLog ────────────────────────────────────────────────────────

describe('getLog and resetLog', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('returns newest entries first', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(
      mod.LOG_FILE,
      JSON.stringify([
        { ts: now - 1000, sats: 10, command: 'first' },
        { ts: now, sats: 20, command: 'second' },
      ]),
    );
    const entries = mod.getLog(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].command, 'second');
    assert.equal(entries[1].command, 'first');
  });

  it('respects limit parameter', () => {
    const now = Date.now();
    const log = Array.from({ length: 50 }, (_, i) => ({
      ts: now - (50 - i) * 1000,
      sats: 1,
      command: `cmd-${i}`,
    }));
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify(log));
    const entries = mod.getLog(5);
    assert.equal(entries.length, 5);
  });

  it('resetLog clears finalized entries and returns counts', () => {
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(
      mod.LOG_FILE,
      JSON.stringify([
        { ts: Date.now(), sats: 1, command: 'test' },
        { ts: Date.now(), sats: 2, command: 'test' },
      ]),
    );
    const { removed, keptReserved } = mod.resetLog();
    assert.equal(removed, 2);
    assert.equal(keptReserved, 0);
    assert.equal(mod.readLog().length, 0);
  });
});

// ── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });
  afterEach(() => {
    delete process.env.BLINK_BUDGET_HOURLY_SATS;
    delete process.env.BLINK_BUDGET_DAILY_SATS;
    try {
      fs.unlinkSync(mod.LOG_FILE);
    } catch {
      /* ok */
    }
  });

  it('returns full status object', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '1000';
    process.env.BLINK_BUDGET_DAILY_SATS = '5000';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([{ ts: now - 10 * 60 * 1000, sats: 200, command: 'test' }]));
    const status = mod.getStatus({ nowMs: now });
    assert.equal(status.enabled, true);
    assert.equal(status.hourlyLimit, 1000);
    assert.equal(status.dailyLimit, 5000);
    assert.equal(status.hourlySpent, 200);
    assert.equal(status.dailySpent, 200);
    assert.equal(status.hourlyRemaining, 800);
    assert.equal(status.dailyRemaining, 4800);
    assert.equal(status.effectiveRemaining, 800);
    assert.equal(status.logEntries, 1);
  });

  it('returns disabled when no limits', () => {
    const status = mod.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.hourlyLimit, null);
    assert.equal(status.dailyLimit, null);
  });
});

// ── writeConfig / config file ────────────────────────────────────────────────

describe('writeConfig', () => {
  let mod;
  before(() => {
    setupTempDir();
    saveEnv();
    patchHomedir();
    delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
    mod = require(path.join(scriptsDir, '_budget.js'));
  });
  after(() => {
    restoreHomedir();
    restoreEnv();
    cleanupTempDir();
  });

  it('writes config to CONFIG_FILE and reads it back', () => {
    mod.writeConfig({ hourlyLimitSats: 777, dailyLimitSats: 3333, allowlist: ['test.com'] });
    const raw = JSON.parse(fs.readFileSync(mod.CONFIG_FILE, 'utf8'));
    assert.equal(raw.hourlyLimitSats, 777);
    assert.equal(raw.dailyLimitSats, 3333);
    assert.deepEqual(raw.allowlist, ['test.com']);
  });
});

// ── CLI test helper: redirect budget files to temp dir ───────────────────────

function setupCliTest() {
  setupTempDir();
  saveEnv();
  patchHomedir();
}

function cleanupCliTest(origArgv) {
  restoreHomedir();
  restoreEnv();
  process.argv = origArgv;
  cleanupTempDir();
}

function freshCliRequire() {
  delete require.cache[require.resolve(path.join(scriptsDir, 'budget.js'))];
  delete require.cache[require.resolve(path.join(scriptsDir, '_budget.js'))];
  return require(path.join(scriptsDir, 'budget.js'));
}

function captureLog(fn) {
  const logs = [];
  const origLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return logs;
}

// ── budget.js CLI — status subcommand ────────────────────────────────────────

describe('budget.js CLI — status', () => {
  let origArgv;
  before(() => {
    origArgv = process.argv;
    setupCliTest();
  });
  after(() => {
    cleanupCliTest(origArgv);
  });
  afterEach(() => {
    delete process.env.BLINK_BUDGET_HOURLY_SATS;
    delete process.env.BLINK_BUDGET_DAILY_SATS;
  });

  it('outputs status JSON', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '1000';
    process.argv = ['node', 'blink', 'status'];
    const logs = captureLog(() => freshCliRequire().main());
    assert.equal(logs.length, 1);
    const output = JSON.parse(logs[0]);
    assert.equal(output.enabled, true);
    assert.equal(output.hourlyLimit, 1000);
  });
});

// ── budget.js CLI — set subcommand ───────────────────────────────────────────

describe('budget.js CLI — set', () => {
  let origArgv;
  before(() => {
    origArgv = process.argv;
    setupCliTest();
  });
  after(() => {
    cleanupCliTest(origArgv);
  });

  it('set --hourly and --daily writes config', () => {
    process.argv = ['node', 'blink', 'set', '--hourly', '500', '--daily', '2000'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.hourlyLimitSats, 500);
    assert.equal(output.dailyLimitSats, 2000);
  });
});

// ── budget.js CLI — allowlist subcommand ─────────────────────────────────────

describe('budget.js CLI — allowlist', () => {
  let origArgv;
  before(() => {
    origArgv = process.argv;
    setupCliTest();
  });
  after(() => {
    cleanupCliTest(origArgv);
  });

  it('allowlist list with no domains states that auto-pay is BLOCKED (not the opposite)', () => {
    process.argv = ['node', 'blink', 'allowlist', 'list'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.count, 0);
    assert.deepEqual(output.allowlist, []);
    assert.match(output.message, /auto-pay is BLOCKED/);
  });

  it('allowlist add then list shows domain', () => {
    process.argv = ['node', 'blink', 'allowlist', 'add', 'satring.com'];
    captureLog(() => freshCliRequire().main());

    process.argv = ['node', 'blink', 'allowlist', 'list'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.count, 1);
    assert.deepEqual(output.allowlist, ['satring.com']);
  });

  it('allowlist remove then list shows empty', () => {
    process.argv = ['node', 'blink', 'allowlist', 'remove', 'satring.com'];
    captureLog(() => freshCliRequire().main());

    process.argv = ['node', 'blink', 'allowlist', 'list'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.count, 0);
  });
});

// ── budget.js CLI — per-subcommand option validation ─────────────────────────

describe('budget.js CLI — option validation', () => {
  let origArgv;
  before(() => {
    origArgv = process.argv;
    setupCliTest();
  });
  after(() => {
    cleanupCliTest(origArgv);
  });

  function runMainTrappingExit() {
    const origExit = process.exit;
    const exits = [];
    const errs = [];
    const origErr = console.error;
    process.exit = (code) => {
      exits.push(code);
      throw new Error('__exit__');
    };
    console.error = (s) => errs.push(String(s));
    try {
      freshCliRequire().main();
    } catch (e) {
      if (e.message !== '__exit__') throw e;
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    return { exitCode: exits[0] ?? 0, stderr: errs.join('\n') };
  }

  it('rejects flags meant for a different subcommand instead of ignoring them', () => {
    process.argv = ['node', 'blink', 'status', '--force'];
    const { exitCode, stderr } = runMainTrappingExit();
    assert.equal(exitCode, 1);
    assert.match(stderr, /not valid for 'budget status'/);
  });

  it('rejects --last on reset', () => {
    process.argv = ['node', 'blink', 'reset', '--last', '5'];
    const { exitCode } = runMainTrappingExit();
    assert.equal(exitCode, 1);
  });

  it('a prototype-named subcommand reports unknown-subcommand instead of crashing', () => {
    // "constructor" is an inherited Object.prototype property — an `in` check
    // would treat it as known and call .includes on a function (TypeError).
    process.argv = ['node', 'blink', 'constructor', '--force'];
    const { exitCode, stderr } = runMainTrappingExit();
    assert.equal(exitCode, 1);
    assert.match(stderr, /Unknown subcommand/);
    assert.equal(stderr.includes('TypeError'), false, 'must not crash on the prototype key');
  });

  it('set rejects unsafe, fractional, exponential, suffixed, and missing limit values', () => {
    for (const argv of [
      ['set', '--daily', '9007199254740993'], // rounds to an unsafe integer
      ['set', '--daily', '1.5'], // fractional
      ['set', '--daily', '1e5'], // exponential notation
      ['set', '--hourly', '1000oops'], // suffixed
      ['set', '--daily'], // missing value
    ]) {
      process.argv = ['node', 'blink', ...argv];
      const { exitCode, stderr } = runMainTrappingExit();
      assert.equal(exitCode, 1, `must reject: ${argv.join(' ')}`);
      assert.match(stderr, /digits only|safe-integer/i, `clear flag-level error for: ${argv.join(' ')}`);
    }
  });

  it('reset --force is accepted and reports the branch', () => {
    process.argv = ['node', 'blink', 'reset', '--force'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.force, true);
    assert.equal(output.discardedCorrupt, false);
  });

  it('reset on a corrupt log fails closed; reset --force recovers and says so', () => {
    // Ordinary reset must not discard unknown in-flight state: it propagates
    // BUDGET_LOG_CORRUPT (and the error itself points at --force recovery).
    const mod = require(path.join(scriptsDir, '_budget.js'));
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, 'not json', 'utf8');
    process.argv = ['node', 'blink', 'reset'];
    let err = null;
    try {
      freshCliRequire().main();
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'reset must fail, not succeed, on a corrupt log');
    assert.equal(err.code, 'BUDGET_LOG_CORRUPT');
    assert.match(err.message, /reset --force/);
  });

  it('reset --force on a corrupt log recovers and reports discardedCorrupt', () => {
    const mod = require(path.join(scriptsDir, '_budget.js'));
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, 'not json', 'utf8');
    process.argv = ['node', 'blink', 'reset', '--force'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.discardedCorrupt, true);
    assert.match(output.message, /corrupt/);
  });
});
