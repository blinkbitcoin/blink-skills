#!/usr/bin/env node
/**
 * Blink Wallet - L402 Auto-Pay Client
 *
 * Usage: node l402_pay.js <url> [options]
 *
 * Makes an HTTP request to a URL. If it returns 402 Payment Required,
 * automatically parses the L402 challenge, pays the Lightning invoice via
 * the Blink wallet, and retries the request with the payment proof.
 *
 * Supports both L402 formats:
 *   - Lightning Labs: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
 *   - l402-protocol.org: JSON body with payment_request_url and offers array
 *
 * Cached tokens (from previous payments) are checked first to avoid re-paying.
 *
 * Arguments:
 *   url              - Required. The URL to access.
 *   --wallet         - Optional. BTC (default) or USD.
 *   --max-amount     - Optional. Refuse to pay more than N sats (safety limit).
 *   --dry-run        - Optional. Discover price without paying.
 *   --method         - Optional. HTTP method: GET (default) or POST.
 *   --header         - Optional. Extra request header in key:value format (repeatable).
 *   --body           - Optional. Request body (for POST requests).
 *   --no-store       - Optional. Do not read from or write to the token store.
 *   --force          - Optional. Pay even if a cached token exists.
 *   --probe          - Optional. Run a fee probe before paying; warns and continues if route not found.
 *
 * Environment:
 *   BLINK_API_KEY    - Required. Blink API key with Write scope.
 *   BLINK_API_URL    - Optional. Override Blink GraphQL endpoint.
 *
 * Dependencies: None (uses Node.js built-in fetch + _blink_client.js)
 *
 * CAUTION: This sends real bitcoin. The API key must have Write scope.
 *
 * Output: JSON to stdout. Status messages to stderr.
 */

'use strict';

const {
  getApiKey,
  getApiUrl,
  graphqlRequest,
  getWallet,
  formatBalance,
  MUTATION_TIMEOUT_MS,
} = require('./_blink_client');

const {
  parseLightningLabsHeader,
  parseL402ProtocolBody,
  decodeBolt11AmountSats,
  fetchL402ProtocolInvoice,
} = require('./l402_discover');

const { saveToken, getToken } = require('./l402_store');

// ── GraphQL mutation (same as pay_invoice.js) ─────────────────────────────────

const PAY_INVOICE_MUTATION = `
  mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
    lnInvoicePaymentSend(input: $input) {
      status
      errors {
        code
        message
        path
      }
      transaction {
        initiationVia {
          ... on InitiationViaLn {
            paymentHash
          }
        }
        settlementVia {
          ... on SettlementViaLn {
            preImage
          }
        }
      }
    }
  }
`;

// Query to retrieve preimage by payment hash (fallback).
// Used when the mutation response does not include settlementVia (e.g. race condition, network issue).
const TRANSACTIONS_BY_HASH_QUERY = `
  query TransactionsForPreimage($first: Int, $walletIds: [WalletId]) {
    me {
      defaultAccount {
        transactions(first: $first, walletIds: $walletIds) {
          edges {
            node {
              initiationVia {
                ... on InitiationViaLn {
                  paymentHash
                }
              }
              settlementVia {
                ... on SettlementViaLn {
                  preImage
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ── Fee probe mutations ───────────────────────────────────────────────────────

const FEE_PROBE_BTC_MUTATION = `
  mutation LnInvoiceFeeProbe($input: LnInvoiceFeeProbeInput!) {
    lnInvoiceFeeProbe(input: $input) {
      amount
      errors {
        code
        message
        path
      }
    }
  }
`;

const FEE_PROBE_USD_MUTATION = `
  mutation LnUsdInvoiceFeeProbe($input: LnUsdInvoiceFeeProbeInput!) {
    lnUsdInvoiceFeeProbe(input: $input) {
      amount
      errors {
        code
        message
        path
      }
    }
  }
