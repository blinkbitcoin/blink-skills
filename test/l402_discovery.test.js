/**
 * Unit tests for Phase 2c — L402 Service Discovery.
 *
 * Covers:
 *   - l402_search.js: arg parsing, directory search, 402index search
 *   - l402_info.js: arg parsing, detail fetch
 *
 * Run: node --test test/l402_discovery.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');

// ── l402_search: parseCliArgs ────────────────────────────────────────────────

describe('l402_search — parseCliArgs', () => {
  let mod;
  before(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_search.js'))];
    mod = require(path.join(scriptsDir, 'l402_search.js'));
  });

  it('parses no args (defaults)', () => {
    const args = mod.parseCliArgs([]);
    assert.equal(args.query, null);
    assert.equal(args.source, 'directory');
    assert.equal(args.category, null);
    assert.equal(args.status, 'live');
    assert.equal(args.format, 'full');
  });

  it('parses a positional query', () => {
    const args = mod.parseCliArgs(['video']);
    assert.equal(args.query, 'video');
  });

  it('parses --source 402index', () => {
    const args = mod.parseCliArgs(['--source', '402index']);
    assert.equal(args.source, '402index');
  });

  it('parses --category and --status all', () => {
    const args = mod.parseCliArgs(['--category', 'ai', '--status', 'all']);
    assert.equal(args.category, 'ai');
    assert.equal(args.status, 'all');
  });

  it('parses --format minimal', () => {
    const args = mod.parseCliArgs(['--format', 'minimal']);
    assert.equal(args.format, 'minimal');
  });

  it('throws for invalid --source', () => {
    assert.throws(() => mod.parseCliArgs(['--source', 'invalid']), /must be/);
  });
});

// ── l402_search: searchDirectory with mocked fetch ───────────────────────────

describe('l402_search — searchDirectory (mocked)', () => {
  let mod;
  let origFetch;

  before(() => {
    origFetch = global.fetch;
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_search.js'))];
    mod = require(path.join(scriptsDir, 'l402_search.js'));
  });
  after(() => {
    global.fetch = origFetch;
  });

  it('returns services from l402.directory', async () => {
    global.fetch = async (url) => {
      assert.ok(url.startsWith(mod.DIRECTORY_URL));
      return {
        ok: true,
        json: async () => ({
          services: [
            { service_id: 'abc123', name: 'Test Service', status: 'live' },
          ],
        }),
      };
    };

    const result = await mod.searchDirectory({ query: null, category: null, status: 'live', format: 'full' });
    assert.equal(result.source, 'l402.directory');
    assert.equal(result.count, 1);
    assert.equal(result.services[0].name, 'Test Service');
  });

  it('passes query params correctly', async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ services: [] }) };
    };

    await mod.searchDirectory({ query: 'video', category: 'streaming', status: 'all', format: 'minimal' });
    assert.ok(capturedUrl.includes('q=video'));
    assert.ok(capturedUrl.includes('category=streaming'));
    assert.ok(capturedUrl.includes('status=all'));
    assert.ok(capturedUrl.includes('format=minimal'));
  });
});

// ── l402_search: searchIndex with mocked fetch ───────────────────────────────

describe('l402_search — searchIndex (mocked)', () => {
  let mod;
  let origFetch;

  before(() => {
    origFetch = global.fetch;
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_search.js'))];
    mod = require(path.join(scriptsDir, 'l402_search.js'));
  });
  after(() => {
    global.fetch = origFetch;
  });

  it('returns normalized services from 402index.io', async () => {
    global.fetch = async (url) => {
      assert.ok(url.startsWith(mod.INDEX_URL));
      return {
        ok: true,
        json: async () => ({
          services: [
            {
              id: 'uuid-1',
              name: 'AI Service',
              description: 'LLM inference',
              url: 'https://example.com/api',
              price_sats: 50,
              category: 'ai/llm',
              provider: 'Test',
              health_status: 'healthy',
              uptime_30d: 0.99,
              latency_p50_ms: 200,
              reliability_score: 95,
            },
          ],
        }),
      };
    };

    const result = await mod.searchIndex({ query: null, category: null, status: 'live' });
    assert.equal(result.source, '402index.io');
    assert.equal(result.count, 1);
    assert.equal(result.services[0].name, 'AI Service');
    assert.equal(result.services[0].priceSats, 50);
    assert.equal(result.services[0].reliabilityScore, 95);
  });

  it('filters by keyword client-side', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        services: [
          { id: '1', name: 'Video Streaming', description: 'Watch videos', category: 'video' },
          { id: '2', name: 'Data API', description: 'Get data', category: 'data' },
        ],
      }),
    });

    const result = await mod.searchIndex({ query: 'video', category: null, status: 'live' });
    assert.equal(result.count, 1);
    assert.equal(result.services[0].name, 'Video Streaming');
  });
});

// ── l402_info: parseCliArgs ──────────────────────────────────────────────────

describe('l402_info — parseCliArgs', () => {
  let mod;
  before(() => {
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_info.js'))];
    mod = require(path.join(scriptsDir, 'l402_info.js'));
  });

  it('parses service_id positional', () => {
    const args = mod.parseCliArgs(['abc123']);
    assert.equal(args.serviceId, 'abc123');
    assert.equal(args.report, false);
    assert.equal(args.force, false);
  });

  it('parses --report flag', () => {
    const args = mod.parseCliArgs(['abc123', '--report']);
    assert.equal(args.report, true);
  });

  it('parses --force flag', () => {
    const args = mod.parseCliArgs(['abc123', '--report', '--force']);
    assert.equal(args.force, true);
  });

  it('throws when service_id is missing', () => {
    assert.throws(() => mod.parseCliArgs([]), /service_id/);
  });
});

// ── l402_info: fetchServiceDetail with mocked fetch ──────────────────────────

describe('l402_info — fetchServiceDetail (mocked)', () => {
  let mod;
  let origFetch;

  before(() => {
    origFetch = global.fetch;
    delete require.cache[require.resolve(path.join(scriptsDir, 'l402_info.js'))];
    mod = require(path.join(scriptsDir, 'l402_info.js'));
  });
  after(() => {
    global.fetch = origFetch;
  });

  it('fetches service detail from l402.directory', async () => {
    global.fetch = async (url) => {
      assert.ok(url.includes('/api/services/abc123'));
      return {
        ok: true,
        json: async () => ({
          service_id: 'abc123',
          name: 'Test Service',
          status: 'live',
          endpoints: [],
        }),
      };
    };

    const detail = await mod.fetchServiceDetail('abc123');
    assert.equal(detail.service_id, 'abc123');
    assert.equal(detail.name, 'Test Service');
  });

  it('throws on 404', async () => {
    global.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
    await assert.rejects(() => mod.fetchServiceDetail('nonexistent'), /not found/i);
  });
});

// ── l402_info --report delegates enforcement to l402_pay ─────────────────────

/**
 * l402_info used to run its own budget and domain pre-checks before delegating
 * to l402_pay. Those duplicated the real enforcement and had drifted out of
 * sync with it, so they were removed. This pins the property that matters:
 * --report still cannot spend when the controls are unconfigured, because
 * l402_pay enforces at the point of payment.
 */
