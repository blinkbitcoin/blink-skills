/**
 * Blink Claw Skill — LNURL-pay client (zero dependencies)
 *
 * Minimal LUD-06 (LNURL-pay) + LUD-16 (Lightning Address) + LUD-21 (verify)
 * client used to RECEIVE payments to a Lightning Address without any account
 * credentials.
 *
 * Why this exists
 * ---------------
 * Blink custodial accounts create invoices via the GraphQL mutation
 * `lnInvoiceCreate` (see create_invoice.js). NON-CUSTODIAL (Spark) accounts do
 * not have a Blink wallet id and cannot use that mutation. However, the same
 * `blink.sv` domain serves LNURL-pay for BOTH account types — the
 * blink-lnurl-server routes each recipient to the correct provider (custodial
 * Blink or non-custodial Spark) internally. So an agent can receive to ANY
 * Blink Lightning Address (`user@blink.sv`) purely over LNURL-pay, with no
 * API key and no seed.
 *
 * This module is deliberately transport-only: it fetches LNURL-pay metadata,
 * requests a BOLT-11 invoice from the callback, and (for LUD-21) polls the
 * `verify` URL to detect settlement. It contains NO Blink GraphQL logic.
 *
 * Zero external dependencies — Node.js 18+ built-ins only (native fetch).
 */

const DEFAULT_LNURL_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

// ── Lightning Address parsing ────────────────────────────────────────────────

/**
 * Parse a Lightning Address (`user@domain`) into its parts.
 *
 * Accepts a bare username too (returns { username, domain: null }) so callers
 * can supply a default domain.
 *
 * @param {string} address  e.g. "alice@blink.sv" or "alice"
 * @returns {{ username: string, domain: string|null }}
 */
function parseLightningAddress(address) {
  const trimmed = String(address || '')
    .trim()
    .toLowerCase();
  if (!trimmed) throw new Error('Empty Lightning Address.');

  if (!trimmed.includes('@')) {
    // Bare username — caller decides the domain.
    if (!/^[a-z0-9._-]+$/.test(trimmed)) {
      throw new Error(`Invalid username: ${trimmed}`);
    }
    return { username: trimmed, domain: null };
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid Lightning Address (expected user@domain): ${address}`);
  }
  const [username, domain] = parts;
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new Error(`Invalid username in Lightning Address: ${address}`);
  }
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(domain)) {
    throw new Error(`Invalid domain in Lightning Address: ${address}`);
  }
  return { username, domain };
}

/**
 * Build the well-known LNURL-pay metadata URL for a Lightning Address.
 * @param {string} username
 * @param {string} domain
 * @returns {string}
 */
function lnurlpMetadataUrl(username, domain) {
  const scheme = domain.startsWith('localhost') || domain.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;
}

// ── fetch with timeout + retry ───────────────────────────────────────────────

/**
 * fetch() wrapper with a per-attempt timeout and bounded retry/backoff.
 *
 * blink-terminal learned that the Node HTTP client (undici) intermittently
 * throws transient "fetch failed" errors reaching blink.sv; a short retry with
 * `Connection: close` resolves it. We mirror that here.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {object} [opts.headers]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(
  url,
  { timeoutMs = DEFAULT_LNURL_TIMEOUT_MS, retries = DEFAULT_RETRIES, headers = {} } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', Connection: 'close', ...headers },
      });
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        // linear backoff: 250ms, 500ms, ...
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `LNURL request failed after ${retries + 1} attempt(s): ${lastErr ? lastErr.message : 'unknown error'}`,
  );
}

// ── LNURL-pay metadata ───────────────────────────────────────────────────────

/**
 * Fetch and validate LNURL-pay metadata (LUD-06 payRequest) for a Lightning
 * Address.
 *
 * @param {string} username
 * @param {string} domain
 * @param {object} [opts]
 * @returns {Promise<{ callback: string, minSendable: number, maxSendable: number, metadata: string, commentAllowed: number }>}
 *          minSendable/maxSendable are in millisats.
 */
async function fetchLnurlPayMetadata(username, domain, opts = {}) {
  const url = lnurlpMetadataUrl(username, domain);
  const res = await fetchWithRetry(url, opts);

  if (res.status === 404) {
    const e = new Error(`Lightning Address not found: ${username}@${domain}`);
    e.code = 'LNURL_NOT_FOUND';
    throw e;
  }
  if (!res.ok) {
    throw new Error(`LNURL-pay metadata request failed: HTTP ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('LNURL-pay metadata was not valid JSON.');
  }

  // LNURL error object (LUD-06): { status: "ERROR", reason }
  if (body.status === 'ERROR') {
    const e = new Error(`LNURL-pay error: ${body.reason || 'unknown reason'}`);
    e.code = 'LNURL_NOT_FOUND';
    throw e;
  }

  if (body.tag !== 'payRequest' || !body.callback) {
    throw new Error('Not a valid LNURL-pay (payRequest) response.');
  }

  return {
    callback: body.callback,
    minSendable: Number(body.minSendable) || 0,
    maxSendable: Number(body.maxSendable) || 0,
    metadata: body.metadata || '',
    commentAllowed: Number(body.commentAllowed) || 0,
  };
}

