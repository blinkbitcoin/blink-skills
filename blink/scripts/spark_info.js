#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) account info
 *
 * Usage: node spark_info.js [--network mainnet|regtest]
 *
 * Shows a NON-CUSTODIAL (Spark) account's info directly from the wallet via
 * the Breez Spark SDK — the non-custodial counterpart of the custodial
 * `account-info` command. Balance and history are not visible through the
 * Blink API at all; they live in the Spark wallet and must be read with the
 * seed via the SDK.
 *
 * Output: the SDK's getInfo() response (BigInt fields coerced to Number),
 * plus accountType and network.
 *
 * Environment:
 *   SPARK_MNEMONIC  - Required. 12/24-word BIP39 seed (spend authority — keep secret).
 *   BREEZ_API_KEY   - Required. Breez API key for the SDK to reach the Spark service.
 *
 * Dependencies: @breeztech/breez-sdk-spark (optional; Node 22+).
 */

const { connect, normalizeInfo } = require('./_spark_sdk');

function parseArgs(argv) {
  let network = process.env.SPARK_NETWORK || 'mainnet';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--network' && i + 1 < argv.length) {
      network = argv[i + 1];
      i++;
    }
  }
  return { network };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(-Number.MAX_SAFE_INTEGER);

/**
 * Recursively normalize an SDK value for JSON output.
 *
 * JSON.stringify cannot represent two SDK shapes:
 *   - BigInt (throws)        → Number when safe, String when it would round
 *     unsafely (large token balances must never silently lose precision).
 *   - Map (always "{}")      → plain object with recursively normalized
 *     values. The pinned SDK returns tokenBalances as Map<string,
 *     TokenBalance>; a JSON round-trip would report a wallet WITH tokens
 *     as holding none.
 * Arrays and plain objects are normalized recursively; primitives pass through.
 */
function normalizeSdkValue(value) {
  if (typeof value === 'bigint') {
    return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = normalizeSdkValue(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(normalizeSdkValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeSdkValue(v);
    return out;
  }
  return value;
}

async function main() {
  const { network } = parseArgs(process.argv.slice(2));
  const { sdk, disconnect } = await connect({ network });
  try {
    const info = await sdk.getInfo({ ensureSynced: true });
    console.log(
      JSON.stringify(
        {
          accountType: 'lnaddress',
          network,
          ...normalizeSdkValue(info),
          // balanceSats re-normalized for a stable contract across SDK versions.
          balanceSats: normalizeInfo(info).balanceSats,
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

module.exports = { main, parseArgs, normalizeSdkValue };
