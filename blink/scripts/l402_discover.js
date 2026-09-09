#!/usr/bin/env node
/**
 * Blink Wallet - L402 Service Discovery
 *
 * Usage: node l402_discover.js <url> [--method GET|POST] [--header key:value]
 *
 * Probes a URL for L402 payment requirements without paying.
 * Parses both L402 formats:
 *   - Lightning Labs: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
 *   - l402-protocol.org: JSON body with payment_request_url and offers array
 *
 * Arguments:
 *   url             - Required. The URL to probe.
 *   --method        - Optional. HTTP method: GET (default) or POST.
 *   --header        - Optional. Extra header in key:value format (repeatable).
 *
 * Environment:
 *   BLINK_API_KEY   - Optional. Not required for discovery.
 *   BLINK_API_URL   - Optional. Override Blink API endpoint.
 *
 * Dependencies: None (uses Node.js built-in fetch)
 *
 * Output: JSON to stdout. Status messages to stderr.
 */

'use strict';

// ── Inline L402 parsing ───────────────────────────────────────────────────────

/**
 * Parse a Lightning Labs L402 WWW-Authenticate header.
 *
 * Format: L402 macaroon="<base64>", invoice="<lnbc...>"
 *
 * @param {string} header
 * @returns {{ macaroon: string, invoice: string } | null}
 */
function parseLightningLabsHeader(header) {
  if (!header) return null;
  const trimmed = header.trim();
  // Must start with "L402 " (case-insensitive)
  if (!/^l402\s/i.test(trimmed)) return null;

  const macaroonMatch = trimmed.match(/macaroon\s*=\s*"([^"]+)"/i);
  const invoiceMatch = trimmed.match(/invoice\s*=\s*"([^"]+)"/i);

  if (!macaroonMatch || !invoiceMatch) return null;
  return {
    macaroon: macaroonMatch[1],
    invoice: invoiceMatch[1],
  };
}

/**
 * Parse a l402-protocol.org JSON 402 response body.
 *
 * The spec (v0.2.x) returns JSON with:
 *   { version, payment_request_url, offers: [{ title, amount, currency, ... }] }
 *
 * @param {object} body   Parsed JSON from the 402 response.
 * @returns {{ paymentRequestUrl: string, offers: object[] } | null}
 */
function parseL402ProtocolBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (!body.payment_request_url && !Array.isArray(body.offers)) return null;
  return {
    paymentRequestUrl: body.payment_request_url || null,
    version: body.version || null,
    offers: Array.isArray(body.offers) ? body.offers : [],
  };
}

/**
 * Resolve the canonical URL by following any HTTP redirects.
 *
 * Sends a HEAD request with redirect:'follow' and returns response.url —
 * the final URL after the redirect chain. Falls back gracefully to the
 * original URL on any error (network failure, 405 Method Not Allowed, etc.).
 *
 * @param {string} url
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<string>}
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
    return res.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch payment details from l402-protocol.org endpoint.
 * POST to payment_request_url to retrieve the Lightning invoice.
 *
 * @param {string} paymentRequestUrl
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<{ invoice: string, offerId: string | null } | null>}
 */
