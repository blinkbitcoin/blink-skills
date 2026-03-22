#!/usr/bin/env node
/**
 * Blink Lightning Wallet CLI
 *
 * Unified entry point for all Blink wallet operations.
 * Zero npm dependencies — uses Node's built-in util.parseArgs.
 * Run `blink --help` for usage or `blink <command> --help` for command-specific help.
 */

const { parseArgs } = require('node:util');
const path = require('node:path');

const scriptsDir = path.join(__dirname, '..', 'blink', 'scripts');
const VERSION = require('../package.json').version;

// ── Coercion helpers ─────────────────────────────────────────────────────────

function parseSats(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) {
    console.error(`Error: '${name}' must be a positive integer (sats), got '${value}'.`);
    process.exit(1);
  }
  return n;
}

function parseCents(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) {
    console.error(`Error: '${name}' must be a positive integer (cents), got '${value}'.`);
    process.exit(1);
  }
  return n;
}

function parseNonNegativeInt(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) {
    console.error(`Error: '${name}' must be a non-negative integer, got '${value}'.`);
    process.exit(1);
  }
  return n;
}

function parsePositiveInt(value, name) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) {
    console.error(`Error: '${name}' must be a positive integer, got '${value}'.`);
    process.exit(1);
  }
  return n;
}

// ── Argv passthrough ─────────────────────────────────────────────────────────

function setProcessArgv(argv) {
  process.argv = [process.argv[0], 'blink', ...argv];
}

function handleError(e) {
  console.error('Error:', e.message);
  process.exit(1);
}

// ── Command registry ─────────────────────────────────────────────────────────
//
// Each command declares:
//   args:     Array of { name, required, variadic, description, coerce? }
//   options:  parseArgs-compatible options config (type, short, default)
//   optMeta:  Display metadata for options { description, valueName? }
//   examples: Array of example strings
//   action:   async (positionals, values) => void

const commands = {};

commands.balance = {
  description: 'Show BTC and USD wallet balances with pre-computed USD estimates',
  args: [],
  options: {},
  optMeta: {},
  examples: ['blink balance'],
  action: async () => {
    setProcessArgv([]);
    const { main } = require(path.join(scriptsDir, 'balance.js'));
    await main();
  },
};

commands['pay-invoice'] = {
  description: 'Pay a BOLT-11 Lightning invoice',
  args: [{ name: 'bolt11', required: true, description: 'BOLT-11 payment request string (lnbc...)' }],
  options: {
    wallet: { type: 'string', short: 'w', default: 'BTC' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
  optMeta: {
    wallet: { description: 'Wallet to pay from', valueName: 'currency' },
    'dry-run': { description: 'Show what would be sent without executing the payment' },
    force: { description: 'Skip balance sufficiency check' },
  },
  examples: [
    'blink pay-invoice lnbc10u1p...',
    'blink pay-invoice lnbc10u1p... --wallet USD',
    'blink pay-invoice lnbc10u1p... --dry-run',
  ],
  action: async (pos, opts) => {
    const argv = [pos[0], '--wallet', opts.wallet];
    if (opts['dry-run']) argv.push('--dry-run');
    if (opts.force) argv.push('--force');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'pay_invoice.js'));
    await main();
  },
};

