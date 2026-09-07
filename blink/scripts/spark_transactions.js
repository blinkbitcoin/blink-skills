#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) transaction history
 *
 * Usage: node spark_transactions.js [--limit <n>] [--network mainnet|regtest]
 *
 * Lists recent payments for a NON-CUSTODIAL (Spark) account from the wallet via
 * the Breez Spark SDK. Non-custodial parity for the custodial `transactions`
 * command.
 *
 * RESEARCH NOTE: this is a significant gap for API developers. Custodial history
 * is queryable over the Blink GraphQL API (`me...transactions`). Non-custodial
 * history is SDK-LOCAL — it is not exposed by the Blink API at all, so it can
 * only be read with the seed. See the findings for a proposed API read model
 * (settlement mirroring via the LNURL server's outbound webhook).
 *
 * Environment:
 *   SPARK_MNEMONIC  - Required. 12/24-word BIP39 seed.
 *   BREEZ_API_KEY   - Required. Breez API key.
 *
 * Dependencies: @breeztech/breez-sdk-spark (optional; Node 22+).
 */

const { connect, normalizePayment } = require('./_spark_sdk');

function parseArgs(argv) {
  let limit = 20;
  let network = process.env.SPARK_NETWORK || 'mainnet';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && i + 1 < argv.length) {
      limit = parseInt(argv[i + 1], 10);
      if (isNaN(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
      i++;
    } else if (argv[i] === '--network' && i + 1 < argv.length) {
      network = argv[i + 1];
      i++;
    }
  }
  return { limit, network };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { sdk, disconnect } = await connect({ network: args.network });
  try {
    // listPayments signature varies slightly by SDK version; pass a request
    // object with a limit and normalize whatever comes back.
    const raw = await sdk.listPayments({ limit: args.limit });
    const payments = Array.isArray(raw) ? raw : raw && raw.payments ? raw.payments : [];
    console.log(
      JSON.stringify(
        {
          accountType: 'lnaddress',
          network: args.network,
          count: payments.length,
          transactions: payments.map(normalizePayment),
        },
        null,
        2,
      ),
    );
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      // The Breez SDK keeps event-loop handles open after disconnect; force a
      // clean exit so the command returns promptly for the caller/agent.
      process.exit(0);
    })
    .catch((e) => {
      console.error('Error:', e.message);
      process.exit(1);
    });
}

module.exports = { main, parseArgs };
