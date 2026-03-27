#!/usr/bin/env node
/**
 * Blink Wallet — L402 Service Info
 *
 * Usage:
 *   node l402_info.js <service_id> [options]
 *
 * Get full details for an L402 service from l402.directory.
 * Optionally fetch a paid health report (10 sats via L402).
 *
 * Arguments:
 *   service_id      - Required. Service ID from l402.directory (hex string).
 *   --report        - Optional. Fetch paid health report (10 sats, L402-gated).
 *
 * The --report flag triggers an L402 payment. It is subject to budget controls
 * and domain allowlist (domain: l402.directory). Use --force to bypass.
 *
 * No API key required for the free detail endpoint.
 * Write scope required for --report (L402 payment).
 *
 * Output: JSON to stdout. Status messages to stderr.
 * Dependencies: None (Node.js 18+ built-in fetch).
 */

'use strict';

const { parseArgs } = require('node:util');

// ── URLs ─────────────────────────────────────────────────────────────────────

const DIRECTORY_BASE = 'https://l402.directory/api';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      report: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.error(
      [
        'Usage: blink l402-info <service_id> [--report] [--force]',
        '',
        'Options:',
        '  --report   Fetch paid health report (10 sats via L402)',
        '  --force    Bypass budget and domain checks for --report',
        '  --help     Show this help',
      ].join('\n'),
    );
    process.exit(0);
  }

  const serviceId = positionals[0];
  if (!serviceId) {
    throw new Error('Missing required argument: service_id. Run with --help for usage.');
  }

  return {
    serviceId,
    report: values.report,
    force: values.force,
  };
}

// ── Free detail endpoint ─────────────────────────────────────────────────────

async function fetchServiceDetail(serviceId) {
  const url = `${DIRECTORY_BASE}/services/${serviceId}`;
  console.error(`Fetching service detail from l402.directory...`);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 404) {
    throw new Error(`Service not found: ${serviceId}`);
  }
  if (!res.ok) {
    throw new Error(`l402.directory returned HTTP ${res.status}`);
  }

  return res.json();
}

// ── Paid report endpoint (L402) ──────────────────────────────────────────────

async function fetchServiceReport(serviceId, { force }) {
  // Delegate to l402-pay for the L402 payment flow
  const { checkBudget, checkDomainAllowed, recordSpend } = require('./_budget');

  const reportUrl = `${DIRECTORY_BASE}/report/${serviceId}`;
  const domain = 'l402.directory';

  // Domain allowlist check
  if (!force) {
    const domainCheck = checkDomainAllowed(domain);
    if (!domainCheck.allowed) {
      const output = {
        event: 'l402_domain_blocked',
        url: reportUrl,
        domain,
        allowlist: domainCheck.allowlist,
        message: `Domain "${domain}" is not in the L402 allowlist. Add with: blink budget allowlist add ${domain}`,
      };
      console.log(JSON.stringify(output, null, 2));
      process.exit(1);
    }
  }

  // Budget check (report costs 10 sats)
  if (!force) {
    const budgetResult = checkBudget(10);
    if (!budgetResult.allowed) {
      const output = {
        event: 'l402_budget_exceeded',
        url: reportUrl,
        satoshis: 10,
        ...budgetResult,
        message: budgetResult.reason,
      };
      console.log(JSON.stringify(output, null, 2));
      process.exit(1);
    }
  }

  // Use l402_pay's main logic by setting up argv and calling it
  const origArgv = process.argv;
  process.argv = ['node', 'blink', reportUrl];
  if (force) process.argv.push('--force');

  try {
    const { main: l402PayMain } = require('./l402_pay');
    await l402PayMain();
  } finally {
    process.argv = origArgv;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.report) {
    await fetchServiceReport(args.serviceId, { force: args.force });
  } else {
    const detail = await fetchServiceDetail(args.serviceId);
    console.log(JSON.stringify(detail, null, 2));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = { main, parseCliArgs, fetchServiceDetail, DIRECTORY_BASE };