commands['pay-lnaddress'] = {
  description: 'Send sats to a Lightning Address (user@domain)',
  args: [
    { name: 'address', required: true, description: 'Lightning Address (e.g. user@blink.sv)' },
    { name: 'amount', required: true, description: 'Amount in satoshis', coerce: parseSats },
  ],
  options: {
    wallet: { type: 'string', short: 'w', default: 'BTC' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'max-amount': { type: 'string' },
  },
  optMeta: {
    wallet: { description: 'Wallet to pay from', valueName: 'currency' },
    'dry-run': { description: 'Show what would be sent without executing the payment' },
    force: { description: 'Skip balance sufficiency check' },
    'max-amount': { description: 'Reject if amount exceeds this threshold (sats)', valueName: 'sats' },
  },
  examples: [
    'blink pay-lnaddress user@blink.sv 1000',
    'blink pay-lnaddress user@blink.sv 1000 --wallet USD',
    'blink pay-lnaddress user@blink.sv 1000 --dry-run',
  ],
  action: async (pos, opts) => {
    const amount = pos[1];
    const maxAmount = opts['max-amount'] != null ? parseSats(opts['max-amount'], '--max-amount') : undefined;
    if (maxAmount && amount > maxAmount) {
      console.error(`Error: amount ${amount} sats exceeds --max-amount ${maxAmount} sats`);
      process.exit(1);
    }
    const argv = [pos[0], String(amount), '--wallet', opts.wallet];
    if (opts['dry-run']) argv.push('--dry-run');
    if (opts.force) argv.push('--force');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'pay_lnaddress.js'));
    await main();
  },
};

commands['pay-lnurl'] = {
  description: 'Send sats to a raw LNURL payRequest string',
  args: [
    { name: 'lnurl', required: true, description: 'LNURL string (lnurl1...)' },
    { name: 'amount', required: true, description: 'Amount in satoshis', coerce: parseSats },
  ],
  options: {
    wallet: { type: 'string', short: 'w', default: 'BTC' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'max-amount': { type: 'string' },
  },
  optMeta: {
    wallet: { description: 'Wallet to pay from', valueName: 'currency' },
    'dry-run': { description: 'Show what would be sent without executing the payment' },
    force: { description: 'Skip balance sufficiency check' },
    'max-amount': { description: 'Reject if amount exceeds this threshold (sats)', valueName: 'sats' },
  },
  examples: ['blink pay-lnurl lnurl1dp68... 5000', 'blink pay-lnurl lnurl1dp68... 5000 --wallet USD'],
  action: async (pos, opts) => {
    const amount = pos[1];
    const maxAmount = opts['max-amount'] != null ? parseSats(opts['max-amount'], '--max-amount') : undefined;
    if (maxAmount && amount > maxAmount) {
      console.error(`Error: amount ${amount} sats exceeds --max-amount ${maxAmount} sats`);
      process.exit(1);
    }
    const argv = [pos[0], String(amount), '--wallet', opts.wallet];
    if (opts['dry-run']) argv.push('--dry-run');
    if (opts.force) argv.push('--force');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'pay_lnurl.js'));
    await main();
  },
};

commands['create-invoice'] = {
  description: 'Create a BTC Lightning invoice (BOLT-11) with optional auto-subscribe',
  args: [
    { name: 'amount', required: true, description: 'Amount in satoshis', coerce: parseSats },
    { name: 'memo', required: false, variadic: true, description: 'Optional memo text' },
  ],
  options: {
    timeout: { type: 'string', default: '300' },
    subscribe: { type: 'boolean', default: true },
  },
  optMeta: {
    timeout: { description: 'Subscription timeout in seconds (0 = no timeout)', valueName: 'seconds' },
    subscribe: { description: 'Auto-subscribe for payment status (use --no-subscribe to skip)' },
  },
  examples: [
    'blink create-invoice 1000',
    'blink create-invoice 5000 "Coffee payment"',
    'blink create-invoice 1000 --no-subscribe',
    'blink create-invoice 1000 --timeout 60',
  ],
  action: async (pos, opts) => {
    const timeout = parseNonNegativeInt(opts.timeout, '--timeout');
    const argv = [String(pos[0])];
    if (timeout !== undefined) argv.push('--timeout', String(timeout));
    if (opts.subscribe === false) argv.push('--no-subscribe');
    const memo = pos.slice(1);
    if (memo.length > 0) argv.push(...memo);
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'create_invoice.js'));
    await main();
  },
};

