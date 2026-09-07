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
      { ts: now - 2 * 60 * 60 * 1000, sats: 500, command: 'test' },  // 2h ago (daily only)
      { ts: now - 30 * 60 * 1000, sats: 100, command: 'test' },       // 30min ago (both)
    ];
    const { hourlySpent, dailySpent } = mod.sumSpending(log, now);
    assert.equal(hourlySpent, 100);
    assert.equal(dailySpent, 600);
  });

  it('excludes entries older than 24 hours', () => {
    const now = Date.now();
    const log = [
      { ts: now - 25 * 60 * 60 * 1000, sats: 9999, command: 'test' }, // 25h ago
      { ts: now - 100, sats: 50, command: 'test' },                     // just now
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
    try { fs.unlinkSync(mod.CONFIG_FILE); } catch { /* ok */ }
  });

  it('treats invalid env var as null', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = 'not_a_number';
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
    try { fs.unlinkSync(mod.LOG_FILE); } catch { /* ok */ }
  });

  it('allows any amount when no limits set', () => {
    const result = mod.checkBudget(999999);
    assert.equal(result.allowed, true);
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
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 10 * 60 * 1000, sats: 80, command: 'test' },
    ]));
    const result = mod.checkBudget(50, { nowMs: now });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Hourly budget exceeded/);
    assert.equal(result.hourlySpent, 80);
  });

  it('allows exactly at limit', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '100';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 5 * 60 * 1000, sats: 50, command: 'test' },
    ]));
    const result = mod.checkBudget(50, { nowMs: now });
    assert.equal(result.allowed, true);
  });

  it('denies when exceeding daily limit', () => {
    process.env.BLINK_BUDGET_DAILY_SATS = '500';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 3 * 60 * 60 * 1000, sats: 400, command: 'test' },
    ]));
    const result = mod.checkBudget(200, { nowMs: now });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Daily budget exceeded/);
  });

  it('returns effectiveRemaining as min of hourly and daily', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '100';
    process.env.BLINK_BUDGET_DAILY_SATS = '500';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 30 * 60 * 1000, sats: 70, command: 'test' },
    ]));
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
    try { fs.unlinkSync(mod.LOG_FILE); } catch { /* ok */ }
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
      { ts: now - 26 * 60 * 60 * 1000, sats: 999, command: 'old' },  // 26h ago — pruned
      { ts: now - 1 * 60 * 60 * 1000, sats: 100, command: 'recent' }, // 1h ago — kept
    ];
    mod.writeLog(entries);
    const log = mod.readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].command, 'recent');
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
    try { fs.unlinkSync(mod.LOG_FILE); } catch { /* ok */ }
  });

  it('returns newest entries first', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 1000, sats: 10, command: 'first' },
      { ts: now, sats: 20, command: 'second' },
    ]));
    const entries = mod.getLog(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].command, 'second');
    assert.equal(entries[1].command, 'first');
  });

  it('respects limit parameter', () => {
    const now = Date.now();
    const log = Array.from({ length: 50 }, (_, i) => ({
      ts: now - (50 - i) * 1000, sats: 1, command: `cmd-${i}`,
    }));
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify(log));
    const entries = mod.getLog(5);
    assert.equal(entries.length, 5);
  });

  it('resetLog clears all entries and returns count', () => {
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: Date.now(), sats: 1, command: 'test' },
      { ts: Date.now(), sats: 2, command: 'test' },
    ]));
    const removed = mod.resetLog();
    assert.equal(removed, 2);
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
    try { fs.unlinkSync(mod.LOG_FILE); } catch { /* ok */ }
  });

  it('returns full status object', () => {
    process.env.BLINK_BUDGET_HOURLY_SATS = '1000';
    process.env.BLINK_BUDGET_DAILY_SATS = '5000';
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.LOG_FILE), { recursive: true });
    fs.writeFileSync(mod.LOG_FILE, JSON.stringify([
      { ts: now - 10 * 60 * 1000, sats: 200, command: 'test' },
    ]));
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

  it('allowlist list shows empty list', () => {
    process.argv = ['node', 'blink', 'allowlist', 'list'];
    const logs = captureLog(() => freshCliRequire().main());
    const output = JSON.parse(logs[0]);
    assert.equal(output.count, 0);
    assert.deepEqual(output.allowlist, []);
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
