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
    retryOn404 = false,
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
        // A 404 is the LUD-16 "not found" signal, but it is ALSO what a
        // transient proxy/CDN/WAF returns in front of a healthy LNURL server
        // (rolling deploy, stale negative cache). Retry it like any other
        // transient fault and only let a CONSISTENT 404 through to be read as
        // not-found, so one flaky response is not relayed as "this address
        // does not exist".
        if (retryOn404 && res.status === 404 && attempt < retries) {
          lastErr = new Error('HTTP 404 (transient?)');
          res = null;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
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
// to actually encode N sats, to be on the network we think it is, or to be the
// invoice that corresponds to the metadata we fetched. Three independent checks
// are needed, and none is optional:
//
//   1. bech32 checksum — otherwise a corrupted or fabricated `pr` string is
//      accepted as an invoice at all.
//   2. network + amount from the HRP — a testnet invoice, or one for the wrong
//      amount, is a silent failure.
//   3. the description-hash `h` tag must equal SHA-256 of the exact LUD-06
//      metadata string — otherwise the invoice is not bound to the payRequest
//      that produced it, and a server could return a pre-signed invoice for a
//      different description than the one the user saw.
//
// All of this is pure parsing over a ~30-line bech32 core; it needs no
// dependency. `bip39` provides no bech32 export, and pulling in `bolt11` for
// this would be a new dependency for a well-specified decode.

// ── bech32 (BIP-173; BOLT-11 uses bech32, not bech32m) ───────────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1; // bech32; bech32m would be 0x2bc830a3

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/**
 * Decode and verify a bech32/bech32m string.
 * @param {string} str
 * @returns {{ hrp: string, data: number[] }} data without the 6 checksum words.
 */
function bech32Decode(str) {
  // BOLT-11 legitimately exceeds BIP-173's 90-char limit: a long `d` tag plus
  // route hints can run to several thousand chars. Cap only to bound work.
  if (str.length < 8 || str.length > 20000) throw new Error('bech32: bad length');
  if (/[\x00-\x20\x7f-\xff]/.test(str)) throw new Error('bech32: invalid character range');
  if (str.toLowerCase() !== str && str.toUpperCase() !== str) {
    throw new Error('bech32: mixed case');
  }
  const s = str.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) throw new Error('bech32: no valid separator');

  const hrp = s.slice(0, sep);
  const dataPart = s.slice(sep + 1);
  const data = [];
  for (const c of dataPart) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) throw new Error(`bech32: invalid data character '${c}'`);
    data.push(v);
  }

  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  if (polymod !== BECH32_CONST) throw new Error('bech32: checksum mismatch');
  return { hrp, data: data.slice(0, -6) };
}

/** Convert between bit groups (here 5-bit words -> 8-bit bytes). */
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) throw new Error('convertBits: value out of range');
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error('convertBits: invalid padding');
  }
  return out;
}

// ── BOLT-11 structure ────────────────────────────────────────────────────────

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

// BOLT-11 tag type constants (from the spec).
const TAG_PAYMENT_HASH = 1; // p — 256-bit SHA-256 payment hash (52 words)
const TAG_EXPIRY = 6; // x — expiry in seconds (variable length)
const TAG_DESCRIPTION = 13; // d — free-form description
const TAG_PAYMENT_SECRET = 16; // s — 256-bit payment secret (52 words)
const TAG_DESCRIPTION_HASH = 23; // h — 256-bit description hash (52 words)

const BOLT11_DEFAULT_EXPIRY_SECONDS = 3600; // per BOLT-11 when no `x` tag