commands['create-invoice-usd'] = {
  description: 'Create a USD-denominated Lightning invoice (amount in cents, e.g. 100 = $1.00)',
  args: [
    { name: 'amount', required: true, description: 'Amount in USD cents (e.g. 100 = $1.00)', coerce: parseCents },
    { name: 'memo', required: false, variadic: true, description: 'Optional memo text' },
  ],
  options: {
    timeout: { type: 'string', default: '300' },
    subscribe: { type: 'boolean', default: true },
  },
  optMeta: {
    timeout: { description: 'Subscription timeout in seconds (0 = no timeout)', valueName: 'seconds' },
    subscribe: { description: 'Auto-subscribe for payment status (use --no-subscribe to skip)' },
  },
  examples: [
    'blink create-invoice-usd 100      # $1.00',
    'blink create-invoice-usd 500 "Tip"',
    'blink create-invoice-usd 100 --no-subscribe',
  ],
  action: async (pos, opts) => {
    const timeout = parseNonNegativeInt(opts.timeout, '--timeout');
    const argv = [String(pos[0])];
    if (timeout !== undefined) argv.push('--timeout', String(timeout));
    if (opts.subscribe === false) argv.push('--no-subscribe');
    const memo = pos.slice(1);
    if (memo.length > 0) argv.push(...memo);
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'create_invoice_usd.js'));
    await main();
  },
};

commands['check-invoice'] = {
  description: 'Check payment status of a Lightning invoice by payment hash',
  args: [
    { name: 'payment_hash', required: true, description: 'Payment hash (64-char hex string from create-invoice)' },
  ],
  options: {},
  optMeta: {},
  examples: ['blink check-invoice abc123def456...'],
  action: async (pos) => {
    setProcessArgv([pos[0]]);
    const { main } = require(path.join(scriptsDir, 'check_invoice.js'));
    await main();
  },
};

commands['fee-probe'] = {
  description: 'Estimate the fee for paying a Lightning invoice without sending',
  args: [{ name: 'bolt11', required: true, description: 'BOLT-11 payment request string (lnbc...)' }],
  options: {
    wallet: { type: 'string', short: 'w', default: 'BTC' },
  },
  optMeta: {
    wallet: { description: 'Wallet to probe from', valueName: 'currency' },
  },
  examples: ['blink fee-probe lnbc10u1p...', 'blink fee-probe lnbc10u1p... --wallet USD'],
  action: async (pos, opts) => {
    setProcessArgv([pos[0], '--wallet', opts.wallet]);
    const { main } = require(path.join(scriptsDir, 'fee_probe.js'));
    await main();
  },
};

commands.qr = {
  description: 'Generate a QR code for a Lightning invoice (terminal + PNG file)',
  args: [{ name: 'bolt11', required: true, description: 'BOLT-11 payment request string (lnbc...)' }],
  options: {},
  optMeta: {},
  examples: ['blink qr lnbc10u1p...'],
  action: (pos) => {
    setProcessArgv([pos[0]]);
    const { main } = require(path.join(scriptsDir, 'qr_invoice.js'));
    main();
  },
};

commands.transactions = {
  description: 'List recent wallet transactions with pagination',
  args: [],
  options: {
    first: { type: 'string', default: '20' },
    after: { type: 'string' },
    wallet: { type: 'string', short: 'w' },
  },
  optMeta: {
    first: { description: 'Number of transactions to return (1-100)', valueName: 'n' },
    after: { description: 'Pagination cursor from a previous response', valueName: 'cursor' },
    wallet: { description: 'Filter to BTC or USD wallet', valueName: 'currency' },
  },
  examples: [
    'blink transactions',
    'blink transactions --first 50',
    'blink transactions --wallet BTC',
    'blink transactions --after <endCursor>',
  ],
  action: async (_pos, opts) => {
    const first = parsePositiveInt(opts.first, '--first');
    const argv = [];
    if (first) argv.push('--first', String(first));
    if (opts.after) argv.push('--after', opts.after);
    if (opts.wallet) argv.push('--wallet', opts.wallet);
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'transactions.js'));
    await main();
  },
};

