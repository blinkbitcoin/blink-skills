/**
 * Unit tests for _blink_client.js pure functions.
 *
 * Run: node --test test/client.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInvoice,
  warnIfNotBolt11,
  formatBalance,
  formatUsdCents,
  parseWalletArg,
  decimalFromBaseOffset,
} = require('../blink/scripts/_blink_client');

// ── normalizeInvoice ─────────────────────────────────────────────────────────

describe('normalizeInvoice', () => {
  it('trims whitespace', () => {
    assert.equal(normalizeInvoice('  lnbc100n1p0... '), 'lnbc100n1p0...');
  });

  it('strips lightning: URI prefix (lowercase)', () => {
    assert.equal(normalizeInvoice('lightning:lnbc100n1p0...'), 'lnbc100n1p0...');
  });

  it('strips lightning: URI prefix (mixed case)', () => {
    assert.equal(normalizeInvoice('Lightning:lnbc100n1p0...'), 'lnbc100n1p0...');
  });

  it('strips lightning: URI prefix (uppercase)', () => {
    assert.equal(normalizeInvoice('LIGHTNING:LNBC100n1p0...'), 'LNBC100n1p0...');
  });

  it('returns plain invoice unchanged', () => {
    assert.equal(normalizeInvoice('lnbc100n1p0...'), 'lnbc100n1p0...');
  });

  it('handles lightning: with whitespace', () => {
    assert.equal(normalizeInvoice('  lightning:lnbc100n1p0...  '), 'lnbc100n1p0...');
  });
});

// ── warnIfNotBolt11 ──────────────────────────────────────────────────────────

describe('warnIfNotBolt11', () => {
  it('does not warn for lnbc prefix', () => {
    // Capture stderr to verify no warning
    const original = console.error;
    let warned = false;
    console.error = () => {
      warned = true;
    };
    try {
      warnIfNotBolt11('lnbc100n1p0...');
      assert.equal(warned, false);
    } finally {
      console.error = original;
    }
  });

  it('does not warn for lntbs prefix (testnet)', () => {
    const original = console.error;
    let warned = false;
    console.error = () => {
      warned = true;
    };
    try {
      warnIfNotBolt11('lntbs100n1p0...');
      assert.equal(warned, false);
    } finally {
      console.error = original;
    }
  });

  it('does not warn for lntb prefix (testnet)', () => {
    const original = console.error;
    let warned = false;
    console.error = () => {
      warned = true;
    };
    try {
      warnIfNotBolt11('lntb100n1p0...');
      assert.equal(warned, false);
    } finally {
      console.error = original;
    }
  });

  it('warns for unrecognised prefix', () => {
    const original = console.error;
    let warned = false;
    console.error = () => {
      warned = true;
    };
    try {
      warnIfNotBolt11('xyz123...');
      assert.equal(warned, true);
    } finally {
      console.error = original;
    }
  });

  it('is case-insensitive', () => {
    const original = console.error;
    let warned = false;
    console.error = () => {
      warned = true;
    };
    try {
      warnIfNotBolt11('LNBC100n1p0...');
      assert.equal(warned, false);
    } finally {
      console.error = original;
    }
  });
});

// ── formatBalance ────────────────────────────────────────────────────────────

describe('formatBalance', () => {
  it('formats BTC wallet in sats', () => {
    assert.equal(formatBalance({ walletCurrency: 'BTC', balance: 1760 }), '1760 sats');
  });

  it('formats BTC wallet with zero balance', () => {
    assert.equal(formatBalance({ walletCurrency: 'BTC', balance: 0 }), '0 sats');
  });

  it('formats USD wallet in dollars and cents', () => {
    assert.equal(formatBalance({ walletCurrency: 'USD', balance: 1500 }), '$15.00 (1500 cents)');
  });

  it('formats USD wallet with small balance', () => {
    assert.equal(formatBalance({ walletCurrency: 'USD', balance: 5 }), '$0.05 (5 cents)');
  });

  it('formats USD wallet with zero balance', () => {
    assert.equal(formatBalance({ walletCurrency: 'USD', balance: 0 }), '$0.00 (0 cents)');
  });
});

// ── formatUsdCents ───────────────────────────────────────────────────────────

describe('formatUsdCents', () => {
  it('formats cents as dollars', () => {
    assert.equal(formatUsdCents(1500), '$15.00');
  });

  it('formats single-digit cents', () => {
    assert.equal(formatUsdCents(5), '$0.05');
  });

  it('formats zero', () => {
    assert.equal(formatUsdCents(0), '$0.00');
  });

  it('formats large amounts', () => {
    assert.equal(formatUsdCents(100000), '$1000.00');
  });
});

// ── parseWalletArg ───────────────────────────────────────────────────────────

describe('parseWalletArg', () => {
  it('defaults to BTC with no flags', () => {
    const result = parseWalletArg(['lnbc...']);
    assert.equal(result.walletCurrency, 'BTC');
    assert.deepEqual(result.remaining, ['lnbc...']);
    assert.equal(result.dryRun, false);
    assert.equal(result.force, false);
    assert.equal(result.maxAmount, null);
  });

  it('parses --wallet BTC', () => {
    const result = parseWalletArg(['lnbc...', '--wallet', 'BTC']);
    assert.equal(result.walletCurrency, 'BTC');
    assert.deepEqual(result.remaining, ['lnbc...']);
  });

  it('parses --wallet USD', () => {
    const result = parseWalletArg(['lnbc...', '--wallet', 'USD']);
    assert.equal(result.walletCurrency, 'USD');
    assert.deepEqual(result.remaining, ['lnbc...']);
  });

  it('is case-insensitive for wallet currency', () => {
    const result = parseWalletArg(['lnbc...', '--wallet', 'usd']);
    assert.equal(result.walletCurrency, 'USD');
  });

  it('parses --dry-run flag', () => {
    const result = parseWalletArg(['lnbc...', '--dry-run']);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.remaining, ['lnbc...']);
  });

  it('parses --force flag', () => {
    const result = parseWalletArg(['lnbc...', '--force']);
    assert.equal(result.force, true);
    assert.deepEqual(result.remaining, ['lnbc...']);
  });

  it('parses --max-amount flag', () => {
    const result = parseWalletArg(['addr@blink.sv', '5000', '--max-amount', '10000']);
    assert.equal(result.maxAmount, 10000);
    assert.deepEqual(result.remaining, ['addr@blink.sv', '5000']);
  });

  it('strips all payment flags from remaining', () => {
    const result = parseWalletArg([
      'addr@blink.sv',
      '5000',
      '--wallet',
      'USD',
      '--dry-run',
      '--force',
      '--max-amount',
      '10000',
    ]);
    assert.equal(result.walletCurrency, 'USD');
    assert.equal(result.dryRun, true);
    assert.equal(result.force, true);
    assert.equal(result.maxAmount, 10000);
    assert.deepEqual(result.remaining, ['addr@blink.sv', '5000']);
  });

  it('handles empty argv', () => {
    const result = parseWalletArg([]);
    assert.equal(result.walletCurrency, 'BTC');
    assert.deepEqual(result.remaining, []);
    assert.equal(result.dryRun, false);
    assert.equal(result.force, false);
    assert.equal(result.maxAmount, null);
  });
});

// ── decimalFromBaseOffset ────────────────────────────────────────────────────

describe('decimalFromBaseOffset', () => {
  it('converts positive offset', () => {
    // base=5, offset=2 → 5 * 100 = 500
    assert.equal(decimalFromBaseOffset(5, 2), 500);
  });

  it('converts negative offset', () => {
    // base=6456903063948, offset=-12 → ≈ 6.456903063948
    const result = decimalFromBaseOffset(6456903063948, -12);
    assert.ok(Math.abs(result - 6.456903063948) < 1e-10);
  });

  it('converts zero offset', () => {
    assert.equal(decimalFromBaseOffset(42, 0), 42);
  });

  it('handles zero base', () => {
    assert.equal(decimalFromBaseOffset(0, -5), 0);
  });
});