describe('l402_info --report enforcement delegation', () => {
  const infoPath = path.join(scriptsDir, 'l402_info.js');
  const payPath = path.join(scriptsDir, 'l402_pay.js');
  const discoverPath = path.join(scriptsDir, 'l402_discover.js');
  const storePath = path.join(scriptsDir, 'l402_store.js');
  const budgetPath = path.join(scriptsDir, '_budget.js');

  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  const originalFetch = global.fetch;
  const originalStdout = console.log;
  const originalStderr = console.error;
  const originalHomedir = os.homedir;

  let stdoutLines = [];
  let tmpDir;

  before(() => {
    process.env.BLINK_API_KEY = 'blink_test_key';
    process.env.BLINK_API_URL = 'https://api.test.blink.sv/graphql';
    console.log = (...args) => stdoutLines.push(args.join(' '));
    console.error = () => {};
  });

  after(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    global.fetch = originalFetch;
    console.log = originalStdout;
    console.error = originalStderr;
    os.homedir = originalHomedir;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-l402-info-'));
    os.homedir = () => tmpDir;
    delete process.env.BLINK_BUDGET_HOURLY_SATS;
    delete process.env.BLINK_BUDGET_DAILY_SATS;
    delete process.env.BLINK_L402_ALLOWED_DOMAINS;
    stdoutLines = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    os.homedir = originalHomedir;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    for (const p of [infoPath, payPath, discoverPath, storePath, budgetPath]) {
      delete require.cache[require.resolve(p)];
    }
  });

  async function runInfoReport(extraArgs = []) {
    const blinkCalls = [];
    global.fetch = async (url, _opts) => {
      blinkCalls.push(String(url));
      return {
        status: 402,
        url: String(url),
        headers: {
          get: (name) =>
            name.toLowerCase() === 'www-authenticate'
              ? 'L402 macaroon="TESTMAC==", invoice="lnbc1000u1p0report"'
              : null,
        },
        text: async () => '',
      };
    };

    process.argv = ['node', 'l402_info.js', 'deadbeef', '--report', ...extraArgs];
    const { main } = require(infoPath);
    let exitCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };
    try {
      await main();
    } catch {
      /* swallow the trapped exit */
    } finally {
      process.exit = originalExit;
    }
    return { exitCode, blinkCalls };
  }

  it('is denied by the allowlist when nothing is configured', async () => {
    const { exitCode, blinkCalls } = await runInfoReport();

    assert.equal(exitCode, 1);
    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_domain_blocked');
    assert.equal(out.domain, 'l402.directory');
    assert.equal(
      blinkCalls.some((u) => u.includes('api.test.blink.sv')),
      false,
      'must not reach the Blink payment mutation',
    );
  });

  it('is denied by the budget when only the domain is allowlisted', async () => {
    process.env.BLINK_L402_ALLOWED_DOMAINS = 'l402.directory';
    const { exitCode, blinkCalls } = await runInfoReport();

    assert.equal(exitCode, 1);
    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_budget_exceeded');
    assert.match(out.message, /NO_BUDGET_CONFIGURED/);
    assert.equal(
      blinkCalls.some((u) => u.includes('api.test.blink.sv')),
      false,
      'must not reach the Blink payment mutation',
    );
  });

  it('--force still does not bypass either control', async () => {
    const { exitCode, blinkCalls } = await runInfoReport(['--force']);

    assert.equal(exitCode, 1);
    const out = JSON.parse(stdoutLines.join('\n'));
    assert.equal(out.event, 'l402_domain_blocked');
    assert.equal(
      blinkCalls.some((u) => u.includes('api.test.blink.sv')),
      false,
      'must not reach the Blink payment mutation',
    );
  });
});