commands.price = {
  description: 'BTC/USD price, currency conversion, and price history (no API key required)',
  args: [{ name: 'amount_sats', required: false, description: 'Convert this many sats to USD' }],
  options: {
    usd: { type: 'string' },
    history: { type: 'string' },
    currencies: { type: 'boolean', default: false },
    raw: { type: 'boolean', default: false },
  },
  optMeta: {
    usd: { description: 'Convert USD amount to sats', valueName: 'amount' },
    history: {
      description: 'Show historical prices (ONE_DAY, ONE_WEEK, ONE_MONTH, ONE_YEAR, FIVE_YEARS)',
      valueName: 'range',
    },
    currencies: { description: 'List all supported display currencies' },
    raw: { description: 'Include raw realtimePrice data' },
  },
  examples: [
    'blink price                    # Current BTC/USD price',
    'blink price 50000              # Convert 50000 sats to USD',
    'blink price --usd 10.00        # Convert $10.00 to sats',
    'blink price --history ONE_WEEK # Weekly price history',
    'blink price --currencies       # List supported currencies',
  ],
  action: async (pos, opts) => {
    const argv = [];
    if (opts.raw) argv.push('--raw');
    if (opts.usd != null) {
      argv.push('--usd', opts.usd);
    } else if (opts.history) {
      argv.push('--history', opts.history);
    } else if (opts.currencies) {
      argv.push('--currencies');
    } else if (pos[0]) {
      argv.push(pos[0]);
    }
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'price.js'));
    await main();
  },
};

commands['account-info'] = {
  description: 'Show account level, spending limits, and wallet summary',
  args: [],
  options: {},
  optMeta: {},
  examples: ['blink account-info'],
  action: async () => {
    setProcessArgv([]);
    const { main } = require(path.join(scriptsDir, 'account_info.js'));
    await main();
  },
};

commands['subscribe-invoice'] = {
  description: 'Watch a Lightning invoice for payment via WebSocket (requires Node 22+ or --experimental-websocket)',
  args: [{ name: 'bolt11', required: true, description: 'BOLT-11 payment request string (lnbc...)' }],
  options: {
    timeout: { type: 'string', default: '300' },
  },
  optMeta: {
    timeout: { description: 'Timeout in seconds (0 = no timeout)', valueName: 'seconds' },
  },
  examples: ['blink subscribe-invoice lnbc10u1p...', 'blink subscribe-invoice lnbc10u1p... --timeout 60'],
  action: (pos, opts) => {
    const timeout = parseNonNegativeInt(opts.timeout, '--timeout');
    const argv = [pos[0]];
    if (timeout !== undefined) argv.push('--timeout', String(timeout));
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'subscribe_invoice.js'));
    main();
  },
};

commands['subscribe-updates'] = {
  description: 'Stream account activity updates via WebSocket (NDJSON output)',
  args: [],
  options: {
    timeout: { type: 'string', default: '0' },
    max: { type: 'string', default: '0' },
  },
  optMeta: {
    timeout: { description: 'Timeout in seconds (0 = no timeout)', valueName: 'seconds' },
    max: { description: 'Stop after this many events (0 = unlimited)', valueName: 'count' },
  },
  examples: ['blink subscribe-updates', 'blink subscribe-updates --timeout 60', 'blink subscribe-updates --max 5'],
  action: (pos, opts) => {
    const timeout = parseNonNegativeInt(opts.timeout, '--timeout');
    const max = parseNonNegativeInt(opts.max, '--max');
    const argv = [];
    if (timeout !== undefined) argv.push('--timeout', String(timeout));
    if (max !== undefined) argv.push('--max', String(max));
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'subscribe_updates.js'));
    main();
  },
};