async function fetchL402ProtocolInvoice(paymentRequestUrl, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(paymentRequestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Response shape: { invoice: "lnbc...", ... } or { payment_request: "lnbc..." }
    const invoice = data.invoice || data.payment_request || null;
    return invoice ? { invoice, offerId: data.offer_id || null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode the amount from a BOLT-11 invoice without any external library.
 * Reads the human-readable part (amount + multiplier) from the invoice prefix.
 *
 * Supports mainnet (lnbc), testnet (lntb), signet (lntbs).
 * Returns null if not parseable.
 *
 * @param {string} invoice
 * @returns {{ amount: number, multiplier: string } | null}
 */
function bolt11AmountParts(invoice) {
  if (!invoice) return null;
  const lower = invoice.toLowerCase();

  // Strip the bech32 prefix: lnbc, lntb, lntbs
  let amountStr;
  if (lower.startsWith('lntbs')) {
    amountStr = lower.slice(5);
  } else if (lower.startsWith('lntb')) {
    amountStr = lower.slice(4);
  } else if (lower.startsWith('lnbc')) {
    amountStr = lower.slice(4);
  } else {
    return null;
  }

  // The amount field is digits followed by an optional multiplier letter,
  // then "1" (separator) and the rest of the encoded data.
  const match = amountStr.match(/^(\d+)([munp]?)1/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  if (isNaN(amount)) return null;
  return { amount, multiplier: match[2] };
}

/**
 * Decode a BOLT-11 invoice amount in SATOSHIS (legacy, round-to-nearest).
 * Callers that enforce money limits must NOT use this directly: rounding can
 * push a below-1-sat invoice up to 1 sat and shave fractions off larger ones.
 * Use budgetSatsFromInvoice() for enforcement.
 *
 * @param {string} invoice
 * @returns {number | null}  Amount in satoshis, or null.
 */
function decodeBolt11AmountSats(invoice) {
  const parts = bolt11AmountParts(invoice);
  if (!parts) return null;

  const { amount, multiplier } = parts;
  // Convert to satoshis.
  // Multipliers (from BOLT-11):
  //   m = milli   → 0.001 BTC  → 1e5 sats  per unit
  //   u = micro   → 0.000001 BTC → 100 sats per unit
  //   n = nano    → 1e-9 BTC   → 0.1 sats per unit → round
  //   p = pico    → 1e-12 BTC  → 0.0001 sats per unit → round
  //   (none)      → whole BTC  → 1e8 sats per unit
  const BTC_TO_SAT = 100_000_000;
  switch (multiplier) {
    case '':
      return amount * BTC_TO_SAT;
    case 'm':
      return Math.round(amount * BTC_TO_SAT * 0.001);
    case 'u':
      return Math.round(amount * BTC_TO_SAT * 0.000_001);
    case 'n':
      return Math.round(amount * BTC_TO_SAT * 0.000_000_001);
    case 'p':
      return Math.round(amount * BTC_TO_SAT * 0.000_000_000_001);
    default:
      return null;
  }
}

/**
 * Decode a BOLT-11 invoice amount in MILLISATOSHIS — full precision, no
 * rounding. Returns null if not parseable.
 *
 * @param {string} invoice
 * @returns {number | null}  Amount in millisatoshis, or null.
 */
function decodeBolt11AmountMsats(invoice) {
  const parts = bolt11AmountParts(invoice);
  if (!parts) return null;

  const { amount, multiplier } = parts;
  switch (multiplier) {
    case '':
      return amount * 100_000_000_000; // whole BTC → 1e11 msats
    case 'm':
      return amount * 100_000_000; // 1e5 sats → 1e8 msats
    case 'u':
      return amount * 100_000; // 100 sats → 1e5 msats
    case 'n':
      return amount * 100; // 0.1 sats → 100 msats
    case 'p':
      return amount / 10; // 0.0001 sats → 0.1 msats (sub-msat invoices stay fractional)
    default:
      return null;
  }
}

/**
 * The amount a BOLT-11 invoice must be CHARGED against the budget, in sats.
 *
 * Rules (conservative — the budget must never under-count):
 *   - undecodable, or strictly below 1 satoshi (< 1000 msats)  → null
 *     (callers refuse: no limit can be enforced on such an amount)
 *   - otherwise                                                → ceil(msats / 1000)
 *
 * So a 1400-msat invoice charges 2 sats, and a 500-msat invoice is refused.
 *
 * @param {string} invoice
 * @returns {number | null}
 */
function budgetSatsFromInvoice(invoice) {
  const msats = decodeBolt11AmountMsats(invoice);
  if (msats === null || msats < 1000) return null;
  return Math.ceil(msats / 1000);
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let url = null;
  let method = 'GET';
  const headers = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--method' && i + 1 < argv.length) {
      method = argv[++i].toUpperCase();
      if (!['GET', 'POST'].includes(method)) {
        console.error('Error: --method must be GET or POST');
        process.exit(1);
      }
    } else if (arg === '--header' && i + 1 < argv.length) {
      const hdr = argv[++i];
      const colon = hdr.indexOf(':');
      if (colon < 1) {
        console.error(`Error: --header must be in key:value format, got: ${hdr}`);
        process.exit(1);
      }
      headers[hdr.slice(0, colon).trim()] = hdr.slice(colon + 1).trim();
    } else if (!arg.startsWith('--')) {
      url = arg;
    }
  }

  return { url, method, headers };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    console.error('Usage: node l402_discover.js <url> [--method GET|POST] [--header key:value]');
    process.exit(1);
  }

  console.error(`Probing: ${args.url}`);

  // Resolve canonical URL (follow any HTTP redirects) so the probe always
  // hits the final endpoint and reports the correct URL.
  const canonicalUrl = await resolveCanonicalUrl(args.url);
  if (canonicalUrl !== args.url) {
    console.error(`Resolved redirect: ${args.url} → ${canonicalUrl}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res;
  try {
    res = await fetch(canonicalUrl, {
      method: args.method,
      headers: {
        Accept: 'application/json',
        ...args.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 402) {
    const body = await res.text().catch(() => '');
    const output = {
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      l402_detected: false,
      status: res.status,
      message:
        res.status === 200
          ? 'No L402 protection detected — resource returned 200 OK.'
          : `Unexpected status ${res.status}. Not an L402 endpoint.`,
      body: body.length <= 500 ? body : body.slice(0, 500) + '…',
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.error('402 Payment Required detected — parsing L402 challenge...');

  // ── Try Lightning Labs format first (WWW-Authenticate header) ──
  const wwwAuth = res.headers.get('www-authenticate') || res.headers.get('WWW-Authenticate') || '';
  const lightningLabs = parseLightningLabsHeader(wwwAuth);

  if (lightningLabs) {
    console.error('Format: Lightning Labs (macaroon + invoice in WWW-Authenticate)');
    const satoshis = decodeBolt11AmountSats(lightningLabs.invoice);
    const output = {
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      l402_detected: true,
      format: 'lightning-labs',
      macaroon: lightningLabs.macaroon,
      invoice: lightningLabs.invoice,
      satoshis,
      satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Try l402-protocol.org format (JSON body) ──
  let bodyJson = null;
  try {
    const bodyText = await res.text();
    bodyJson = JSON.parse(bodyText);
  } catch {
    // Not JSON — report raw
  }

  const l402proto = parseL402ProtocolBody(bodyJson);

  if (l402proto) {
    console.error('Format: l402-protocol.org (JSON offers)');

    let invoice = null;
    let offerId = null;

    if (l402proto.paymentRequestUrl) {
      console.error(`Fetching invoice from: ${l402proto.paymentRequestUrl}`);
      const fetched = await fetchL402ProtocolInvoice(l402proto.paymentRequestUrl);
      if (fetched) {
        invoice = fetched.invoice;
        offerId = fetched.offerId;
      }
    }

    const satoshis = invoice ? decodeBolt11AmountSats(invoice) : null;

    const output = {
      url: args.url,
      canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
      l402_detected: true,
      format: 'l402-protocol',
      version: l402proto.version,
      paymentRequestUrl: l402proto.paymentRequestUrl,
      offers: l402proto.offers,
      invoice,
      offerId,
      satoshis,
      satoshisFormatted: satoshis !== null ? `${satoshis} sats` : null,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ── Unknown 402 format ──
  console.error('Warning: 402 received but could not parse L402 challenge.');
  const output = {
    url: args.url,
    canonicalUrl: canonicalUrl !== args.url ? canonicalUrl : undefined,
    l402_detected: true,
    format: 'unknown',
    wwwAuthenticate: wwwAuth || null,
    body: bodyJson,
    message: 'Received 402 but could not identify Lightning Labs or l402-protocol format.',
  };
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  parseLightningLabsHeader,
  parseL402ProtocolBody,
  decodeBolt11AmountSats,
  decodeBolt11AmountMsats,
  budgetSatsFromInvoice,
  fetchL402ProtocolInvoice,
  resolveCanonicalUrl,
  main,
};
