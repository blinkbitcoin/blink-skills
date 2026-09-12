#!/usr/bin/env node
/**
 * Blink Wallet - L402 Token Store
 *
 * Usage:
 *   node l402_store.js list
 *   node l402_store.js get <domain>
 *   node l402_store.js clear [--expired]
 *
 * Manages a local cache of L402 tokens at ~/.blink/l402-tokens.json.
 * Tokens are indexed by domain (hostname) and include the macaroon,
 * preimage, and optional expiration time.
 *
 * This cache is used by l402_pay.js to reuse valid tokens and avoid
 * re-paying for access already purchased.
 *
 * Arguments (when used as CLI):
 *   list              - Show all cached tokens (masks preimage for safety).
 *   get <domain>      - Get the stored token for a specific domain.
 *   clear [--expired] - Remove expired tokens (or all tokens without --expired).
 *
 * Dependencies: None (uses Node.js built-in fs/path/os)
 *
 * Output: JSON to stdout. Status messages to stderr.
 */

'use strict';

const fs = require('node:fs');
const { ensureSecureStateDir, writeSecureFileAtomic } = require('./_secure_files');
const path = require('node:path');
const os = require('node:os');

// ── Store path ────────────────────────────────────────────────────────────────

const STORE_DIR = path.join(os.homedir(), '.blink');
const STORE_FILE = path.join(STORE_DIR, 'l402-tokens.json');

// ── Store I/O ─────────────────────────────────────────────────────────────────

/**
 * Read the token store from disk.
 * Returns an empty object if the file does not exist or is unreadable.
 *
 * @returns {object}  Map of domain → token entry.
 */
function readStore() {
  try {
    ensureSecureStateDir(STORE_DIR); // one-time migration: 0644 -> 0600
  } catch {
    // Best-effort hardening on read.
  }
  try {
    const content = fs.readFileSync(STORE_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write the token store to disk, creating ~/.blink/ if needed.
 *
 * @param {object} store
 */
function writeStore(store) {
  // The token store holds macaroons + preimages — a reusable bearer
  // credential pair (audit: previously umask-dependent 0644). Atomic, 0600,
  // symlink-refusing (mirrors l402-root-key and the Spark state dir).
  try {
    writeSecureFileAtomic(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    throw new Error(`Failed to write token store: ${err.message}`);
  }
}

// ── Token operations ──────────────────────────────────────────────────────────

/**
 * Save an L402 token for a domain.
 *
 * @param {string} domain     e.g. "stock.l402.org"
 * @param {object} tokenData
 * @param {string} tokenData.macaroon    Base64 macaroon string.
 * @param {string} tokenData.preimage    64-char hex payment preimage.
 * @param {string} [tokenData.invoice]   BOLT-11 invoice (for reference).
 * @param {number} [tokenData.satoshis]  Amount paid in sats.
 * @param {number} [tokenData.expiresAt] Unix timestamp (ms) when token expires.
 */
function saveToken(domain, tokenData) {
  const store = readStore();
  store[domain] = {
    ...tokenData,
    savedAt: Date.now(),
  };
  writeStore(store);
}

/**
 * Retrieve a stored token for a domain.
 * Returns null if not found or if expired.
 *
 * @param {string} domain
 * @returns {object | null}
 */
function getToken(domain) {
  const store = readStore();
  const entry = store[domain];
  if (!entry) return null;
  // Check expiry
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    return null; // expired
  }
  return entry;
}

/**
 * List all stored tokens.
 * Masks the preimage for safety in output.
 *
 * @returns {object[]}
 */
function listTokens() {
  const store = readStore();
  return Object.entries(store).map(([domain, entry]) => {
    const now = Date.now();
    const expired = entry.expiresAt ? now > entry.expiresAt : false;
    const expiresInMs = entry.expiresAt ? entry.expiresAt - now : null;
    return {
      domain,
      macaroon: entry.macaroon ? entry.macaroon.slice(0, 12) + '…' + entry.macaroon.slice(-6) : null,
      preimage: entry.preimage ? entry.preimage.slice(0, 8) + '…' : null,
      satoshis: entry.satoshis ?? null,
      invoiceMsats: entry.invoiceMsats ?? null,
      budgetSats: entry.budgetSats ?? null,
      savedAt: entry.savedAt ? new Date(entry.savedAt).toISOString() : null,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      expired,
      expiresIn: !expired && expiresInMs !== null ? `${Math.round(expiresInMs / 1000)}s` : null,
    };
  });
}

/**
 * Remove tokens from the store.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.expiredOnly=false]  If true, remove only expired tokens.
 * @returns {number}  Number of tokens removed.
 */
function clearTokens({ expiredOnly = false } = {}) {
  const store = readStore();
  const now = Date.now();
  let removed = 0;

  if (!expiredOnly) {
    removed = Object.keys(store).length;
    writeStore({});
    return removed;
  }

  for (const [domain, entry] of Object.entries(store)) {
    if (entry.expiresAt && now > entry.expiresAt) {
      delete store[domain];
      removed++;
    }
  }
  writeStore(store);
  return removed;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Usage:');
    console.error('  node l402_store.js list');
    console.error('  node l402_store.js get <domain>');
    console.error('  node l402_store.js clear [--expired]');
    process.exit(1);
  }

  if (command === 'list') {
    const tokens = listTokens();
    const output = {
      storePath: STORE_FILE,
      count: tokens.length,
      tokens,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (command === 'get') {
    const domain = args[1];
    if (!domain) {
      console.error('Usage: node l402_store.js get <domain>');
      process.exit(1);
    }
    const entry = getToken(domain);
    if (!entry) {
      console.error(`No valid token found for domain: ${domain}`);
      console.log(JSON.stringify({ domain, found: false }, null, 2));
      process.exit(0);
    }
    const output = {
      domain,
      found: true,
      macaroon: entry.macaroon,
      preimage: entry.preimage,
      satoshis: entry.satoshis ?? null,
      invoiceMsats: entry.invoiceMsats ?? null,
      budgetSats: entry.budgetSats ?? null,
      savedAt: entry.savedAt ? new Date(entry.savedAt).toISOString() : null,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (command === 'clear') {
    const expiredOnly = args.includes('--expired');
    const removed = clearTokens({ expiredOnly });
    const output = {
      removed,
      message: expiredOnly ? `Removed ${removed} expired token(s).` : `Removed all ${removed} token(s).`,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Commands: list, get, clear');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  saveToken,
  getToken,
  listTokens,
  clearTokens,
  STORE_FILE,
  main,
};