commands['swap-quote'] = {
  description: 'Get a BTC <-> USD conversion quote (no funds moved)',
  args: [
    {
      name: 'direction',
      required: true,
      description: 'Swap direction: btc-to-usd or usd-to-btc (aliases: sell-btc, buy-usd, sell-usd, buy-btc)',
    },
    { name: 'amount', required: true, description: 'Amount to swap (positive integer)', coerce: parsePositiveInt },
  ],
  options: {
    unit: { type: 'string' },
    'ttl-seconds': { type: 'string', default: '60' },
    immediate: { type: 'boolean', default: false },
  },
  optMeta: {
    unit: { description: 'Amount unit: sats or cents (default depends on direction)', valueName: 'unit' },
    'ttl-seconds': { description: 'Quote TTL in seconds', valueName: 'seconds' },
    immediate: { description: 'Flag the quote for immediate execution' },
  },
  examples: [
    'blink swap-quote btc-to-usd 1000',
    'blink swap-quote usd-to-btc 500 --unit cents',
    'blink swap-quote btc-to-usd 1000 --immediate --ttl-seconds 45',
  ],
  action: async (pos, opts) => {
    const ttl = parsePositiveInt(opts['ttl-seconds'], '--ttl-seconds');
    const argv = [pos[0], String(pos[1])];
    if (opts.unit) argv.push('--unit', opts.unit);
    if (ttl !== undefined) argv.push('--ttl-seconds', String(ttl));
    if (opts.immediate) argv.push('--immediate');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'swap_quote.js'));
    await main();
  },
};

commands['swap-execute'] = {
  description: 'Execute a BTC <-> USD wallet conversion (CAUTION: moves real funds without --dry-run)',
  args: [
    {
      name: 'direction',
      required: true,
      description: 'Swap direction: btc-to-usd or usd-to-btc (aliases: sell-btc, buy-usd, sell-usd, buy-btc)',
    },
    { name: 'amount', required: true, description: 'Amount to swap (positive integer)', coerce: parsePositiveInt },
  ],
  options: {
    unit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    memo: { type: 'string' },
    'ttl-seconds': { type: 'string', default: '60' },
    immediate: { type: 'boolean', default: false },
  },
  optMeta: {
    unit: { description: 'Amount unit: sats or cents (default depends on direction)', valueName: 'unit' },
    'dry-run': { description: 'Show what would be swapped without executing' },
    memo: { description: 'Optional memo attached to the transaction', valueName: 'text' },
    'ttl-seconds': { description: 'Quote TTL in seconds', valueName: 'seconds' },
    immediate: { description: 'Flag the quote for immediate execution' },
  },
  examples: [
    'blink swap-execute btc-to-usd 2000',
    'blink swap-execute usd-to-btc 500 --unit cents',
    'blink swap-execute btc-to-usd 2000 --dry-run',
    'blink swap-execute btc-to-usd 2000 --memo "Monthly DCA"',
  ],
  action: async (pos, opts) => {
    const ttl = parsePositiveInt(opts['ttl-seconds'], '--ttl-seconds');
    const argv = [pos[0], String(pos[1])];
    if (opts.unit) argv.push('--unit', opts.unit);
    if (ttl !== undefined) argv.push('--ttl-seconds', String(ttl));
    if (opts.immediate) argv.push('--immediate');
    if (opts['dry-run']) argv.push('--dry-run');
    if (opts.memo) argv.push('--memo', opts.memo);
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'swap_execute.js'));
    await main();
  },
};

commands['l402-discover'] = {
  description: 'Probe a URL for L402 payment requirements (no payment made)',
  args: [{ name: 'url', required: true, description: 'URL to probe for L402 challenge' }],
  options: {
    method: { type: 'string', default: 'GET' },
    header: { type: 'string', multiple: true },
  },
  optMeta: {
    method: { description: 'HTTP method (GET or POST)', valueName: 'method' },
    header: { description: 'Extra request header in key:value format (repeatable)', valueName: 'key:value' },
  },
  examples: [
    'blink l402-discover https://api.example.com/resource',
    'blink l402-discover https://api.example.com/resource --method POST',
    'blink l402-discover https://api.example.com/resource --header "Accept:application/json"',
  ],
  action: async (pos, opts) => {
    const argv = [pos[0], '--method', opts.method];
    if (opts.header) {
      const headers = Array.isArray(opts.header) ? opts.header : [opts.header];
      for (const h of headers) argv.push('--header', h);
    }
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'l402_discover.js'));
    await main();
  },
};

