/**
 * v3.0.5: ClawHub 3.0.4 ClawScan concern + FT10 follow-up.
 *
 * 1. The QR PNG was written to a PREDICTABLE shared path
 *    (`/tmp/blink_qr_${Date.now()}.png`) with a plain writeFileSync, which
 *    follows symlinks and is not exclusive: a symlink planted there by another
 *    local user redirected the write. It now goes into a private mkdtemp
 *    directory (0700) as a 0600 file created exclusively (`wx`).
 * 2. A repeated single-value option silently took the LAST value
 *    (`spark-lnaddress delete --network regtest --network mainnet` → mainnet).
 *    Conflicting repeats are now refused, at the CLI and in every script.
 *
 * Run: node --test test/v305.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const scriptsDir = path.resolve(__dirname, '..', 'blink', 'scripts');
const binPath = path.resolve(__dirname, '..', 'bin', 'blink.js');
const INVOICE = 'lnbc10u1p0testinvoice';

// ── 1. QR PNG temp file ──────────────────────────────────────────────────────

describe('QR PNG is written to a private, unpredictable path', () => {
  function withSandbox(fn) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-qr-test-'));
    const saved = { tmpdir: process.env.TMPDIR, now: Date.now, error: console.error };
    process.env.TMPDIR = sandbox; // os.tmpdir() honors TMPDIR at call time
    console.error = () => {};
    const qrPath = require.resolve(path.join(scriptsDir, 'qr_invoice.js'));
    delete require.cache[qrPath];
    try {
      return fn({ sandbox, qr: require(qrPath) });
    } finally {
      Date.now = saved.now;
      console.error = saved.error;
      if (saved.tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.tmpdir;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }

  it('a symlink planted at the old predictable /tmp name is never followed', () => {
    withSandbox(({ sandbox, qr }) => {
      const victim = path.join(sandbox, 'victim.txt');
      fs.writeFileSync(victim, 'untouched');
      const fixed = 1700000000000 + Math.floor(Math.random() * 1e9);
      Date.now = () => fixed;
      const planted = `/tmp/blink_qr_${fixed}.png`; // the pre-3.0.5 name
      fs.symlinkSync(victim, planted);
      try {
        const out = qr.renderInvoiceQr(INVOICE);
        assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched', 'the symlink target was not written');
        assert.notEqual(out.pngPath, planted);
      } finally {
        fs.rmSync(planted, { force: true });
      }
    });
  });

  it('the PNG lands in a 0700 blink-qr-* directory under os.tmpdir(), as a 0600 file', () => {
    withSandbox(({ sandbox, qr }) => {
      const out = qr.renderInvoiceQr(INVOICE);
      const dir = path.dirname(out.pngPath);
      assert.equal(path.dirname(dir), sandbox, 'under os.tmpdir() (TMPDIR honored)');
      assert.match(path.basename(dir), /^blink-qr-/);
      assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.lstatSync(out.pngPath).isSymbolicLink(), false);
      assert.equal(fs.statSync(out.pngPath).mode & 0o777, 0o600);
      const head = fs.readFileSync(out.pngPath).subarray(0, 8);
      assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG');
      assert.equal(out.pngBytes, fs.statSync(out.pngPath).size);
    });
  });

  it('two renders in the same millisecond get distinct paths', () => {
    withSandbox(({ qr }) => {
      Date.now = () => 1700000000000;
      const a = qr.renderInvoiceQr(INVOICE).pngPath;
      const b = qr.renderInvoiceQr(INVOICE).pngPath;
      assert.notEqual(a, b);
    });
  });
});

describe('tripwire: no script writes to a predictable shared temp path', () => {
  it('no `/tmp` path literal in code, and os.tmpdir() only with mkdtempSync', () => {
    const problems = [];
    for (const file of fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (/['"`]\/tmp\b/.test(code)) problems.push(`${file}: hard-coded /tmp path`);
      if (/os\.tmpdir\(\)/.test(code) && !/mkdtempSync\(/.test(code))
        problems.push(`${file}: os.tmpdir() without mkdtempSync`);
    }
    assert.deepEqual(problems, []);
  });
});

// ── 2. Conflicting repeated options ──────────────────────────────────────────

describe('strictArgv refuses conflicting repeats of a single-value option', () => {
  const { strictArgv } = require(path.join(scriptsDir, '_blink_client.js'));
  const OPTS = { network: { type: 'string' }, force: { type: 'boolean' }, header: { type: 'string', multiple: true } };

  it('different values → ARG_INVALID naming the option', () => {
    assert.throws(
      () => strictArgv(['--network', 'regtest', '--network', 'mainnet'], OPTS),
      (e) => e.code === 'ARG_INVALID' && /--network/.test(e.message) && /conflict/i.test(e.message),
    );
    assert.throws(
      () => strictArgv(['--network=regtest', '--network', 'mainnet'], OPTS),
      (e) => e.code === 'ARG_INVALID',
    );
  });

  it('controls: an identical repeat, a repeated boolean, and a multiple option are fine', () => {
    assert.deepEqual(strictArgv(['--network', 'regtest', '--network=regtest'], OPTS), [
      '--network',
      'regtest',
      '--network',
      'regtest',
    ]);
    assert.deepEqual(strictArgv(['--force', '--force'], OPTS), ['--force', '--force']);
    assert.deepEqual(strictArgv(['--header', 'A:1', '--header', 'B:2'], OPTS), ['--header', 'A:1', '--header', 'B:2']);
  });

  it('spark_lnaddress: `delete --network regtest --network mainnet` is refused', () => {
    const { parseArgs } = require(path.join(scriptsDir, 'spark_lnaddress.js'));
    assert.throws(
      () => parseArgs(['delete', '--network', 'regtest', '--network', 'mainnet']),
      (e) => e.code === 'ARG_INVALID',
    );
  });
});

describe('the blink CLI refuses conflicting repeats too', () => {
  function cli(args) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blink-dup-cli-'));
    return new Promise((resolve) =>
      execFile(
        process.execPath,
        [binPath, ...args],
        {
          env: { ...process.env, HOME: home, SPARK_MNEMONIC: '', BREEZ_API_KEY: '', BLINK_API_KEY: '' },
          timeout: 15000,
        },
        (err, stdout, stderr) => {
          fs.rmSync(home, { recursive: true, force: true });
          resolve({ code: err ? err.code : 0, stdout, stderr });
        },
      ),
    );
  }

  it('`blink spark-lnaddress delete --network regtest --network mainnet` exits 1 before anything runs', async () => {
    const r = await cli(['spark-lnaddress', 'delete', '--network', 'regtest', '--network', 'mainnet']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /conflict/i);
    assert.doesNotMatch(r.stderr, /SPARK_MNEMONIC|BREEZ_API_KEY/);
  });

  it('`--store --no-store` is a conflict (allowNegative)', async () => {
    const r = await cli(['l402-pay', 'https://x.example/', '--store', '--no-store']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /conflict/i);
  });

  it('control: an identical repeat still works (`budget log --last 3 --last 3`)', async () => {
    const r = await cli(['budget', 'log', '--last', '3', '--last', '3']);
    assert.equal(r.code, 0, r.stderr);
  });
});
