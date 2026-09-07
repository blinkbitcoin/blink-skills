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
const MAX_REDIRECTS = 3;

// ── URL trust boundary (SSRF guard) ──────────────────────────────────────────
//
// LNURL is a protocol in which a remote server hands us MORE URLs to fetch: the
// payRequest `callback`, the LUD-21 `verify` URL, and any HTTP redirect along
// the way. Validating only the first URL we construct is therefore not enough —
// a single compromised or hostile response can redirect the client at an
// internal address. Every hop has to be re-checked against the same allowlist,
// which is why `assertAllowedUrl` is applied inside `fetchWithRetry` (the one
// place all requests funnel through) rather than at the call sites.

// Hosts that may be reached over plain http. Exact match only: a prefix test
// would accept `localhost.attacker.example`.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Is this hostname a literal IP address in a private / loopback / link-local
 * range? Defence in depth behind the host allowlist: if an allowed host ever
 * resolves to, or redirects at, a raw internal address, refuse it.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateAddress(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (host === '::' || host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local

  // IPv4-mapped IPv6. `new URL()` re-serialises `::ffff:169.254.169.254` into
  // the hex form `::ffff:a9fe:a9fe`, so matching only the dotted spelling would
  // never fire on anything the guard actually receives.
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateAddress([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'));
  }
  if (/^::ffff:/.test(host)) return isPrivateAddress(host.replace(/^::ffff:/, ''));
  return false;
}

/**
 * Validate that a URL may be fetched, and return it parsed.
 *
 * Enforces, in order: parseable, http(s) only, host on the allowlist, HTTPS
 * unless the host is genuinely local, and not a private-range IP literal.
 *
 * @param {string} rawUrl
 * @param {Set<string>|string[]|null} allowedHosts  Null disables the host
 *        allowlist (scheme and private-address checks still apply).
 * @param {string} [what]  Label for the error message, e.g. "callback URL".
 * @returns {URL}
 */
function assertAllowedUrl(rawUrl, allowedHosts, what = 'URL') {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error(`Refusing to fetch an unparseable ${what}: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Refusing to fetch ${what} with unsupported scheme '${url.protocol}'.`);
  }

  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host);

  // Being a local host is NOT itself a licence to be fetched. Treating it as
  // one would let a hostile LNURL response name `http://127.0.0.1:6379/` (or
  // `http://2130706433/`, which WHATWG normalises to the same thing) and reach
  // services on the loopback interface. The only thing that permits a host is
  // appearing in the caller's allowlist; `isLocal` merely relaxes the HTTPS
  // requirement for a host that was allowed anyway.
  const allowed = allowedHosts ? (allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts)) : null;
  const explicitlyAllowed = allowed ? allowed.has(host) : false;

  if (allowed && !explicitlyAllowed) {
    throw new Error(`Refusing to fetch ${what} from non-Blink host '${host}'. Allowed: ${[...allowed].join(', ')}.`);
  }

  // Plaintext is tolerable only for a local host the caller deliberately
  // permitted (regtest / dev), never for one merely reached via a redirect.
  if (url.protocol === 'http:' && !(isLocal && (explicitlyAllowed || !allowed))) {
    throw new Error(`Refusing to fetch ${what} over plaintext http from '${host}'; https is required.`);
  }

  // Applies even with the allowlist disabled: opting out of the host allowlist
  // is not opting in to internal network access.
  if (isPrivateAddress(host) && !explicitlyAllowed) {
    throw new Error(`Refusing to fetch ${what} from private address '${host}'.`);
  }

  // A non-standard port on an allowed host is still a different service. The
  // allowlist names hosts, so anything but the default port is refused unless
  // the caller listed `host:port` explicitly.
  if (allowed && url.port && !allowed.has(`${host}:${url.port}`)) {
    throw new Error(`Refusing to fetch ${what} on non-standard port ${url.port} of '${host}'.`);
  }

  return url;
}

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
  // Exact host match, not a prefix test: `startsWith('localhost')` would also
  // match `localhost.attacker.example` and downgrade it to plaintext http.
  const hostOnly = String(domain).toLowerCase().split(':')[0];
  const scheme = LOCAL_HOSTS.has(hostOnly) ? 'http' : 'https';
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
 * Redirects are followed MANUALLY so that every hop is re-validated against the
 * allowlist. `redirect: 'follow'` would let a 302 from an allowed host silently
 * pull us to an arbitrary one.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {object} [opts.headers]
 * @param {Set<string>|string[]|null} [opts.allowedHosts]  Host allowlist applied
 *        to the initial URL and to every redirect target.
 * @param {string} [opts.what]  Label used in guard error messages.
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(
  url,
  {
    timeoutMs = DEFAULT_LNURL_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    headers = {},
    allowedHosts = null,
    what = 'URL',
  } = {},
) {
  // Guard failures are deterministic policy decisions, not transient network
  // faults, so they must escape the retry loop instead of being swallowed.
  let current = assertAllowedUrl(url, allowedHosts, what);

  // One budget for the whole logical request. `timeoutMs` alone is per-attempt
  // and `retries` resets on every redirect, so without this a slow but
  // allowlisted host could spend (MAX_REDIRECTS+1) x (retries+1) timeouts —
  // about two minutes — on what the caller asked to bound at ten seconds.
  const overallDeadline = Date.now() + timeoutMs * (retries + 1) * (MAX_REDIRECTS + 1);

  for (let hop = 0; ; hop++) {
    let lastErr;
    let res = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const remaining = overallDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`LNURL request exceeded its overall deadline fetching ${what}.`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      try {
        res = await fetch(current.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          headers: { Accept: 'application/json', Connection: 'close', ...headers },
        });
        break;
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

    if (!res) {
      throw new Error(
        `LNURL request failed after ${retries + 1} attempt(s): ${lastErr ? lastErr.message : 'unknown error'}`,
      );
    }

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect) return res;

    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${what}.`);
    }
    // Resolve relative Location headers against the current hop, then re-check.
    const next = new URL(res.headers.get('location'), current).toString();
    current = assertAllowedUrl(next, allowedHosts, `${what} redirect target`);
  }
}

// ── BOLT-11 binding ──────────────────────────────────────────────────────────
//
// The callback hands back a `pr` string that we then show the user, or hand to
// a wallet, as "the invoice for N sats". Nothing in LNURL forces that invoice
// to actually encode N sats, or even to be on the network we think it is. A
// server that returns an invoice for a different amount, or a mainnet client
// handed a testnet invoice, is a silent failure. We do not need a full BOLT-11
// decoder to close that: the human-readable prefix carries both facts.

// `lnbc<amount><multiplier>` — the multiplier is a fraction of 1 BTC.
// 1 BTC = 100_000_000 sat = 100_000_000_000 msat.
const BOLT11_MULTIPLIERS = {
  m: 100_000_000, // milli  1e-3 BTC
  u: 100_000, // micro  1e-6 BTC
  n: 100, // nano   1e-9 BTC
  p: 0.1, // pico   1e-12 BTC
};

const BOLT11_NETWORK_PREFIXES = {
  bc: 'mainnet',
  tb: 'testnet',
  bcrt: 'regtest',
  sb: 'signet',
};

/**
 * Decode the human-readable part of a BOLT-11 invoice.
 *
 * Deliberately does NOT verify the bech32 checksum or parse the tagged data —
 * that would be a dependency. It extracts only what is needed to bind the
 * invoice to the request that produced it.
 *
 * @param {string} paymentRequest
 * @returns {{ network: string, amountMsats: number|null }}
 *          amountMsats is null for an amountless ("any amount") invoice.
 */
function decodeBolt11Hrp(paymentRequest) {
  const pr = String(paymentRequest || '')
    .trim()
    .toLowerCase();
  if (!pr) throw new Error('Empty payment request.');

  // bech32: the HRP is everything before the LAST '1' separator.
  const sep = pr.lastIndexOf('1');
  if (sep < 1) throw new Error('Not a valid BOLT-11 invoice (no bech32 separator).');
  const hrp = pr.slice(0, sep);
  const data = pr.slice(sep + 1);

  if (!/^[023456789acdefghjklmnpqrstuvwxyz]+$/.test(data) || data.length < 6) {
    throw new Error('Not a valid BOLT-11 invoice (bad bech32 data part).');
  }

  const m = hrp.match(/^ln(bcrt|bc|tb|sb)(\d*)([munp]?)$/);
  if (!m) throw new Error(`Not a valid BOLT-11 invoice (unrecognised prefix '${hrp}').`);

  const [, prefix, digits, multiplier] = m;
  const network = BOLT11_NETWORK_PREFIXES[prefix];

  if (!digits) return { network, amountMsats: null }; // amountless invoice

  const value = Number(digits);
  if (!Number.isFinite(value)) throw new Error('Not a valid BOLT-11 invoice (bad amount).');

  const amountMsats = multiplier ? value * BOLT11_MULTIPLIERS[multiplier] : value * 100_000_000_000;
  if (!Number.isInteger(amountMsats)) {
    throw new Error('Not a valid BOLT-11 invoice (sub-millisatoshi amount).');
  }
  return { network, amountMsats };
}

/**
 * Assert that a returned invoice is the one we asked for.
 *
 * @param {string} paymentRequest
 * @param {object} expected
 * @param {number} expected.amountMsats
 * @param {string} [expected.network]  Default "mainnet".
 * @returns {{ network: string, amountMsats: number|null }}
 */
function assertInvoiceMatches(paymentRequest, { amountMsats, network = 'mainnet' }) {
  let decoded;
  try {
    decoded = decodeBolt11Hrp(paymentRequest);
  } catch (err) {
    throw new Error(`LNURL-pay callback returned something that is not a BOLT-11 invoice: ${err.message}`);
  }

  if (decoded.network !== network) {
    throw new Error(
      `LNURL-pay callback returned a ${decoded.network} invoice, but ${network} was requested. Refusing it.`,
    );
  }

  // An amountless invoice would let the payer be charged an arbitrary sum.
  if (decoded.amountMsats === null) {
    throw new Error('LNURL-pay callback returned an amountless invoice; refusing it.');
  }

  if (decoded.amountMsats !== amountMsats) {
    throw new Error(
      `LNURL-pay callback returned an invoice for ${decoded.amountMsats} msats, ` +
        `but ${amountMsats} msats was requested. Refusing it.`,
    );
  }

  return decoded;
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
  const res = await fetchWithRetry(url, { ...opts, what: 'LNURL-pay metadata URL' });

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

  // The callback is a server-supplied URL we are about to fetch. Check it here,
  // at the point of trust transfer, so a bad callback is rejected with a clear
  // message rather than surfacing later as an opaque fetch guard error.
  assertAllowedUrl(body.callback, opts.allowedHosts || null, 'LNURL-pay callback URL');

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
 * @param {Set<string>|string[]} [opts.allowedHosts]
 * @param {string} [opts.network]  Expected invoice network (default "mainnet").
 * @returns {Promise<{ paymentRequest: string, verify: string|null, routes: any[] }>}
 */
async function requestInvoiceFromCallback(callback, amountMsats, comment, opts = {}) {
  const url = assertAllowedUrl(callback, opts.allowedHosts || null, 'LNURL-pay callback URL');
  url.searchParams.set('amount', String(amountMsats));
  if (comment) url.searchParams.set('comment', comment);

  const res = await fetchWithRetry(url.toString(), { ...opts, what: 'LNURL-pay callback URL' });
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

  // Bind the response to the request: right network, exactly the amount asked
  // for. Done BEFORE the invoice is returned to any caller, so an invoice that
  // does not match is never emitted or displayed.
  assertInvoiceMatches(body.pr, { amountMsats, network: opts.network || 'mainnet' });

  // LUD-21 verify is another URL we will fetch; hold it to the same allowlist.
  if (body.verify) {
    assertAllowedUrl(body.verify, opts.allowedHosts || null, 'LUD-21 verify URL');
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
 * @param {Set<string>|string[]} [opts.allowedHosts]  Host allowlist. Callers that
 *        receive a user-supplied address MUST pass this; see resolveReceiver.
 * @param {string} [opts.network]  Expected invoice network (default "mainnet").
 * @returns {Promise<{ paymentRequest: string, verify: string|null, lightningAddress: string, amountSats: number }>}
 */
async function getInvoiceFromLightningAddress(address, amountSats, memo, opts = {}) {
  const parsed = parseLightningAddress(address);
  const domain = parsed.domain || opts.defaultDomain;
  if (!domain) throw new Error('No domain: supply a full user@domain address or a defaultDomain option.');

  // Check the address domain up front, before any network call. The per-hop
  // guard inside fetchWithRetry would catch it anyway, but failing here gives
  // the caller an error naming the address rather than a derived URL.
  if (opts.allowedHosts) {
    assertAllowedUrl(`https://${domain}`, opts.allowedHosts, `Lightning Address domain for '${address}'`);
  }

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
 * @param {Set<string>|string[]} [opts.allowedHosts]
 * @param {string} [opts.expectedPr]  The invoice this verify URL belongs to. When
 *        supplied, a `settled: true` whose `pr` names a DIFFERENT invoice is
 *        rejected instead of being reported as settlement.
 * @returns {Promise<{ settled: boolean, preimage: string|null, pr: string|null }>}
 */
