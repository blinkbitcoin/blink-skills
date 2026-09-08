#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) fee probe
 *
 * Usage: node spark_fee_probe.js <destination> <amount_sats> [--network mainnet|regtest]
 *
 * Estimates the fee for sending from a NON-CUSTODIAL (Spark) account without
 * sending anything. Runs the same prepare step as spark-send (which always
 * resolves fees before signing) but stops there — no budget check, no spend,
 * no spending-log entry.
 *
 * This is the non-custodial counterpart of the custodial `fee-probe` command:
 * an agent can compare routes/costs before asking the user to confirm a send.
 *
 * <destination> — same inputs as spark-send:
 *   - a BOLT-11 invoice
 *   - a Spark address
 *   - a Lightning Address / LNURL (uses the LNURL-pay path)
 *
 * Environment:
 *   SPARK_MNEMONIC  - Required. 12/24-word BIP39 seed (validated, never logged;
 *                     nothing is signed or sent).
 *   BREEZ_API_KEY   - Required. Breez API key.
 *
 * Dependencies: @breeztech/breez-sdk-spark (optional; Node 22+).
 */

const { connect } = require('./_spark_sdk');
const { parseArgs, classifyDestination, prepareLnurl, prepareBolt } = require('./spark_send');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.destination || args.amountSats === null || args.dryRun || args.force) {
    console.error('Usage: node spark_fee_probe.js <destination> <amount_sats> [--network mainnet|regtest]');
    process.exit(1);
  }

  const { sdk, disconnect } = await connect({ network: args.network });
  try {
    // 1. Classify the destination (same exhaustive rule as spark-send).
    const parsed = await sdk.parse(args.destination);
    const dest = classifyDestination(parsed);

    // 2. Prepare only — resolves fees, moves nothing, signs nothing.
    const { feeSats } =
      dest.type === 'lnurl'
        ? await prepareLnurl(sdk, dest.parsed, args.amountSats)
        : await prepareBolt(sdk, args.destination, args.amountSats);

    console.log(
      JSON.stringify(
        {
          event: 'fee_probe',
          destination: args.destination,
          destinationType: dest.type,
          amountSats: args.amountSats,
          feeSats,
          network: args.network,
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
    .then(async () => {
      // The Breez SDK keeps event-loop handles open after disconnect; force a
      // clean exit so the command returns promptly for the caller/agent.
      // Drain stdout first — process.exit() can truncate a pending write when
      // stdout is a pipe, and the JSON result is this command's whole product.
      await new Promise((resolve) => {
        if (process.stdout.writableLength === 0) return resolve();
        process.stdout.write('', () => resolve());
      });
      process.exit(process.exitCode || 0);
    })
    .catch((e) => {
      console.error('Error:', e.message);
      process.exit(1);
    });
}

module.exports = { main };
