#!/usr/bin/env node
/**
 * Blink Wallet - Resolve Receiver (custodial vs non-custodial classifier)
 *
 * Usage: node resolve_receiver.js <identifier>
 *
 * Classifies a Blink identifier (bare `username` or `user@blink.sv`) as either:
 *   - "custodial"  — a regular custodial Blink account (has a Blink wallet id)
 *   - "lnaddress"  — a non-custodial (Spark) account served via the LNURL server
 * or reports that the address does not exist.
 *
 * This is a diagnostic helper for agents: run it before choosing how to receive
 * or (in future) how to send. It performs the same custodial-first / LNURL-fallback
 * probe that create-invoice-lnaddress uses internally.
 *
 * Output: a single JSON object.
 *   { exists, type, username, domain, lightningAddress, walletId }
 *
 * Environment:
 *   BLINK_API_KEY  - Optional. Improves the custodial probe.
 *   BLINK_API_URL  - Optional. Override GraphQL endpoint (custodial probe only).
 *
 * Dependencies: None (uses Node.js built-in fetch).
 */

const { getApiKey, getApiUrl, resolveReceiver, DEFAULT_LN_ADDRESS_DOMAIN } = require('./_blink_client');

async function main() {
  const identifier = process.argv[2] ? process.argv[2].trim() : null;
  if (!identifier) {
    console.error('Usage: node resolve_receiver.js <identifier>   (e.g. alice  or  alice@blink.sv)');
    process.exit(1);
  }

  const apiKey = getApiKey({ required: false });
  const apiUrl = getApiUrl();

  try {
    const receiver = await resolveReceiver(identifier, {
      apiKey,
      apiUrl,
      defaultDomain: DEFAULT_LN_ADDRESS_DOMAIN,
    });
    console.log(
      JSON.stringify(
        {
          exists: true,
          type: receiver.type,
          username: receiver.username,
          domain: receiver.domain,
          lightningAddress: receiver.lightningAddress,
          walletId: receiver.walletId,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if (err.code === 'RECEIVER_NOT_FOUND') {
      console.log(
        JSON.stringify(
          {
            exists: false,
            type: null,
            identifier,
            message: err.message,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    throw err;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

module.exports = { main };