commands['l402-pay'] = {
  description: 'Fetch an L402-gated resource, paying automatically via Blink if required',
  args: [{ name: 'url', required: true, description: 'URL to access' }],
  options: {
    wallet: { type: 'string', short: 'w', default: 'BTC' },
    'max-amount': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    method: { type: 'string', default: 'GET' },
    header: { type: 'string', multiple: true },
    body: { type: 'string' },
    'no-store': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    probe: { type: 'boolean', default: false },
  },
  optMeta: {
    wallet: { description: 'Wallet to pay from', valueName: 'currency' },
    'max-amount': { description: 'Refuse to pay more than N sats', valueName: 'sats' },
    'dry-run': { description: 'Discover price without paying (always bypasses cache)' },
    method: { description: 'HTTP method (default: GET)', valueName: 'method' },
    header: { description: 'Extra request header in key:value format (repeatable)', valueName: 'key:value' },
    body: { description: 'Request body for POST/PUT', valueName: 'string' },
    'no-store': { description: 'Disable token cache for this request' },
    force: { description: 'Pay fresh even if a valid cached token exists' },
    probe: { description: 'Run fee probe before paying; adds feeProbe field to output' },
  },
  examples: [
    'blink l402-pay https://api.example.com/resource --dry-run',
    'blink l402-pay https://api.example.com/resource --max-amount 500',
    'blink l402-pay https://api.example.com/resource --max-amount 500 --probe',
    'blink l402-pay https://api.example.com/resource --force',
  ],
  action: async (pos, opts) => {
    const argv = [pos[0], '--wallet', opts.wallet];
    if (opts['max-amount']) argv.push('--max-amount', opts['max-amount']);
    if (opts['dry-run']) argv.push('--dry-run');
    if (opts.method !== 'GET') argv.push('--method', opts.method);
    if (opts.header) {
      const headers = Array.isArray(opts.header) ? opts.header : [opts.header];
      for (const h of headers) argv.push('--header', h);
    }
    if (opts.body) argv.push('--body', opts.body);
    if (opts['no-store']) argv.push('--no-store');
    if (opts.force) argv.push('--force');
    if (opts.probe) argv.push('--probe');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'l402_pay.js'));
    await main();
  },
};

commands['l402-store'] = {
  description: 'Manage the L402 token cache (~/.blink/l402-tokens.json)',
  args: [
    { name: 'subcommand', required: true, description: 'list | get | clear' },
    { name: 'domain', required: false, description: 'Domain for get subcommand' },
  ],
  options: {
    expired: { type: 'boolean', default: false },
  },
  optMeta: {
    expired: { description: 'With clear: remove only expired tokens' },
  },
  examples: [
    'blink l402-store list',
    'blink l402-store get satring.com',
    'blink l402-store clear',
    'blink l402-store clear --expired',
  ],
  action: async (pos, opts) => {
    const argv = [pos[0]];
    if (pos[1]) argv.push(pos[1]);
    if (opts.expired) argv.push('--expired');
    setProcessArgv(argv);
    const { main } = require(path.join(scriptsDir, 'l402_store.js'));
    main();
  },
};

// ── Help formatting ──────────────────────────────────────────────────────────

function formatMainHelp() {
  const lines = [
    `blink v${VERSION} — Bitcoin Lightning wallet CLI`,
    '',
    'Usage: blink <command> [options]',
    '',
    'Commands:',
  ];

  const names = Object.keys(commands);
  const maxLen = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    lines.push(`  ${name.padEnd(maxLen + 2)}${commands[name].description}`);
  }

  lines.push('');
  lines.push('Options:');
  lines.push('  --help, -h     Show help');
  lines.push('  --version, -V  Show version number');
  lines.push('');
  lines.push('Run `blink <command> --help` for command-specific usage.');
  return lines.join('\n');
}