`;

/**
 * Run a fee probe for a Lightning invoice via the Blink API.
 *
 * Returns an object with:
 *   { estimatedFeeSats: number | null, error: string | null }
 *
 * Never throws — errors are captured and returned as { error }.
 * The caller decides whether to abort or warn-and-continue.
 *
 * @param {string} invoice   BOLT-11 payment request.
 * @param {object} opts
 * @param {string} opts.walletId
 * @param {string} opts.walletCurrency  'BTC' or 'USD'
 * @param {string} opts.apiKey
 * @param {string} opts.apiUrl
 * @returns {Promise<{ estimatedFeeSats: number | null, error: string | null }>}
 */
async function runFeeProbe(invoice, { walletId, walletCurrency, apiKey, apiUrl }) {
  const mutation = walletCurrency === 'USD' ? FEE_PROBE_USD_MUTATION : FEE_PROBE_BTC_MUTATION;
  const mutationKey = walletCurrency === 'USD' ? 'lnUsdInvoiceFeeProbe' : 'lnInvoiceFeeProbe';
  try {
    const data = await graphqlRequest({
      query: mutation,
      variables: { input: { walletId, paymentRequest: invoice } },
      apiKey,
      apiUrl,
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
    const result = data[mutationKey];
    if (result.errors && result.errors.length > 0) {
      const msg = result.errors.map((e) => `${e.message}${e.code ? ` [${e.code}]` : ''}`).join(', ');
      return { estimatedFeeSats: null, error: msg };
    }
    return { estimatedFeeSats: result.amount ?? null, error: null };
  } catch (err) {
    return { estimatedFeeSats: null, error: err.message };
  }
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let url = null;
  let walletCurrency = 'BTC';
  let maxAmount = null;
  let dryRun = false;
  let method = 'GET';
  let noStore = false;
  let force = false;
  let probe = false;
  let body = null;
  const headers = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--wallet' && i + 1 < argv.length) {
      walletCurrency = argv[++i].toUpperCase();
      if (!['BTC', 'USD'].includes(walletCurrency)) {
        console.error('Error: --wallet must be BTC or USD');
        process.exit(1);
      }
    } else if (arg === '--max-amount' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (isNaN(n) || n <= 0) {
        console.error('Error: --max-amount must be a positive integer (sats)');
        process.exit(1);
      }
      maxAmount = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-store') {
      noStore = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--probe') {
      probe = true;
    } else if (arg === '--method' && i + 1 < argv.length) {
      method = argv[++i].toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        console.error('Error: unsupported --method');
        process.exit(1);
      }
    } else if (arg === '--header' && i + 1 < argv.length) {
      const hdr = argv[++i];
      const colon = hdr.indexOf(':');
      if (colon < 1) {
        console.error(`Error: --header must be key:value, got: ${hdr}`);
        process.exit(1);
      }
      headers[hdr.slice(0, colon).trim()] = hdr.slice(colon + 1).trim();
    } else if (arg === '--body' && i + 1 < argv.length) {
      body = argv[++i];
    } else if (!arg.startsWith('--')) {
      url = arg;
    }
  }

  return { url, walletCurrency, maxAmount, dryRun, method, noStore, force, probe, headers, body };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Make an HTTP request with a timeout.
 *
 * @param {string} url
 * @param {object} options   fetch options
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the canonical URL by following any HTTP redirects.
 *
 * Sends a HEAD request with redirect:'follow' and returns response.url —
 * the final URL after the redirect chain. This prevents two failure modes:
 *
 *   1. Token cached under the wrong domain (e.g. www.satring.com instead of
 *      satring.com) when the user supplies a URL that redirects.
 *   2. L402 Authorization header stripped by fetch on the retry request
 *      because the WHATWG Fetch spec forbids forwarding Authorization across
 *      cross-host redirects (redirect-fetch step 12).
 *
 * Falls back gracefully to the original URL on any error (network failure,
 * 405 Method Not Allowed, etc.) so existing behaviour is preserved.
 *
 * @param {string} url
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<string>}  The canonical URL (post-redirect), or the
 *                             original URL if resolution fails.
 */
async function resolveCanonicalUrl(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    // res.url is the final URL after all redirects; fall back to input if empty.
    return res.url || url;
  } catch {
    // Network error, timeout, or server that rejects HEAD — degrade gracefully.
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the domain (hostname) from a URL string.
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── L402 challenge resolution ─────────────────────────────────────────────────

/**
 * Resolve an L402 challenge from a 402 response.
 * Returns the invoice to pay and the macaroon token.
 *
 * @param {Response} res
 * @returns {Promise<{ invoice: string, macaroon: string, format: string } | null>}
 */
async function resolveL402Challenge(res) {
  // Try Lightning Labs format (WWW-Authenticate header)
  const wwwAuth = res.headers.get('www-authenticate') || '';
  const lightningLabs = parseLightningLabsHeader(wwwAuth);
  if (lightningLabs) {
    return {
      invoice: lightningLabs.invoice,
      macaroon: lightningLabs.macaroon,
      format: 'lightning-labs',
    };
  }

  // Try l402-protocol.org format (JSON body)
  let bodyJson = null;
  try {
    const text = await res.text();
    bodyJson = JSON.parse(text);
  } catch {
    return null;
  }

  const l402proto = parseL402ProtocolBody(bodyJson);
  if (!l402proto) return null;

  if (!l402proto.paymentRequestUrl) return null;

  console.error(`Fetching payment request from: ${l402proto.paymentRequestUrl}`);
  const fetched = await fetchL402ProtocolInvoice(l402proto.paymentRequestUrl);
  if (!fetched) return null;

  // For l402-protocol format, the "macaroon" is the token returned after payment.
  // We store the offer id as the pre-payment token placeholder.
  return {
    invoice: fetched.invoice,
    macaroon: fetched.offerId || '',
    format: 'l402-protocol',
    offerId: fetched.offerId,
    paymentRequestUrl: l402proto.paymentRequestUrl,
    offers: l402proto.offers,
  };
}

// ── Preimage resolution ───────────────────────────────────────────────────────

/**
 * Attempt to retrieve the real payment preimage from the Blink transactions list.
 *
 * This is the fallback path: a second GraphQL query after payment, matching
 * by paymentHash from lnInvoicePaymentSend's transaction. Used when the
 * inline preimage from the mutation response is unavailable.
 *
 * Returns the preimage hex string if found, or null if not available yet.
 *
 * @param {string} paymentHash  64-char hex payment hash (from initiationVia.paymentHash).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.apiUrl
 * @param {string} [opts.walletId]  Optional: narrow to one wallet.
 * @returns {Promise<string|null>}
 */
async function fetchPreimageByPaymentHash(paymentHash, { apiKey, apiUrl, walletId }) {
  if (!paymentHash) return null;
  try {
    const variables = { first: 10 };
    if (walletId) variables.walletIds = [walletId];

    const data = await graphqlRequest({
      query: TRANSACTIONS_BY_HASH_QUERY,
      variables,
      apiKey,
      apiUrl,
      timeoutMs: 10_000,
    });

    const edges = data?.me?.defaultAccount?.transactions?.edges ?? [];
    for (const { node } of edges) {
      const txHash = node?.initiationVia?.paymentHash;
      if (txHash && txHash.toLowerCase() === paymentHash.toLowerCase()) {
        const preImage = node?.settlementVia?.preImage;
        if (preImage) return preImage;
      }
    }
  } catch (err) {
    console.error(`Warning: preimage lookup query failed: ${err.message}`);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error(
      'Usage: node l402_pay.js <url> [--wallet BTC|USD] [--max-amount <sats>] [--dry-run] [--no-store] [--force]',
    );
    process.exit(1);
  }

  // ── Resolve canonical URL (follow any HTTP redirects) ──
  // This must happen before the token cache lookup and before any fetch so
  // that: (a) the cache key is the canonical domain, and (b) the L402
  // Authorization header is not stripped by fetch when following redirects
  // from a non-canonical URL (WHATWG Fetch spec forbids forwarding
  // Authorization across cross-host redirects).
  const canonicalUrl = await resolveCanonicalUrl(args.url);
  if (canonicalUrl !== args.url) {
    console.error(`Resolved redirect: ${args.url} → ${canonicalUrl}`);
  }

  const domain = extractDomain(canonicalUrl);

  // ── Check token store first ──
  // Skip cache on --dry-run: dry-run must always probe the server fresh so it
  // can report the current invoice price, even if a cached token exists.
  if (!args.noStore && !args.force && !args.dryRun) {
    const cached = getToken(domain);
    if (cached) {
      console.error(`Using cached L402 token for ${domain} (paid ${cached.satoshis ?? '?'} sats previously).`);
      console.error('Retrying request with cached token...');

      const authHeader = `L402 ${cached.macaroon}:${cached.preimage}`;
      const res = await fetchWithTimeout(canonicalUrl, {
        method: args.method,
        headers: { Accept: 'application/json', Authorization: authHeader, ...args.headers },
        ...(args.body ? { body: args.body } : {}),
      });

      const body = await res.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        data = body;
      }

      if (res.status !== 200) {
        // Cached token rejected or server unreachable — emit l402_error so the
        // caller can distinguish a successful cached-token hit from a failure.
        const output = {
          event: 'l402_error',
          url: args.url,
          canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
          status: res.status,
          tokenReused: true,
          satoshis: cached.satoshis ?? null,
          message: `Cached token returned status ${res.status}. Token may be expired or server is unreachable.`,
          data,
        };
        console.log(JSON.stringify(output, null, 2));
        process.exit(1);
        return; // unreachable in production; guards against mocked process.exit in tests
      }

      const output = {
        event: 'l402_paid',
        url: args.url,
        canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
        status: res.status,
        tokenReused: true,
        satoshis: cached.satoshis ?? null,
        data,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }
  }

  // ── Initial request ──
  console.error(`Requesting: ${canonicalUrl}`);
  const reqOptions = {
    method: args.method,
    headers: { Accept: 'application/json', ...args.headers },
    ...(args.body ? { body: args.body } : {}),
  };

  const initialRes = await fetchWithTimeout(canonicalUrl, reqOptions);

  if (initialRes.status === 200) {
    const body = await initialRes.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }
    const output = {
      event: 'l402_not_required',
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      status: 200,
      message: 'Resource returned 200 OK — no payment required.',
      data,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (initialRes.status !== 402) {
    const body = await initialRes.text().catch(() => '');
    // On --dry-run, emit structured JSON instead of throwing so the caller
    // always gets machine-readable output even when the server is down or
    // returns an unexpected status (e.g. 403/503 during an outage).
    if (args.dryRun) {
      const output = {
        event: 'l402_dry_run',
        url: args.url,
        canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
        status: initialRes.status,
        error: `Unexpected status ${initialRes.status}: ${body.slice(0, 200)}`,
        message: 'Dry-run: server did not return 402. No payment would be made.',
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    throw new Error(`Unexpected status ${initialRes.status}: ${body.slice(0, 200)}`);
  }

  console.error('402 Payment Required — parsing L402 challenge...');

  // ── Resolve challenge ──
  const challenge = await resolveL402Challenge(initialRes);
  if (!challenge) {
    throw new Error('Could not parse L402 challenge from 402 response. Try l402_discover.js for diagnostics.');
  }

  console.error(`Format: ${challenge.format}`);

  const satoshis = decodeBolt11AmountSats(challenge.invoice);

  if (satoshis === null) {
    console.error('Warning: could not decode amount from invoice.');
  } else {
    console.error(`Payment required: ${satoshis} sats`);
  }

  // ── Budget check ──
  if (args.maxAmount !== null && satoshis !== null && satoshis > args.maxAmount) {
    const output = {
      event: 'l402_budget_exceeded',
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      satoshis,
      maxAmount: args.maxAmount,
      message: `Payment of ${satoshis} sats exceeds --max-amount of ${args.maxAmount} sats. Aborting.`,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  // ── Dry-run: report price and exit ──
  if (args.dryRun) {
    const output = {
      event: 'l402_dry_run',
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      format: challenge.format,
      invoice: challenge.invoice,
      satoshis,
      satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
      maxAmount: args.maxAmount,
      withinBudget: args.maxAmount !== null && satoshis !== null ? satoshis <= args.maxAmount : null,
      message: 'Dry-run: would pay this invoice to access the resource. No payment made.',
      ...(challenge.offers ? { offers: challenge.offers } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Pay the invoice ──
  const apiKey = getApiKey();
  const apiUrl = getApiUrl();

  const wallet = await getWallet({ apiKey, apiUrl, currency: args.walletCurrency });
  console.error(`Using ${args.walletCurrency} wallet ${wallet.id} (balance: ${formatBalance(wallet)})`);

  if (args.walletCurrency === 'BTC' && wallet.balance === 0) {
    throw new Error('Insufficient balance: BTC wallet has 0 sats.');
  }

  // ── Optional fee probe (--probe) ──
  // Run lnInvoiceFeeProbe before paying to check the route exists.
  // On failure: warn to stderr and continue — probe errors don't mean payment
  // will fail (the probe is best-effort). On success: log estimated fee.
  let feeProbeResult = null;
  if (args.probe) {
    console.error('Running fee probe...');
    feeProbeResult = await runFeeProbe(challenge.invoice, {
      walletId: wallet.id,
      walletCurrency: args.walletCurrency,
      apiKey,
      apiUrl,
    });
    if (feeProbeResult.error) {
      console.error(`Warning: fee probe failed (${feeProbeResult.error}) — proceeding with payment anyway.`);
    } else {
      console.error(
        `Fee probe: estimated routing fee = ${feeProbeResult.estimatedFeeSats ?? 0} sats. Proceeding with payment.`,
      );
    }
  }

  console.error(`Paying ${satoshis ?? '?'} sats via Blink...`);

  const payData = await graphqlRequest({
    query: PAY_INVOICE_MUTATION,
    variables: { input: { walletId: wallet.id, paymentRequest: challenge.invoice } },
    apiKey,
    apiUrl,
    timeoutMs: MUTATION_TIMEOUT_MS,
  });

  const payResult = payData.lnInvoicePaymentSend;

  if (payResult.errors && payResult.errors.length > 0) {
    const errMsg = payResult.errors.map((e) => `${e.message}${e.code ? ` [${e.code}]` : ''}`).join(', ');
    throw new Error(`Payment failed: ${errMsg}`);
  }

  if (payResult.status !== 'SUCCESS' && payResult.status !== 'ALREADY_PAID') {
    throw new Error(`Payment not successful: status=${payResult.status}`);
  }

  console.error(`Payment ${payResult.status === 'ALREADY_PAID' ? 'already paid' : 'successful'}!`);

  // ── Resolve preimage ──
  // Option A (primary): preImage returned inline via settlementVia in the mutation response.
  // Option B (fallback): second query to transactions, match by paymentHash.
  //   Covers edge cases where inline resolution is unavailable (race condition, network issue).
  // Option C (last resort): SHA-256(invoice) placeholder — works with non-strict servers only.
  let preimage = payResult.transaction?.settlementVia?.preImage ?? null;
  const paymentHash = payResult.transaction?.initiationVia?.paymentHash ?? null;

  if (preimage) {
    console.error('Preimage received inline from payment response.');
  } else if (paymentHash) {
    console.error(`Fetching preimage via transactions query (paymentHash: ${paymentHash.slice(0, 16)}…)`);
    preimage = await fetchPreimageByPaymentHash(paymentHash, {
      apiKey,
      apiUrl,
      walletId: wallet.id,
    });
    if (preimage) {
      console.error('Preimage resolved via transactions query.');
    } else {
      console.error('Warning: preimage not yet indexed. Using placeholder (non-strict servers only).');
      preimage = derivePreimageFromInvoice(challenge.invoice);
    }
  } else {
    console.error('Warning: paymentHash not returned by API. Using preimage placeholder (non-strict servers only).');
    preimage = derivePreimageFromInvoice(challenge.invoice);
  }

  const macaroon = challenge.macaroon;

  // ── Save token to store ──
  if (!args.noStore) {
    try {
      saveToken(domain, {
        macaroon,
        preimage,
        invoice: challenge.invoice,
        satoshis: satoshis ?? null,
      });
      console.error(`Token cached for ${domain}.`);
    } catch (err) {
      console.error(`Warning: could not save token to store: ${err.message}`);
    }
  }

  // ── Retry request with proof of payment ──
  console.error('Retrying request with L402 authorization...');
  const authHeader = `L402 ${macaroon}:${preimage}`;

  const retryRes = await fetchWithTimeout(canonicalUrl, {
    method: args.method,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      ...args.headers,
    },
    ...(args.body ? { body: args.body } : {}),
  });

  const retryBody = await retryRes.text();
  let retryData;
  try {
    retryData = JSON.parse(retryBody);
  } catch {
    retryData = retryBody;
  }

  const output = {
    event: 'l402_paid',
    url: args.url,
    canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
    format: challenge.format,
    paymentStatus: payResult.status,
    walletId: wallet.id,
    walletCurrency: args.walletCurrency,
    satoshis: satoshis ?? null,
    tokenReused: false,
    feeProbe: feeProbeResult
      ? { estimatedFeeSats: feeProbeResult.estimatedFeeSats, error: feeProbeResult.error }
      : undefined,
    retryStatus: retryRes.status,
    data: retryData,
  };

  console.log(JSON.stringify(output, null, 2));

  if (retryRes.status !== 200) {
    console.error(`Warning: retry returned status ${retryRes.status} (expected 200).`);
    process.exit(1);
  }
}

/**
 * Derive a placeholder preimage from the BOLT-11 invoice when the API does
 * not return it directly. This is used only for token caching — the L402
 * server may accept or reject it depending on its verification mode.
 *
 * @param {string} invoice  BOLT-11 payment request.
 * @returns {string}  64-char hex string.
 */
function derivePreimageFromInvoice(invoice) {
  // Use a deterministic placeholder: pad the invoice chars to 64 hex chars.
  // This is NOT a real preimage and will only work with servers that do
  // not verify preimage hash matches. Agents should be aware of this limitation.
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(invoice).digest('hex');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  resolveCanonicalUrl,
  resolveL402Challenge,
  derivePreimageFromInvoice,
  fetchPreimageByPaymentHash,
  runFeeProbe,
};
