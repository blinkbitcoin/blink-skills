#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) balance
 *
 * Usage: node spark_balance.js [--network mainnet|regtest]
 *
 * Reads the BTC balance of a NON-CUSTODIAL (Spark) account directly from the
 * wallet via the Breez Spark SDK. This is the non-custodial parity for the
 * custodial `balance` command.
 *
 * Custodial `balance` reads `me.defaultAccount.wallets` over the Blink GraphQL
 * API using BLINK_API_KEY. Non-custodial balance is NOT visible through the
 * Blink API at all — it lives in the Spark wallet — so it must be read via the
 * SDK using the account seed.
 *
 * Environment:
 *   SPARK_MNEMONIC  - Required. 12/24-word BIP39 seed (spend authority — keep secret).
 *   BREEZ_API_KEY   - Required. Breez API key for the SDK to reach the Spark service.
 *
 * Dependencies: @breeztech/breez-sdk-spark (optional; Node 22+).
 */

const { connect, waitForStableBalance } = require('./_spark_sdk');

async function main() {
  const network = process.env.SPARK_NETWORK || 'mainnet';
  const { sdk, disconnect } = await connect({ network });
  try {
    // Wait for a stable balance to avoid reporting a mid-sync transient right
    // after an incoming payment.
    const { balanceSats, stable } = await waitForStableBalance(sdk);
    console.log(
      JSON.stringify(
        {
          accountType: 'lnaddress',
          network,
          balanceSats,
          stable,
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

module.exports = { main };