/**
 * Decode a BOLT-11 invoice: verify the bech32 checksum, read the HRP
 * (network + amount) and parse the tagged fields — payment hash, description /
 * description-hash, expiry, and the timestamp.
 *
 * SCOPE BOUNDARY: this validates STRUCTURE and binds the invoice to our
 * request (network, amount, description). It does NOT verify the secp256k1
 * signature. The signature attests the invoice was signed by the payee node;
 * it does not establish that the invoice matches the request we made — which is
 * the property we are checking here. The signature is verified downstream by
 * the paying wallet before it signs the HTLC, so an unsigned or badly-signed
 * invoice is unpayable but cannot redirect funds. Verifying it here would pull
 * a secp256k1 dependency into a receive-only path for an availability (not
 * fund-loss) property. The signature's PRESENCE and SHAPE (104 words) are still
 * required, so a string with no signature region is rejected as malformed.
 *
 * @param {string} paymentRequest
 * @param {object} [opts]
 * @param {number} [opts.nowSeconds]  Current time for the expiry check
 *        (injectable for testing; default Date.now()/1000).
 * @returns {{ network: string, amountMsats: number|null, descriptionHash: string|null,
 *             paymentHash: string, timestampSeconds: number, expirySeconds: number }}
 */
function decodeBolt11(paymentRequest, opts = {}) {
  const nowSeconds = opts.nowSeconds !== undefined ? opts.nowSeconds : Math.floor(Date.now() / 1000);

  const pr = String(paymentRequest || '').trim();
  if (!pr) throw new Error('Empty payment request.');

  let decoded;
  try {
    decoded = bech32Decode(pr);
  } catch (err) {
    throw new Error(`Not a valid BOLT-11 invoice (${err.message}).`);
  }
  const { hrp, data } = decoded;

  const m = hrp.match(/^ln(bcrt|bc|tb|sb)(\d*)([munp]?)$/);
  if (!m) throw new Error(`Not a valid BOLT-11 invoice (unrecognised prefix '${hrp}').`);
  const [, prefix, digits, multiplier] = m;
  const network = BOLT11_NETWORK_PREFIXES[prefix];

  // Amount (from the HRP).
  let amountMsats = null;
  if (digits) {
    const value = Number(digits);
    if (!Number.isFinite(value)) throw new Error('Not a valid BOLT-11 invoice (bad amount).');
    amountMsats = multiplier ? value * BOLT11_MULTIPLIERS[multiplier] : value * 100_000_000_000;
    if (!Number.isInteger(amountMsats)) {
      throw new Error('Not a valid BOLT-11 invoice (sub-millisatoshi amount).');
    }
  }

  // Tagged fields. The data part is: 35-bit timestamp (7 words) + tags + 520-bit
  // signature (104 words). Each tag is: 5-bit type, 10-bit length (2 words),
  // then `length` 5-bit words of data.
  const sigWords = 104;
  if (data.length < 7 + sigWords) {
    throw new Error('Not a valid BOLT-11 invoice (too short for timestamp + signature).');
  }

  // Timestamp: leading 7 words, big-endian 35 bits.
  let timestampSeconds = 0;
  for (let w = 0; w < 7; w++) {
    timestampSeconds = timestampSeconds * 32 + data[w];
  }
  if (timestampSeconds === 0) {
    throw new Error('Not a valid BOLT-11 invoice (zero timestamp).');
  }

  let paymentHash = null;
  let descriptionHash = null;
  let paymentSecret = null;
  let hasDescription = false;
  let expirySeconds = BOLT11_DEFAULT_EXPIRY_SECONDS;
  // BOLT-11 forbids repeated tag types outright. Track sightedness per tag so a
  // duplicate is a hard failure regardless of whether its body parsed — a
  // malformed first `h` body must not let a second `h` slip in uncounted.
  const seen = new Set();

  let i = 7;
  while (i + 3 <= data.length - sigWords) {
    const type = data[i];
    const len = (data[i + 1] << 5) | data[i + 2];
    const start = i + 3;
    if (start + len > data.length - sigWords) break; // malformed; stop scanning

    const isKnownUnique =
      type === TAG_PAYMENT_HASH ||
      type === TAG_DESCRIPTION_HASH ||
      type === TAG_DESCRIPTION ||
      type === TAG_EXPIRY ||
      type === TAG_PAYMENT_SECRET;
    if (isKnownUnique) {
      if (seen.has(type)) {
        throw new Error(`Not a valid BOLT-11 invoice (duplicate tag type ${type}).`);
      }
      seen.add(type);
    }

    if (type === TAG_PAYMENT_HASH) {
      // `p` — payment hash. Exactly 52 words (32 bytes as 5-bit groups).
      try {
        const bytes = convertBits(data.slice(start, start + len), 5, 8, false);
        if (bytes.length === 32) paymentHash = Buffer.from(bytes).toString('hex');
      } catch {
        // malformed body: leave null, the required-tag check below rejects it
      }
    } else if (type === TAG_PAYMENT_SECRET) {
      // `s` — payment secret (prevents probing by forwarding nodes). Exactly 52
      // words / 32 bytes. A malformed body leaves it null; the required-tag
      // check below then rejects it, fail-closed.
      try {
        const bytes = convertBits(data.slice(start, start + len), 5, 8, false);
        if (bytes.length === 32) paymentSecret = Buffer.from(bytes).toString('hex');
      } catch {
        // malformed tag body: leave paymentSecret null
      }
    } else if (type === TAG_DESCRIPTION_HASH) {
      // `h` — description hash. A malformed body leaves the hash null; the
      // binding check then refuses it, fail-closed.
      try {
        const bytes = convertBits(data.slice(start, start + len), 5, 8, false);
        if (bytes.length === 32) descriptionHash = Buffer.from(bytes).toString('hex');
      } catch {
        // malformed tag body: leave descriptionHash null
      }
    } else if (type === TAG_DESCRIPTION) {
      hasDescription = true;
    } else if (type === TAG_EXPIRY) {
      // `x` — expiry seconds, big-endian 5-bit words.
      let v = 0;
      for (let k = start; k < start + len; k++) v = v * 32 + data[k];
      expirySeconds = v;
    }
    i = start + len;
  }

  // A well-formed invoice's tags end exactly where the signature begins. A gap
  // means garbage words between them, which is malformed structure.
  if (i !== data.length - sigWords) {
    throw new Error('Not a valid BOLT-11 invoice (trailing garbage before the signature).');
  }

  // The signature region: 104 words = 520 bits = 65 bytes = 64-byte compact
  // signature + 1-byte recovery id. The recovery id MUST be in {0,1,2,3}; an
  // out-of-range value is a structurally invalid signature a compliant payer
  // must reject.
  const sigBytes = convertBits(data.slice(data.length - sigWords), 5, 8, false);
  if (sigBytes.length !== 65) {
    throw new Error('Not a valid BOLT-11 invoice (signature region is not 65 bytes).');
  }
  const recoveryId = sigBytes[64];
  if (recoveryId < 0 || recoveryId > 3) {
    throw new Error(`Not a valid BOLT-11 invoice (signature recovery id ${recoveryId} out of range 0-3).`);
  }

  // Required structure. A payment hash is mandatory: without it the invoice is
  // unpayable and there is nothing to verify a payment against. Exactly one
  // description form must be present — not both (a `d`+`h` pair is a protocol
  // violation that lets two descriptions coexist), not neither.
  if (paymentHash === null) {
    throw new Error('Not a valid BOLT-11 invoice (missing payment-hash tag).');
  }
  // A payment secret is mandatory under current BOLT #11: without it a
  // compliant payer cannot safely route without exposing the recipient.
  if (paymentSecret === null) {
    throw new Error('Not a valid BOLT-11 invoice (missing payment-secret tag).');
  }
  if (hasDescription && descriptionHash !== null) {
    throw new Error('Not a valid BOLT-11 invoice (both d and h description tags present).');
  }
  if (!hasDescription && descriptionHash === null) {
    throw new Error('Not a valid BOLT-11 invoice (no description or description-hash tag).');
  }

  // Expiry: an already-expired invoice is unpayable and must not be emitted.
  if (timestampSeconds + expirySeconds <= nowSeconds) {
    throw new Error('Not a valid BOLT-11 invoice (invoice has expired).');
  }

  return {
    network,
    amountMsats,
    descriptionHash,
    paymentHash,
    paymentSecret,
    timestampSeconds,
    expirySeconds,
    recoveryId,
  };
}

