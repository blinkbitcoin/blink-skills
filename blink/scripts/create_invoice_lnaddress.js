#!/usr/bin/env node
/**
 * Blink Wallet - Create Invoice via Lightning Address (custodial OR non-custodial)
 *
 * Usage: node create_invoice_lnaddress.js <lightning_address> <amount_sats> [memo...]
 *                                         [--timeout <seconds>] [--no-verify]
 *
 * Receives a payment to ANY Blink Lightning Address (`user@blink.sv`) — whether
 * the recipient is a CUSTODIAL Blink account or a NON-CUSTODIAL (Spark) account.
 *
 * Unlike create_invoice.js (which needs the recipient's own BLINK_API_KEY and
 * calls the `lnInvoiceCreate` mutation on that account's wallet), this command
 * needs NO account credentials at all. It uses the public LNURL-pay endpoint
 * that blink.sv serves for both account types, and the blink-lnurl-server routes
 * the recipient to the correct provider internally.
 *
 * This is the ONLY receive path that works for non-custodial accounts without
 * holding the account seed.
 *
 * Output (two-phase, mirroring create_invoice.js):
 *   1. Immediately: `invoice_created` JSON (paymentRequest, verifyUrl, type, ...)
 *   2. When resolved: `verify_result` JSON (PAID / TIMEOUT) — only for
 *      non-custodial (lnaddress) recipients that return a LUD-21 verify URL.
 *
 * Arguments:
 *   lightning_address  - Required. `user@blink.sv` or a bare `user` (defaults to blink.sv).
 *   amount_sats        - Required. Amount in satoshis.
 *   memo...            - Optional. Remaining args joined as a comment.
 *   --timeout <s>      - Optional. Verify-poll timeout in seconds (default 300, 0 = no timeout).
 *   --no-verify        - Optional. Skip the LUD-21 verify polling; just create and exit.
 *
 * Environment:
 *   BLINK_API_KEY  - Optional. If present, improves the custodial-vs-non-custodial probe.
 *   BLINK_API_URL  - Optional. Override GraphQL endpoint (used for the custodial probe only).
 *
 * Dependencies: None (uses Node.js built-in fetch).
 */

const {
  getApiKey,
  getApiUrl,
  resolveReceiver,
  DEFAULT_LN_ADDRESS_DOMAIN,
  ALLOWED_LN_ADDRESS_DOMAINS,
} = require('./_blink_client');
const { getInvoiceFromLightningAddress, verifyLnurlPayment } = require('./_lnurl');

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let address = null;
  let amountSats = null;
  let timeoutSeconds = 300;
  let noVerify = false;
  const memoParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --timeout');
      timeoutSeconds = parseInt(value, 10);
      if (isNaN(timeoutSeconds) || timeoutSeconds < 0) throw new Error('--timeout must be a non-negative integer');
      i++;
      continue;
    }
    if (arg === '--no-verify') {
      noVerify = true;
      continue;
    }
    if (address === null) {
      address = arg.trim();
      continue;
    }
    if (amountSats === null) {
      amountSats = parseInt(arg, 10);
      if (isNaN(amountSats) || amountSats <= 0) throw new Error('amount_sats must be a positive integer');
      continue;
    }
    memoParts.push(arg);
  }

  return {
    address,
    amountSats,
    timeoutSeconds,
    noVerify,
    memo: memoParts.length > 0 ? memoParts.join(' ') : undefined,
  };
}

// ── LUD-21 verify polling ─────────────────────────────────────────────────────

// Verify-poll failures that will never succeed on retry, so must abort the poll
// rather than be absorbed into "not settled yet".
const FATAL_VERIFY_PATTERNS = [/DIFFERENT invoice/, /no `pr` to bind/, /Refusing to fetch/];

/**
 * Is this verify error a permanent policy rejection rather than a transient fault?
 * @param {Error} e
 * @returns {boolean}
 */