function formatCommandHelp(name, cmd) {
  const argStr = cmd.args
    .map((a) => {
      const tag = a.variadic ? `${a.name}...` : a.name;
      return a.required ? `<${tag}>` : `[${tag}]`;
    })
    .join(' ');

  const lines = [`Usage: blink ${name}${argStr ? ' ' + argStr : ''} [options]`, '', cmd.description];

  if (cmd.args.length > 0) {
    lines.push('');
    lines.push('Arguments:');
    const maxArgLen = Math.max(...cmd.args.map((a) => a.name.length));
    for (const a of cmd.args) {
      lines.push(`  ${a.name.padEnd(maxArgLen + 2)}${a.description}`);
    }
  }

  const optNames = Object.keys(cmd.optMeta);
  // Always include --help in per-command help
  if (optNames.length > 0 || true) {
    lines.push('');
    lines.push('Options:');
    const entries = [];
    for (const oName of optNames) {
      const conf = cmd.options[oName] || {};
      const meta = cmd.optMeta[oName];
      let flag = `--${oName}`;
      if (conf.short) flag = `-${conf.short}, ${flag}`;
      if (meta.valueName) flag += ` <${meta.valueName}>`;
      let desc = meta.description;
      if (conf.default !== undefined && conf.default !== false) desc += ` (default: ${conf.default})`;
      entries.push([flag, desc]);
    }
    entries.push(['--help, -h', 'Show this help message']);
    const maxFlagLen = Math.max(...entries.map(([f]) => f.length));
    for (const [flag, desc] of entries) {
      lines.push(`  ${flag.padEnd(maxFlagLen + 2)}${desc}`);
    }
  }

  if (cmd.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of cmd.examples) {
      lines.push(`  ${ex}`);
    }
  }

  return lines.join('\n');
}

// ── Main dispatch ────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);

  // Global flags: --help / -h / --version / -V with no command
  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    console.log(formatMainHelp());
    return;
  }
  if (rawArgs[0] === '--version' || rawArgs[0] === '-V') {
    console.log(VERSION);
    return;
  }

  const cmdName = rawArgs[0];
  const cmd = commands[cmdName];

  if (!cmd) {
    console.error(`Error: unknown command '${cmdName}'.`);
    console.error('(run with --help for usage)');
    process.exit(1);
  }

  const cmdArgs = rawArgs.slice(1);

  // Per-command --help / -h
  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    console.log(formatCommandHelp(cmdName, cmd));
    return;
  }

  // Build parseArgs config — include --help so strict mode doesn't reject it
  const parseConfig = {
    args: cmdArgs,
    options: { ...cmd.options, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  };

  let parsed;
  try {
    parsed = parseArgs(parseConfig);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('(run with --help for usage)');
    process.exit(1);
  }

  const { values, positionals } = parsed;

  // Validate required positional arguments and apply coercions
  const requiredArgs = cmd.args.filter((a) => a.required);
  const hasVariadic = cmd.args.some((a) => a.variadic);

  if (positionals.length < requiredArgs.length) {
    const missing = requiredArgs[positionals.length];
    console.error(`Error: missing required argument '${missing.name}'.`);
    console.error('(run with --help for usage)');
    process.exit(1);
  }

  if (!hasVariadic && positionals.length > cmd.args.length) {
    console.error(`Error: too many arguments. Expected ${cmd.args.length}, got ${positionals.length}.`);
    console.error('(run with --help for usage)');
    process.exit(1);
  }

  // Apply coercions to positional args
  const coerced = [...positionals];
  for (let i = 0; i < cmd.args.length && i < coerced.length; i++) {
    if (cmd.args[i].coerce) {
      coerced[i] = cmd.args[i].coerce(coerced[i], cmd.args[i].name);
    }
  }

  await cmd.action(coerced, values);
}

main().catch(handleError);