// ── Invoice request from callback (LUD-21 verify capture) ─────────────────────

/**
 * Request a BOLT-11 invoice from an LNURL-pay callback.
 *
 * Captures the LUD-21 `verify` URL when the server provides one — this is how
 * settlement is detected for non-custodial (Spark) recipients, where there is
 * no Blink GraphQL subscription to watch.
 *
 * @param {string} callback     Callback URL from the payRequest metadata.
 * @param {number} amountMsats  Amount in millisatoshis.
 * @param {string} [comment]    Optional comment (if commentAllowed > 0).
 * @param {object} [opts]
 * @returns {Promise<{ paymentRequest: string, verify: string|null, routes: any[] }>}
 */
async function requestInvoiceFromCallback(callback, amountMsats, comment, opts = {}) {
  const url = new URL(callback);
  url.searchParams.set('amount', String(amountMsats));
  if (comment) url.searchParams.set('comment', comment);

  const res = await fetchWithRetry(url.toString(), opts);
  if (!res.ok) {
    throw new Error(`LNURL-pay callback failed: HTTP ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('LNURL-pay callback did not return valid JSON.');
  }

  if (body.status === 'ERROR') {
    throw new Error(`LNURL-pay callback error: ${body.reason || 'unknown reason'}`);
  }
  if (!body.pr) {
    throw new Error('LNURL-pay callback did not return an invoice (pr).');
  }

  return {
    paymentRequest: body.pr,
    verify: body.verify || null, // LUD-21
    routes: body.routes || [],
  };
}

// ── High-level: address -> invoice ───────────────────────────────────────────

/**
 * Resolve a Lightning Address to a BOLT-11 invoice for a given sat amount.
 *
 * @param {string} address      Lightning Address (`user@domain`).
 * @param {number} amountSats   Amount in satoshis.
 * @param {string} [memo]       Optional comment (used if the server allows it).
 * @param {object} [opts]
 * @param {string} [opts.defaultDomain]  Domain to use when a bare username is given.
 * @returns {Promise<{ paymentRequest: string, verify: string|null, lightningAddress: string, amountSats: number }>}
 */
async function getInvoiceFromLightningAddress(address, amountSats, memo, opts = {}) {
  const parsed = parseLightningAddress(address);
  const domain = parsed.domain || opts.defaultDomain;
  if (!domain) throw new Error('No domain: supply a full user@domain address or a defaultDomain option.');

  const lightningAddress = `${parsed.username}@${domain}`;
  const meta = await fetchLnurlPayMetadata(parsed.username, domain, opts);

  const amountMsats = amountSats * 1000;
  if (meta.minSendable && amountMsats < meta.minSendable) {
    const e = new Error(`Amount ${amountSats} sats is below the minimum (${Math.ceil(meta.minSendable / 1000)} sats).`);
    e.code = 'AMOUNT_TOO_LOW';
    throw e;
  }
  if (meta.maxSendable && amountMsats > meta.maxSendable) {
    const e = new Error(`Amount ${amountSats} sats exceeds the maximum (${Math.floor(meta.maxSendable / 1000)} sats).`);
    e.code = 'AMOUNT_TOO_HIGH';
    throw e;
  }

  const comment = memo && meta.commentAllowed > 0 ? String(memo).slice(0, meta.commentAllowed) : undefined;
  const invoice = await requestInvoiceFromCallback(meta.callback, amountMsats, comment, opts);

  return {
    paymentRequest: invoice.paymentRequest,
    verify: invoice.verify,
    lightningAddress,
    amountSats,
  };
}

// ── LUD-21 verify (settlement detection) ─────────────────────────────────────

/**
 * Poll a LUD-21 `verify` URL once to check whether the invoice has settled.
 *
 * NOTE (Spark timing caveat): for non-custodial (Spark) recipients, the
 * `settled` flag is populated server-side by the Spark SSP webhook, so
 * detection can lag the actual payment by a few seconds. Callers should poll.
 *
 * @param {string} verifyUrl
 * @param {object} [opts]
 * @returns {Promise<{ settled: boolean, preimage: string|null, pr: string|null }>}
 */
async function verifyLnurlPayment(verifyUrl, opts = {}) {
  const res = await fetchWithRetry(verifyUrl, opts);
  if (!res.ok) {
    throw new Error(`LUD-21 verify failed: HTTP ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('LUD-21 verify did not return valid JSON.');
  }
  if (body.status === 'ERROR') {
    throw new Error(`LUD-21 verify error: ${body.reason || 'unknown reason'}`);
  }
  return {
    settled: body.settled === true,
    preimage: body.preimage || null,
    pr: body.pr || null,
  };
}

module.exports = {
  DEFAULT_LNURL_TIMEOUT_MS,
  parseLightningAddress,
  lnurlpMetadataUrl,
  fetchWithRetry,
  fetchLnurlPayMetadata,
  requestInvoiceFromCallback,
  getInvoiceFromLightningAddress,
  verifyLnurlPayment,
};