/**
 * Assert that a returned invoice is the one we asked for: valid bech32, right
 * network, exactly the amount requested, and — when the LUD-06 metadata is
 * supplied — a description hash bound to that metadata.
 *
 * @param {string} paymentRequest
 * @param {object} expected
 * @param {number} expected.amountMsats
 * @param {string} [expected.network]   Default "mainnet".
 * @param {string} [expected.metadata]  The exact LUD-06 metadata string. When
 *        given, the invoice's `h` tag must equal sha256(metadata).
 * @param {number} [expected.nowSeconds]  Current time for the expiry check.
 * @returns {{ network: string, amountMsats: number|null, descriptionHash: string|null }}
 */
function assertInvoiceMatches(paymentRequest, { amountMsats, network = 'mainnet', metadata, nowSeconds } = {}) {
  let decoded;
  try {
    decoded = decodeBolt11(paymentRequest, { nowSeconds });
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

  // Bind the invoice to the payRequest metadata (LUD-06). Without this the
  // invoice is valid and correctly-priced, but not provably for the
  // description the user agreed to.
  if (metadata !== undefined && metadata !== null) {
    const crypto = require('crypto');
    const expectedHash = crypto.createHash('sha256').update(String(metadata), 'utf8').digest('hex');
    if (decoded.descriptionHash === null) {
      throw new Error('LNURL-pay callback returned an invoice with no description-hash tag to bind.');
    }
    if (decoded.descriptionHash !== expectedHash) {
      throw new Error(
        'LNURL-pay callback returned an invoice whose description hash does not match the ' +
          'LUD-06 metadata. Refusing it.',
      );
    }
  }

  return decoded;
}

// ── LNURL error classification ───────────────────────────────────────────────
//
// A LUD-06 error body `{ status: "ERROR", reason }` is NOT automatically "this
// address does not exist". The only reason that means absence is an explicit
// not-found; anything else — "temporarily overloaded", a rate limit, a
// malformed amount — is a SERVICE failure that the caller should retry, not
// convert into a confident RECEIVER_NOT_FOUND. That conversion is the
// outage-as-identity-answer bug, one layer below the now-fixed GraphQL probe.
// Structured codes are preferred over prose when the server supplies them.
// Receiver-SPECIFIC codes name the absent resource and are honoured
// unconditionally. A bare NOT_FOUND says nothing about WHICH resource, so it
// only counts alongside receiver-anchored prose — otherwise a generic
// NOT_FOUND would override contradictory transient wording.
const LNURL_NOT_FOUND_SPECIFIC_CODES = new Set([
  'USER_NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
  'ADDRESS_NOT_FOUND',
  'USERNAME_NOT_FOUND',
]);

// Message patterns are a FALLBACK, and every one is anchored to the receiver
// noun. An unrestricted /not found/ would match "upstream route not found",
// "backend service not found", and "invoice not found" — all of which describe
// infrastructure or a payment, not the receiver, and all of which would then be
// misreported as "this address does not exist" (the outage-as-identity bug).
const LNURL_NOT_FOUND_PATTERNS = [
  /(user|account|username|address|identifier)\s+(was\s+)?not\s+found/i,
  /no\s+(such\s+)?(user|account|username|address)/i,
  /(user|account|username|address|identifier)\s+does\s+not\s+exist/i,
  /unknown\s+(user|account|username|address|identifier)/i,
  // The exact production Blink response for a nonexistent address is verb-first:
  // {"reason":"Couldn't find user 'x'."}. Anchored to the receiver noun so it
  // cannot match an infrastructure "couldn't find <route|resource>" error. The
  // `address` noun is ambiguous (it also names network infrastructure), so for
  // it alone we require the quoted-subject form Blink actually emits.
  /(couldn'?t|could\s+not|cannot)\s+find\s+(the\s+)?(user|account|username|identifier)/i,
  /(couldn'?t|could\s+not|cannot)\s+find\s+(the\s+)?address\s+'/i,
];

/**
 * Is this LUD-06 error an unambiguous "the receiver address does not exist"?
 *
 * @param {string} reason    The LUD-06 `reason` string.
 * @param {string} [code]    An optional structured error code, when supplied.
 * @returns {boolean}
 */
function isLnurlNotFoundReason(reason, code) {
  const prose = LNURL_NOT_FOUND_PATTERNS.some((re) => re.test(String(reason || '')));
  // Receiver-SPECIFIC codes are unconditional; a generic NOT_FOUND and an absent
  // code both fall back to the receiver-anchored prose.
  if (code && LNURL_NOT_FOUND_SPECIFIC_CODES.has(String(code).toUpperCase())) return true;
  return prose;
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
  // 404 is the LUD-16 not-found signal, but a transient infra 404 is
  // indistinguishable from it — retry so only a consistent 404 is read as
  // "this address does not exist".
  const res = await fetchWithRetry(url, { ...opts, what: 'LNURL-pay metadata URL', retryOn404: true });

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

  // LNURL error object (LUD-06): { status: "ERROR", reason }. Only an
  // unambiguous not-found reason is absence; anything else is a service
  // failure and must NOT be read as "this receiver does not exist".
  if (body.status === 'ERROR') {
    const reason = body.reason || 'unknown reason';
    const e = new Error(`LNURL-pay error: ${reason}`);
    e.code = isLnurlNotFoundReason(reason, body.code) ? 'LNURL_NOT_FOUND' : 'LNURL_SERVICE_ERROR';
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
 * @param {string} [opts.metadata]  The exact LUD-06 metadata string from the
 *        payRequest. When supplied, the returned invoice's description-hash tag
 *        must match sha256(metadata).
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

  // Bind the response to the request: valid bech32, right network, exactly the
  // amount asked for, and a description hash matching the LUD-06 metadata we
  // fetched. Done BEFORE the invoice is returned to any caller, so an invoice
  // that does not match is never emitted or displayed.
  assertInvoiceMatches(body.pr, {
    amountMsats,
    network: opts.network || 'mainnet',
    metadata: opts.metadata,
  });

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
 * @param {Set<string>|string[]} [opts.allowedHosts]  Allowlist for SERVER-SUPPLIED
 *        URLs (callback, verify, redirects). Must include Blink's LNURL service
 *        host, which differs from the address domain; see ALLOWED_LNURL_SERVICE_HOSTS.
 * @param {Set<string>|string[]} [opts.allowedAddressDomains]  Narrower allowlist
 *        for the user-supplied address domain itself (the SSRF surface). Falls
 *        back to `allowedHosts` when not given.
 * @param {string} [opts.network]  Expected invoice network (default "mainnet").
 * @returns {Promise<{ paymentRequest: string, verify: string|null, lightningAddress: string, amountSats: number }>}
 */
async function getInvoiceFromLightningAddress(address, amountSats, memo, opts = {}) {
  const parsed = parseLightningAddress(address);
  const domain = parsed.domain || opts.defaultDomain;
  if (!domain) throw new Error('No domain: supply a full user@domain address or a defaultDomain option.');

  // Check the ADDRESS domain up front against the narrow set, before any
  // network call. This is the SSRF surface: a user-controlled string becoming
  // an outbound request. The wider service-host allowlist is applied to the
  // server-supplied callback/verify/redirect URLs downstream.
  const addressDomains = opts.allowedAddressDomains || opts.allowedHosts;
  if (addressDomains) {
    assertAllowedUrl(`https://${domain}`, addressDomains, `Lightning Address domain for '${address}'`);
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
  // Pass the metadata through so the returned invoice's description-hash is
  // bound to this exact payRequest, per LUD-06.
  const invoice = await requestInvoiceFromCallback(meta.callback, amountMsats, comment, {
    ...opts,
    metadata: meta.metadata,
  });

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
  isLnurlNotFoundReason,
  bech32Decode,
  convertBits,
  decodeBolt11,
  assertInvoiceMatches,
  parseLightningAddress,
  lnurlpMetadataUrl,
  fetchWithRetry,
  fetchLnurlPayMetadata,
  requestInvoiceFromCallback,
  getInvoiceFromLightningAddress,
  verifyLnurlPayment,
};