async function verifyLnurlPayment(verifyUrl, opts = {}) {
  const res = await fetchWithRetry(verifyUrl, { ...opts, what: 'LUD-21 verify URL' });
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

  const settled = body.settled === true;
  const pr = body.pr || null;

  // Bind settlement to the specific invoice being polled. Without this, a
  // `settled: true` for some other payment reads as "your invoice was paid".
  // A verify response that omits `pr` while claiming settlement cannot be
  // bound at all, so it is not accepted either.
  if (settled && opts.expectedPr) {
    if (!pr) {
      throw new Error('LUD-21 verify reported settled but returned no `pr` to bind it to the invoice.');
    }
    if (String(pr).toLowerCase() !== String(opts.expectedPr).toLowerCase()) {
      throw new Error('LUD-21 verify reported settled for a DIFFERENT invoice than the one being polled.');
    }
  }

  return { settled, preimage: body.preimage || null, pr };
}

module.exports = {
  DEFAULT_LNURL_TIMEOUT_MS,
  MAX_REDIRECTS,
  LOCAL_HOSTS,
  isPrivateAddress,
  assertAllowedUrl,
  decodeBolt11Hrp,
  assertInvoiceMatches,
  parseLightningAddress,
  lnurlpMetadataUrl,
  fetchWithRetry,
  fetchLnurlPayMetadata,
  requestInvoiceFromCallback,
  getInvoiceFromLightningAddress,
  verifyLnurlPayment,
};
