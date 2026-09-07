#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) SEND
 *
 * Usage: node spark_send.js <destination> <amount_sats> [--dry-run] [--network mainnet|regtest]
 *
 * Sends BTC from a NON-CUSTODIAL (Spark) account by SIGNING the transaction
 * locally with the account seed, via the Breez Spark SDK. This is the
 * non-custodial parity for the custodial `pay-invoice` / `pay-lnaddress`
 * commands.
 *
 * KEY POINT (research): unlike receive, non-custodial send CANNOT go through the
 * Blink GraphQL API — there is no Blink wallet to debit, and the Blink backend
 * cannot sign for a self-custodial account. The signature must be produced by
 * whoever holds the seed. This command demonstrates that an agent holding the
 * seed CAN send entirely client-side, with NO Blink API change and NO server
 * signer / VPS required.
 *
 * <destination> may be:
 *   - a BOLT-11 invoice            -> prepareSendPayment / sendPayment
 *   - a Spark address              -> prepareSendPayment / sendPayment
 *   - a Lightning Address / LNURL  -> prepareLnurlPay / lnurlPay
 * The command uses `sdk.parse()` to classify the destination and routes to the
 * correct SDK path. (A Lightning Address like `alice@blink.sv` is an LNURL-pay
 * destination and MUST use the LNURL path — prepareSendPayment does not accept
 * it.)
 *
 * SAFETY:
 *   - Always resolves fees via the prepare step first and prints them.
 *   - --dry-run prepares only (fees shown) and does NOT send.
 *   - The seed (SPARK_MNEMONIC) is never logged.
 *
 * Environment:
 *   SPARK_MNEMONIC  - Required. 12/24-word BIP39 seed (spend authority — keep secret).
 *   BREEZ_API_KEY   - Required. Breez API key.
 *
 * Dependencies: @breeztech/breez-sdk-spark (optional; Node 22+).
 *
 * CAUTION: This signs and sends real bitcoin from a self-custodial wallet.
 */

const { connect } = require('./_spark_sdk');

function parseArgs(argv) {
  let destination = null;
  let amountSats = null;
  let dryRun = false;
  let network = process.env.SPARK_NETWORK || 'mainnet';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--network' && i + 1 < argv.length) {
      network = argv[i + 1];
      i++;
    } else if (destination === null) {
      destination = arg.trim();
    } else if (amountSats === null) {
      amountSats = parseInt(arg, 10);
      if (isNaN(amountSats) || amountSats <= 0) throw new Error('amount_sats must be a positive integer');
    }
  }
  return { destination, amountSats, dryRun, network };
}

