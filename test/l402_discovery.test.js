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

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