function isFatalVerifyError(e) {
  return FATAL_VERIFY_PATTERNS.some((re) => re.test(e && e.message ? e.message : ''));
}

/**
 * Poll a LUD-21 verify URL until the invoice settles or the deadline passes.
 *
 * `expectedPr` binds the result to the invoice we actually minted, so a
 * `settled: true` describing some other payment is treated as an error rather
 * than reported as "you were paid".
 *
 * @param {string} verifyUrl
 * @param {number} timeoutSeconds  0 means no timeout.
 * @param {string} expectedPr      The BOLT-11 this verify URL belongs to.
 */
async function pollVerify(verifyUrl, timeoutSeconds, expectedPr) {
  const intervalMs = 3000;
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;

  for (;;) {
    let status;
    try {
      status = await verifyLnurlPayment(verifyUrl, {
        allowedHosts: ALLOWED_LN_ADDRESS_DOMAINS,
        expectedPr,
      });
    } catch (e) {
      // A transient HTTP fault is worth retrying. A policy rejection — the
      // response settled a DIFFERENT invoice, or the URL failed the SSRF guard
      // — is deterministic: retrying only hides it, and with `--timeout 0` the
      // loop would hide it forever.
      if (isFatalVerifyError(e)) throw e;
      console.error(`verify poll error (will retry): ${e.message}`);
      status = { settled: false };
    }
    if (status.settled) {
      return { event: 'verify_result', status: 'PAID', settled: true, preimage: status.preimage, verifyUrl };
    }
    if (Date.now() >= deadline) {
      return { event: 'verify_result', status: 'TIMEOUT', settled: false, verifyUrl };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.address || args.amountSats === null) {
    console.error(
      'Usage: node create_invoice_lnaddress.js <lightning_address> <amount_sats> [memo...] [--timeout <seconds>] [--no-verify]',
    );
    process.exit(1);
  }

  // API key is optional here — the custodial probe works better with it, but a
  // non-custodial receive needs no credentials.
  const apiKey = getApiKey({ required: false });
  const apiUrl = getApiUrl();

  // 1. Classify the recipient (custodial vs non-custodial / Spark).
  const receiver = await resolveReceiver(args.address, {
    apiKey,
    apiUrl,
    defaultDomain: DEFAULT_LN_ADDRESS_DOMAIN,
  });

  console.error(`Resolved ${receiver.lightningAddress} as ${receiver.type} account.`);

  // 2. Mint the invoice over LNURL-pay (works for both account types).
  const invoice = await getInvoiceFromLightningAddress(receiver.lightningAddress, args.amountSats, args.memo, {
    defaultDomain: DEFAULT_LN_ADDRESS_DOMAIN,
    allowedHosts: ALLOWED_LN_ADDRESS_DOMAINS,
  });

  const creationResult = {
    event: 'invoice_created',
    accountType: receiver.type,
    lightningAddress: receiver.lightningAddress,
    paymentRequest: invoice.paymentRequest,
    verifyUrl: invoice.verify,
    satoshis: args.amountSats,
    // A wallet id only exists for custodial recipients.
    walletId: receiver.walletId,
  };
  console.log(JSON.stringify(creationResult, null, 2));

  // 3. Detect settlement via LUD-21 verify (the only cross-provider signal).
  if (args.noVerify) {
    console.error('Verify polling skipped (--no-verify).');
    return;
  }
  if (!invoice.verify) {
    console.error('No LUD-21 verify URL returned by the server; cannot poll for settlement here.');
    console.error('For custodial recipients you can instead subscribe with `create-invoice` on the recipient account.');
    return;
  }

  console.error(`Polling LUD-21 verify for settlement (timeout: ${args.timeoutSeconds}s)...`);
  console.error(
    'Note: for non-custodial (Spark) recipients the settled flag is webhook-populated and may lag a few seconds.',
  );
  const result = await pollVerify(invoice.verify, args.timeoutSeconds, invoice.paymentRequest);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.settled ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, pollVerify, isFatalVerifyError };
