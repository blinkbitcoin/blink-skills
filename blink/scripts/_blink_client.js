/**
 * Blink Claw Skill — Shared Client Module
 *
 * Centralises API key resolution, GraphQL requests, WebSocket helpers,
 * invoice normalisation, wallet resolution, and common arg-parsing logic
 * used by every script in blink/scripts/.
 *
 * Zero external dependencies — Node.js 18+ built-ins only.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = 'https://api.blink.sv/graphql';
const DEFAULT_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30_000;

// ── Config helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the Blink API key from the environment.
 *
 * Only `process.env.BLINK_API_KEY` is read — the key is sent exclusively as
 * the X-API-KEY header to api.blink.sv (or a user-configured BLINK_API_URL).
 * No filesystem fallback: shell rc files are never read.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.required=true]  Throw if the key is not found.
 * @returns {string|null}
 */
function getApiKey({ required = true } = {}) {
  const key = process.env.BLINK_API_KEY;
  if (!key && required) {
    throw new Error(
      'BLINK_API_KEY not found. Set it as an environment variable, e.g.:\n' + '  export BLINK_API_KEY="blink_..."',
    );
  }
  return key || null;
}

/**
 * Resolve the Blink GraphQL API URL.
 * @returns {string}
 */
function getApiUrl() {
  return process.env.BLINK_API_URL || DEFAULT_API_URL;
}

/**
 * Resolve the Blink WebSocket URL.
 * Prefers BLINK_WS_URL env override; otherwise derives from the API URL.
 * @returns {string}
 */