function feeFromPrepare(prepareResponse) {
  // Fee location varies by destination type / SDK version:
  //  - LNURL-pay prepare response:      top-level `feeSats`
  //  - bolt11Invoice send method:       `lightningFeeSats` (+ optional `sparkTransferFeeSats`)
  //  - sparkAddress send method:        `fee` (string)
  //  - older builds:                    `feeSats` on paymentMethod
  const has = (v) => v !== null && v !== undefined;
  if (!has(prepareResponse)) return null;

  // LNURL: top-level feeSats.
  if (has(prepareResponse.feeSats)) return Number(prepareResponse.feeSats);

  const pm = prepareResponse.paymentMethod;
  if (!pm) return null;

  if (has(pm.feeSats)) return Number(pm.feeSats);

  // bolt11Invoice: lightning fee (+ spark transfer fee if the route uses Spark).
  if (has(pm.lightningFeeSats)) {
    return Number(pm.lightningFeeSats) + (has(pm.sparkTransferFeeSats) ? Number(pm.sparkTransferFeeSats) : 0);
  }
  if (has(pm.sparkTransferFeeSats)) return Number(pm.sparkTransferFeeSats);

  // sparkAddress: `fee` (may be a string).
  if (has(pm.fee)) {
    const n = Number(pm.fee);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Determine whether a parsed input is an LNURL-pay / Lightning-address
 * destination (as opposed to a BOLT-11 invoice or Spark address).
 *
 * The WASM parse result uses a lowercase `type` discriminant. Different SDK
 * versions have used `lnUrlPay` and `lightningAddress`; treat both as LNURL.
 *
 * @param {object} parsed  Result of sdk.parse(destination).
 * @returns {boolean}
 */
function isLnurlPayInput(parsed) {
  if (!parsed) return false;
  const t = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
  return t === 'lnurlpay' || t === 'lightningaddress';
}

/**
 * Extract the LnurlPayRequestDetails from a parsed input, to hand to
 * prepareLnurlPay().
 *
 * The SDK's parse() result shape is:
 *   - { type: "lightningAddress", address, payRequest }  -> details in .payRequest
 *   - { type: "lnurlPay", ...LnurlPayRequestDetails }     -> the object IS the details
 *
 * @param {object} parsed
 * @returns {object}  LnurlPayRequestDetails (must have a `callback` field).
 */
function lnurlPayRequestFrom(parsed) {
  if (parsed && parsed.payRequest) return parsed.payRequest;
  return parsed;
}

/**
 * Send to a Lightning Address / LNURL-pay destination.
 *
 * PrepareLnurlPayRequest: { amount: bigint (sats), payRequest: details, comment? }
 * @returns {{ prepareResponse: object, feeSats: number|null }}
 */
async function prepareLnurl(sdk, parsed, amountSats) {
  const payRequest = lnurlPayRequestFrom(parsed);
  const prepareResponse = await sdk.prepareLnurlPay({
    amount: BigInt(amountSats),
    payRequest,
  });
  return { prepareResponse, feeSats: feeFromPrepare(prepareResponse) };
}

/**
 * Send to a BOLT-11 invoice / Spark address destination.
 * @returns {{ prepareResponse: object, feeSats: number|null }}
 */
async function prepareBolt(sdk, destination, amountSats) {
  // The SDK's PaymentRequest is a tagged enum, NOT a raw string:
  //   { type: "input", input: "<bolt11 | spark address | ...>" }
  // Passing the raw string fails with
  //   `invalid type: string ..., expected internally tagged enum PaymentRequest`.
  const prepareResponse = await sdk.prepareSendPayment({
    paymentRequest: { type: 'input', input: destination },
    amount: BigInt(amountSats),
  });
  return { prepareResponse, feeSats: feeFromPrepare(prepareResponse) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.destination || args.amountSats === null) {
    console.error('Usage: node spark_send.js <destination> <amount_sats> [--dry-run] [--network mainnet|regtest]');
    process.exit(1);
  }

  console.error('⚠️  NON-CUSTODIAL SEND: this signs a transaction with your account seed and spends real bitcoin.');

  const { sdk, disconnect } = await connect({ network: args.network });
  try {
    // 1. Classify the destination.
    const parsed = await sdk.parse(args.destination);
    const lnurl = isLnurlPayInput(parsed);
    console.error(
      `Destination classified as ${lnurl ? 'Lightning Address / LNURL-pay' : 'BOLT-11 invoice / Spark address'}.`,
    );

    // 2. Prepare (resolves fees) via the matching path.
    const { prepareResponse, feeSats } = lnurl
      ? await prepareLnurl(sdk, parsed, args.amountSats)
      : await prepareBolt(sdk, args.destination, args.amountSats);

    console.error(`Prepared payment. Estimated fee: ${feeSats === null ? 'unknown' : `${feeSats} sats`}.`);

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            event: 'send_prepared',
            dryRun: true,
            destination: args.destination,
            destinationType: lnurl ? 'lnurl' : 'bolt11',
            amountSats: args.amountSats,
            feeSats,
            network: args.network,
          },
          null,
          2,
        ),
      );
      return;
    }

    // 3. Send (signs locally) via the matching path.
    const result = lnurl ? await sdk.lnurlPay({ prepareResponse }) : await sdk.sendPayment({ prepareResponse });
    const payment = result && result.payment ? result.payment : result;

    console.log(
      JSON.stringify(
        {
          event: 'send_result',
          status: (payment && payment.status) || 'SUBMITTED',
          destination: args.destination,
          destinationType: lnurl ? 'lnurl' : 'bolt11',
          amountSats: args.amountSats,
          feeSats,
          paymentId: (payment && (payment.id || payment.paymentHash)) || null,
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

module.exports = { main, parseArgs, feeFromPrepare, isLnurlPayInput, lnurlPayRequestFrom };