function getWsUrl() {
  if (process.env.BLINK_WS_URL) return process.env.BLINK_WS_URL;
  const apiUrl = getApiUrl();
  const url = new URL(apiUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  if (url.hostname.startsWith('api.')) {
    url.hostname = url.hostname.replace(/^api\./, 'ws.');
  }
  return url.toString();
}

// ── HTTP / GraphQL ───────────────────────────────────────────────────────────

/**
 * Execute a GraphQL request against the Blink API.
 *
 * @param {object}  opts
 * @param {string}  opts.query          GraphQL query or mutation string.
 * @param {object}  [opts.variables={}] GraphQL variables.
 * @param {string|null} [opts.apiKey]   API key (null ⇒ unauthenticated).
 * @param {string}  [opts.apiUrl]       API endpoint URL.
 * @param {number}  [opts.timeoutMs]    Request timeout in ms (default 15 000).
 * @returns {object} The `data` property of the GraphQL response.
 */
async function graphqlRequest({
  query,
  variables = {},
  apiKey = null,
  apiUrl = DEFAULT_API_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-KEY'] = apiKey;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Tagged so callers can tell a server/transport failure apart from the
      // API successfully answering "no". Message format is unchanged.
      const e = new Error(`HTTP ${res.status}: ${await res.text()}`);
      e.code = 'HTTP_ERROR';
      e.status = res.status;
      throw e;
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      const e = new Error(`GraphQL error: ${json.errors.map((x) => x.message).join(', ')}`);
      e.code = 'GRAPHQL_ERROR';
      e.graphQLErrors = json.errors;
      throw e;
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// ── Invoice helpers ──────────────────────────────────────────────────────────

/**
 * Trim whitespace and strip a leading `lightning:` URI prefix (case-insensitive).
 * @param {string} input  Raw invoice / payment-request string.
 * @returns {string}
 */
function normalizeInvoice(input) {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith('lightning:')) {
    return trimmed.slice('lightning:'.length);
  }
  return trimmed;
}

/**
 * Emit a warning to stderr if the invoice doesn't look like a valid BOLT-11
 * payment request. Checks are case-insensitive.
 * @param {string} invoice  The (already-normalised) invoice string.
 */
function warnIfNotBolt11(invoice) {
  const lower = invoice.toLowerCase();
  if (!lower.startsWith('lnbc') && !lower.startsWith('lntbs') && !lower.startsWith('lntb')) {
    console.error('Warning: invoice does not start with lnbc/lntbs/lntb \u2014 may not be a valid BOLT-11 invoice.');
  }
}

// ── Wallet helpers ───────────────────────────────────────────────────────────

const WALLET_QUERY = `
  query Me {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
          balance
          pendingIncomingBalance
        }
      }
    }
  }
`;

/**
 * Resolve a wallet by currency.
 *
 * @param {object}  opts
 * @param {string}  opts.apiKey
 * @param {string}  opts.apiUrl
 * @param {string}  opts.currency       "BTC" or "USD".
 * @param {number}  [opts.timeoutMs]
 * @returns {{ id: string, walletCurrency: string, balance: number, pendingIncomingBalance: number }}
 */
async function getWallet({ apiKey, apiUrl, currency, timeoutMs }) {
  const data = await graphqlRequest({ query: WALLET_QUERY, apiKey, apiUrl, timeoutMs });
  if (!data.me) throw new Error('Authentication failed. Check your BLINK_API_KEY.');
  const wallet = data.me.defaultAccount.wallets.find((w) => w.walletCurrency === currency);
  if (!wallet) throw new Error(`No ${currency} wallet found on this account.`);
  return wallet;
}

/**
 * Resolve all wallets on the account.
 *
 * @param {object}  opts
 * @param {string}  opts.apiKey
 * @param {string}  opts.apiUrl
 * @param {number}  [opts.timeoutMs]
 * @returns {Array}
 */
async function getAllWallets({ apiKey, apiUrl, timeoutMs }) {
  const data = await graphqlRequest({ query: WALLET_QUERY, apiKey, apiUrl, timeoutMs });
  if (!data.me) throw new Error('Authentication failed. Check your BLINK_API_KEY.');
  return data.me.defaultAccount.wallets;
}

// ── Receiver resolution (custodial vs non-custodial) ─────────────────────────
//
// Blink serves LNURL-pay on `blink.sv` for BOTH custodial and non-custodial
// (Spark) accounts; the blink-lnurl-server routes each recipient to the right
// provider internally. The account TYPE is not encoded in the domain, so the
// only way to classify an identifier from the outside is:
//
//   1. Custodial probe: query `accountDefaultWallet(username)`.
//        Returns a wallet id  => the identifier is a CUSTODIAL Blink account.
//   2. LNURL fallback: fetch `.well-known/lnurlp/{username}` on the same host.
//        Returns a valid payRequest => the identifier is a NON-CUSTODIAL
//        (Spark) account served via the LNURL server.
//   3. Neither => the address does not exist.
//
// This mirrors the rule blink-terminal shipped (PR #37). It is the crux of the
// "does this address exist / which mechanism do I use" question and is exactly
// where a first-class Blink GraphQL resolution mutation could replace this
// two-step client dance (see the research findings / issue #940).

const DEFAULT_LN_ADDRESS_DOMAIN = 'blink.sv';

// Only blink.sv is allowed as a resolution target. This is an SSRF guard: the
// resolver turns a user-supplied identifier into an outbound network request,
// so an arbitrary domain must never be probed. (Same guard blink-terminal
// added as a review blocker.)
const ALLOWED_LN_ADDRESS_DOMAINS = new Set(['blink.sv']);

const ACCOUNT_DEFAULT_WALLET_QUERY = `
  query AccountDefaultWallet($username: Username!) {
    accountDefaultWallet(username: $username) {
      id
      walletCurrency
    }
  }
`;

// A GraphQL error that genuinely means "there is no such custodial account",
// as opposed to one that means "the lookup did not happen". Only the former may
// fall through to the LNURL branch.
//
// These patterns are deliberately ANCHORED TO THE ACCOUNT. A bare /not found/
// would also match "Cannot query field \"accountDefaultWallet\" ... not found"
// (schema drift) and a gateway's "404 Not Found" — both of which mean the
// lookup failed, and both of which would then misreport EVERY custodial account
// as non-custodial. A bare /invalid username/ likewise matches "Invalid
// username or password", which is an auth failure, not an absent account.
const NOT_FOUND_PATTERNS = [
  /account\s+does\s+not\s+exist/i,
  /(account|user|username)\s+(was\s+)?not\s+found/i,
  /no\s+account\s+(found\s+)?for/i,
  /(username|user)\s+does\s+not\s+exist/i,
  /unknown\s+(user|username|account)/i,
];

// Structured codes are preferred over prose when the server supplies them.
const NOT_FOUND_CODES = new Set(['ACCOUNT_NOT_FOUND', 'USERNAME_NOT_FOUND', 'NOT_FOUND', 'USER_NOT_FOUND']);

/**
 * Does this GraphQL error mean the account is absent, rather than the lookup
 * having failed?
 *
 * Only ever consulted for `GRAPHQL_ERROR`, so transport, timeout and HTTP
 * failures can never reach these patterns at all.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isAccountNotFoundError(err) {
  if (!err || err.code !== 'GRAPHQL_ERROR') return false;
  const errors = err.graphQLErrors || [];

  // Prefer an explicit machine-readable code when one is present.
  for (const e of errors) {
    const code = e && ((e.extensions && e.extensions.code) || e.code);
    if (code && NOT_FOUND_CODES.has(String(code).toUpperCase())) return true;
  }

  const messages = errors.map((e) => String(e && e.message)).join(' ') || String(err.message);
  return NOT_FOUND_PATTERNS.some((re) => re.test(messages));
}

/**
 * Look up a custodial account's default BTC wallet by username.
 *
 * Returns null ONLY when the API successfully answered that no such custodial
 * account exists. Every other failure — transport, timeout, authentication,
 * 5xx, an unrecognised GraphQL error — is rethrown.
 *
 * This distinction is load-bearing. Swallowing all errors here meant a
 * transient 503 on the custodial probe made a custodial account fall through to
 * the LNURL branch and get reported as `{ type: "lnaddress", walletId: null }`
 * — a confident wrong answer about someone's account type, produced by an
 * outage. Failing loudly is correct: the caller can retry, but it cannot detect
 * a misclassification.
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} [opts.apiKey]
 * @param {string} [opts.apiUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ id: string, walletCurrency: string }|null>}
 * @throws {Error} If the lookup itself could not be completed.
 */
async function getCustodialDefaultWallet({ username, apiKey = null, apiUrl, timeoutMs }) {
  try {
    const data = await graphqlRequest({
      query: ACCOUNT_DEFAULT_WALLET_QUERY,
      variables: { username },
      apiKey,
      apiUrl: apiUrl || DEFAULT_API_URL,
      timeoutMs,
    });
    return (data && data.accountDefaultWallet) || null;
  } catch (err) {
    if (isAccountNotFoundError(err)) return null;
    const e = new Error(
      `Could not determine whether '${username}' is a custodial Blink account: ${err.message}. ` +
        'Refusing to guess the account type from a failed lookup.',
    );
    e.code = 'CUSTODIAL_PROBE_FAILED';
    e.cause = err;
    throw e;
  }
}

/**
 * Resolve a receiver identifier to its account type and how to receive to it.
 *
 * @param {string} identifier   Bare username or `user@blink.sv`.
 * @param {object} [opts]
 * @param {string} [opts.apiKey]        Optional — improves custodial probe.
 * @param {string} [opts.apiUrl]
 * @param {string} [opts.defaultDomain] Defaults to blink.sv.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ type: 'custodial'|'lnaddress', username: string, domain: string,
 *                     lightningAddress: string, walletId: string|null }>}
 */
async function resolveReceiver(identifier, opts = {}) {
  // Lazy require to keep _lnurl.js optional for callers that never resolve.
  const { parseLightningAddress, fetchLnurlPayMetadata } = require('./_lnurl');

  const parsed = parseLightningAddress(identifier);
  const domain = parsed.domain || opts.defaultDomain || DEFAULT_LN_ADDRESS_DOMAIN;

  // SSRF guard: reject any explicit non-Blink domain before any network call.
  if (!ALLOWED_LN_ADDRESS_DOMAINS.has(domain)) {
    throw new Error(
      `Refusing to resolve non-Blink domain '${domain}'. Only ${[...ALLOWED_LN_ADDRESS_DOMAINS].join(', ')} is allowed.`,
    );
  }

  const lightningAddress = `${parsed.username}@${domain}`;

  // 1. Custodial probe.
  const custodialWallet = await getCustodialDefaultWallet({
    username: parsed.username,
    apiKey: opts.apiKey || null,
    apiUrl: opts.apiUrl,
    timeoutMs: opts.timeoutMs,
  });
  if (custodialWallet && custodialWallet.id) {
    return {
      type: 'custodial',
      username: parsed.username,
      domain,
      lightningAddress,
      walletId: custodialWallet.id,
    };
  }

  // 2. LNURL fallback (non-custodial / Spark).
  try {
    await fetchLnurlPayMetadata(parsed.username, domain, {
      timeoutMs: opts.timeoutMs,
      allowedHosts: ALLOWED_LN_ADDRESS_DOMAINS,
    });
    return {
      type: 'lnaddress',
      username: parsed.username,
      domain,
      lightningAddress,
      walletId: null,
    };
  } catch (err) {
    if (err.code === 'LNURL_NOT_FOUND') {
      const e = new Error(`'${lightningAddress}' does not seem to be a Blink address that exists.`);
      e.code = 'RECEIVER_NOT_FOUND';
      throw e;
    }
    throw err;
  }
}

// ── Currency conversion ──────────────────────────────────────────────────────

const CONVERSION_QUERY = `
  query CurrencyConversion($amount: Float!, $currency: DisplayCurrency!) {
    currencyConversionEstimation(amount: $amount, currency: $currency) {
      btcSatAmount
      usdCentAmount
    }
  }
`;

/**
 * Estimate the USD value of a satoshi amount.
 * Non-fatal: returns null on failure so callers can treat it as best-effort.
 *
 * @param {object}  opts
 * @param {number}  opts.sats
 * @param {string}  opts.apiKey
 * @param {string}  opts.apiUrl
 * @param {number}  [opts.timeoutMs]
 * @returns {number|null}  USD value rounded to 2 decimals, or null.
 */
async function estimateSatsToUsd({ sats, apiKey, apiUrl, timeoutMs }) {
  if (sats === 0) return 0;
  try {
    const data = await graphqlRequest({
      query: CONVERSION_QUERY,
      variables: { amount: 1.0, currency: 'USD' },
      apiKey,
      apiUrl,
      timeoutMs,
    });
    const est = data.currencyConversionEstimation;
    if (!est || !est.btcSatAmount || est.btcSatAmount === 0) return null;
    const usdPerSat = 1.0 / est.btcSatAmount;
    return Math.round(sats * usdPerSat * 100) / 100;
  } catch {
    return null; // non-fatal — USD estimate is best-effort
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Convert a Blink API base/offset pair to a decimal number.
 *
 * The Blink API represents prices as { base, offset } where the actual value
 * is `base * 10^offset`.  For example, { base: 6456903063948, offset: -12 }
 * represents 6.456903… (a BTC-per-sat price, unitless).
 *
 * @param {number} base
 * @param {number} offset
 * @returns {number}
 */
function decimalFromBaseOffset(base, offset) {
  return base * Math.pow(10, offset);
}

/**
 * Human-readable wallet balance string.
 * @param {{ walletCurrency: string, balance: number }} wallet
 * @returns {string}
 */
function formatBalance(wallet) {
  if (wallet.walletCurrency === 'USD') {
    return `$${(wallet.balance / 100).toFixed(2)} (${wallet.balance} cents)`;
  }
  return `${wallet.balance} sats`;
}

/**
 * Format a cent amount as USD.
 * @param {number} cents
 * @returns {string}
 */
function formatUsdCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Arg parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse a --wallet BTC|USD flag from an argv array.
 * Also recognises payment safety flags: --dry-run, --force, --max-amount <sats>.
 *
 * Returns the chosen currency, safety flags, and the remaining positional args
 * (with all recognised flags stripped out).
 *
 * @param {string[]} argv  Typically `process.argv.slice(2)`.
 * @returns {{ walletCurrency: string, dryRun: boolean, force: boolean, maxAmount: number|null, remaining: string[] }}
 */
function parseWalletArg(argv) {
  let walletCurrency = 'BTC';
  let dryRun = false;
  let force = false;
  let maxAmount = null;
  const remaining = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wallet' && i + 1 < argv.length) {
      const val = argv[i + 1].toUpperCase();
      if (val !== 'BTC' && val !== 'USD') {
        console.error('Error: --wallet must be BTC or USD');
        process.exit(1);
      }
      walletCurrency = val;
      i++; // skip value
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--max-amount' && i + 1 < argv.length) {
      const n = parseInt(argv[i + 1], 10);
      if (isNaN(n) || n <= 0) {
        console.error('Error: --max-amount must be a positive integer (sats)');
        process.exit(1);
      }
      maxAmount = n;
      i++; // skip value
    } else {
      remaining.push(argv[i]);
    }
  }
  return { walletCurrency, dryRun, force, maxAmount, remaining };
}

// ── WebSocket helpers ────────────────────────────────────────────────────────

/**
 * Ensure WebSocket is available (Node 22+ built-in, or --experimental-websocket on Node 20+).
 * @returns {typeof WebSocket}
 */
function requireWebSocket() {
  if (typeof WebSocket !== 'function') {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 22) {
      throw new Error('WebSocket unavailable despite Node 22+. This is unexpected — check your Node.js build.');
    } else if (major >= 20) {
      throw new Error(
        `WebSocket is not available on Node ${process.versions.node}. ` +
          'Re-run with: node --experimental-websocket <script>',
      );
    } else {
      throw new Error(
        `WebSocket requires Node.js 20+ with --experimental-websocket or Node.js 22+ (native). ` +
          `Current version: ${process.versions.node}`,
      );
    }
  }
  return WebSocket;
}

/**
 * Open a WebSocket subscription to watch an invoice's payment status.
 * Calls `onResult(resultObj, exitCode)` when the subscription resolves.
 *
 * @param {object}  opts
 * @param {string}  opts.paymentRequest   BOLT-11 invoice string.
 * @param {string}  opts.apiKey           Blink API key.
 * @param {string}  opts.wsUrl            WebSocket endpoint URL.
 * @param {number}  opts.timeoutSeconds   Timeout in seconds (0 = no timeout).
 * @param {(result: object, exitCode: number) => void} opts.onResult  Callback.
 */
function subscribeToInvoice({ paymentRequest, apiKey, wsUrl, timeoutSeconds, onResult }) {
  const WebSocketImpl = requireWebSocket();

  let done = false;
  let timeoutId = null;

  const ws = new WebSocketImpl(wsUrl, 'graphql-transport-ws');

  function finish(result, exitCode = 0) {
    if (done) return;
    done = true;
    if (timeoutId) clearTimeout(timeoutId);
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ id: '1', type: 'complete' }));
      }
    } catch {
      // best-effort cleanup
    }
    try {
      ws.close(1000);
    } catch {
      // best-effort cleanup
    }
    onResult(result, exitCode);
  }

  if (timeoutSeconds > 0) {
    timeoutId = setTimeout(() => {
      console.error('Subscription timed out.');
      finish(
        {
          event: 'subscription_result',
          paymentRequest,
          status: 'TIMEOUT',
          isPaid: false,
          isExpired: false,
          isPending: true,
        },
        1,
      );
    }, timeoutSeconds * 1000);
  }

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'connection_init',
        payload: { 'X-API-KEY': apiKey },
      }),
    );
  };

  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      console.error('Warning: received non-JSON WebSocket message');
      return;
    }

    if (message.type === 'connection_ack') {
      console.error('Subscribed \u2014 waiting for payment...');
      ws.send(
        JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            query: `subscription LnInvoicePaymentStatus($input: LnInvoicePaymentStatusInput!) {
  lnInvoicePaymentStatus(input: $input) {
    status
  }
}`,
            variables: { input: { paymentRequest } },
          },
        }),
      );
      return;
    }

    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (message.type === 'error') {
      console.error('Subscription error:', JSON.stringify(message.payload || message));
      finish(
        {
          event: 'subscription_result',
          paymentRequest,
          status: 'ERROR',
          error: message.payload || message,
        },
        1,
      );
      return;
    }

    if (message.type === 'next') {
      const status =
        message.payload && message.payload.data && message.payload.data.lnInvoicePaymentStatus
          ? message.payload.data.lnInvoicePaymentStatus.status
          : null;
      if (!status) return;

      console.error(`Invoice status: ${status}`);
      if (status === 'PAID' || status === 'EXPIRED') {
        finish(
          {
            event: 'subscription_result',
            paymentRequest,
            status,
            isPaid: status === 'PAID',
            isExpired: status === 'EXPIRED',
            isPending: false,
          },
          0,
        );
      }
      return;
    }

    if (message.type === 'complete') {
      finish(
        {
          event: 'subscription_result',
          paymentRequest,
          status: 'COMPLETE',
          isPaid: false,
          isExpired: false,
          isPending: true,
        },
        0,
      );
    }
  };

  ws.onerror = () => {
    console.error('WebSocket error during subscription');
    finish(
      {
        event: 'subscription_result',
        paymentRequest,
        status: 'ERROR',
        error: 'WebSocket error',
      },
      1,
    );
  };

  ws.onclose = (event) => {
    if (done) return;
    console.error(`WebSocket closed: code=${event.code} reason=${event.reason || 'unknown'}`);
    finish(
      {
        event: 'subscription_result',
        paymentRequest,
        status: 'CLOSED',
        isPaid: false,
        isExpired: false,
        isPending: true,
      },
      1,
    );
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  DEFAULT_API_URL,
  DEFAULT_TIMEOUT_MS,
  MUTATION_TIMEOUT_MS,

  // Config
  getApiKey,
  getApiUrl,
  getWsUrl,

  // HTTP
  graphqlRequest,

  // Invoice
  normalizeInvoice,
  warnIfNotBolt11,

  // Wallet
  WALLET_QUERY,
  getWallet,
  getAllWallets,

  // Receiver resolution (custodial vs non-custodial)
  DEFAULT_LN_ADDRESS_DOMAIN,
  ALLOWED_LN_ADDRESS_DOMAINS,
  ACCOUNT_DEFAULT_WALLET_QUERY,
  isAccountNotFoundError,
  getCustodialDefaultWallet,
  resolveReceiver,

  // Currency
  CONVERSION_QUERY,
  estimateSatsToUsd,

  // Formatting
  decimalFromBaseOffset,
  formatBalance,
  formatUsdCents,

  // Arg parsing
  parseWalletArg,

  // WebSocket
  requireWebSocket,
  subscribeToInvoice,
};
