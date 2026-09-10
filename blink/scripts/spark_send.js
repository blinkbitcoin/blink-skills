#!/usr/bin/env node
/**
 * Blink Wallet - Non-custodial (Spark) SEND
 *
 * Usage: node spark_send.js <destination> <amount_sats> [--dry-run] [--force] [--network mainnet|regtest]
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
 *   - Budget controls: BLINK_BUDGET_HOURLY_SATS / BLINK_BUDGET_DAILY_SATS are
 *     enforced when configured (like the custodial pay commands); an
 *     unconfigured budget does not block this explicit one-shot payment.
 *     The amount is RESERVED under the budget lock before sending and
 *     finalized (or released on failure) after, so concurrent sends cannot
 *     jointly exceed a limit. Successful/pending sends are recorded in the
 *     spending log.
 *   - --force bypasses the budget check for an over-limit send.
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
const { reserveBudget, finalizeOrRecord, releaseReservation, recordSpend } = require('./_budget');

function parseArgs(argv) {
  let destination = null;
  let amountSats = null;
  let dryRun = false;
  let force = false;
  let network = process.env.SPARK_NETWORK || 'mainnet';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
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
  return { destination, amountSats, dryRun, force, network };
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
 * Classify an SDK parse() result into one of the routing targets this skill
 * supports. EXHAUSTIVE by design: the SDK recognizes more destination types
 * than we can pay to (on-chain Bitcoin addresses, BOLT-12 offers, cross-chain
 * addresses, URLs, ...), and a boolean LNURL-vs-everything-else check would
 * let any future SDK input type silently fall into the generic
 * prepareSendPayment path without ever having been validated for it. Only the
 * four types below are allowed; everything else is rejected by name.
 *
 * @param {object} parsed  Result of sdk.parse(destination).
 * @returns {{ type: 'lnurl'|'bolt11'|'spark', parsed: object }}
 * @throws {Error} code UNSUPPORTED_DESTINATION for any unrecognized type.
 */
function classifyDestination(parsed) {
  const t = parsed && typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
  if (t === 'lnurlpay' || t === 'lightningaddress') return { type: 'lnurl', parsed };
  if (t === 'bolt11invoice') return { type: 'bolt11', parsed };
  if (t === 'sparkaddress') return { type: 'spark', parsed };
  const e = new Error(
    `Unsupported destination type '${t || 'unknown'}'. Supported: BOLT-11 invoice, Spark address, Lightning Address, LNURL-pay URL.`,
  );
  e.code = 'UNSUPPORTED_DESTINATION';
  throw e;
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

/**
 * Does this SDK payment status mean the payment did not go through?
 *
 * Compared case-insensitively because the SDK's casing has moved between
 * versions (`failed` vs `FAILED`), and a casing mismatch here would silently
 * restore the exit-0-on-failure bug.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isFailedStatus(status) {
  // Accept both a plain string and a tagged variant ({ type: 'failed' }), which
  // is how the SDK models several other enums and could plausibly become the
  // shape here. `String({...})` is "[object Object]", which would quietly
  // reinstate exit-0-on-failure.
  const value = status && typeof status === 'object' ? status.type || status.status : status;
  return String(value || '').toLowerCase() === 'failed';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.destination || args.amountSats === null) {
    console.error(
      'Usage: node spark_send.js <destination> <amount_sats> [--dry-run] [--force] [--network mainnet|regtest]',
    );
    process.exit(1);
  }

  console.error('⚠️  NON-CUSTODIAL SEND: this signs a transaction with your account seed and spends real bitcoin.');

  const { sdk, disconnect } = await connect({ network: args.network });
  try {
    // 1. Classify the destination.
    const parsed = await sdk.parse(args.destination);
    // Exhaustive classification: anything the SDK recognizes but this skill
    // does not pay to (on-chain, BOLT-12, cross-chain, ...) is rejected here,
    // before any prepare or budget interaction.
    const dest = classifyDestination(parsed);
    console.error(
      `Destination classified as ${dest.type === 'lnurl' ? 'Lightning Address / LNURL-pay' : dest.type === 'spark' ? 'Spark address' : 'BOLT-11 invoice'}.`,
    );

    // 2. Prepare (resolves fees) via the matching path.
    const { prepareResponse, feeSats } =
      dest.type === 'lnurl'
        ? await prepareLnurl(sdk, dest.parsed, args.amountSats)
        : await prepareBolt(sdk, args.destination, args.amountSats);

    console.error(`Prepared payment. Estimated fee: ${feeSats === null ? 'unknown' : `${feeSats} sats`}.`);

    if (args.dryRun) {
      console.log(
        JSON.stringify(
          {
            event: 'send_prepared',
            dryRun: true,
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
      return;
    }

    // ── Budget reservation ──
    // The limit decision AND the reservation append happen under one lock, so
    // two concurrent sends can never both pass the same remaining budget. Same
    // treatment as the custodial one-shot payments (pay-invoice & co): the
    // budget is enforced when configured, but an unconfigured budget must not
    // block an explicitly user-initiated payment, so opt out of the fail-closed
    // default that guards autonomous L402 auto-pay. --force overrides.
    // Budgets count the payment PRINCIPAL, not the routing fee — same
    // convention as the custodial pay commands.
    let reservationId = null;
    if (!args.force) {
      const reservation = reserveBudget(
        { sats: args.amountSats, command: 'spark-send', domain: null },
        { requireConfigured: false },
      );
      if (!reservation.allowed) {
        throw new Error(`Budget exceeded: ${reservation.reason} Use --force to override.`);
      }
      reservationId = reservation.id; // null when no budget is configured
    }

    // 3. Send (signs locally) via the matching path. A throw after the send
    // was dispatched (timeout, lost response, SDK error) does NOT prove the
    // payment failed — the payment may still settle. Keep the reservation
    // reserved (fail-closed) rather than freeing the budget for a retry.
    let result;
    try {
      result =
        dest.type === 'lnurl' ? await sdk.lnurlPay({ prepareResponse }) : await sdk.sendPayment({ prepareResponse });
    } catch (e) {
      if (reservationId) {
        console.error(
          `Warning: payment outcome is unknown after this error, so the budget reservation stays in place ` +
            `(fail-closed, auto-cleared by the 25h prune). Inspect \`spark-transactions\` before retrying.`,
        );
      }
      throw e;
    }
    const payment = result && result.payment ? result.payment : result;
    const status = (payment && payment.status) || 'SUBMITTED';

    // Record the spend unless the SDK says the payment failed — same rule as
    // the custodial pay commands ("only successful/pending payments are
    // logged"). Non-fatal, but never silent: a spend that escapes the budget
    // log would make later budget checks overestimate what is left.
    if (!isFailedStatus(status)) {
      try {
        if (reservationId) {
          const outcome = finalizeOrRecord(reservationId, {
            sats: args.amountSats,
            command: 'spark-send',
            domain: null,
          });
          if (outcome === 'restored') {
            console.error(
              'Warning: budget reservation was missing (e.g. after `blink budget reset`); the spend was recorded anyway.',
            );
          }
        } else {
          recordSpend({ sats: args.amountSats, command: 'spark-send', domain: null });
        }
      } catch (e) {
        console.error(`Warning: could not record the spend in the budget log: ${e.message}`);
      }
    } else if (reservationId) {
      // Explicit terminal failure — the payment did not happen, free the budget.
      try {
        releaseReservation(reservationId);
      } catch (e) {
        // Not silent: a failed release strands the allowance — fail-closed is
        // correct for the budget, but the operator must be told.
        console.error(`Warning: could not release the budget reservation: ${e.message}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          event: 'send_result',
          status,
          destination: args.destination,
          destinationType: dest.type,
          amountSats: args.amountSats,
          feeSats,
          paymentId: (payment && (payment.id || payment.paymentHash)) || null,
          network: args.network,
        },
        null,
        2,
      ),
    );

    // The SDK resolves rather than throws for a payment that FAILED, so exiting
    // 0 here would tell every caller — shell, CI, agent — that a payment which
    // did not happen succeeded. `pending` is not a failure: it is in flight and
    // may yet complete, so it keeps a zero exit.
    if (isFailedStatus(status)) {
      process.exitCode = 1;
      console.error(`Payment reported status '${status}'. Exiting non-zero.`);
    }
  } finally {
    // Cleanup must never mask the payment outcome: a disconnect rejection
    // after dispatch would otherwise REPLACE the result (and its exit code)
    // with an error, inviting a retry of an already-settled payment.
    try {
      await disconnect();
    } catch (e) {
      console.error(`Warning: Spark disconnect failed (payment result is unaffected): ${e.message}`);
    }
  }
}

if (require.main === module) {
  main()
    .then(async () => {
      // The Breez SDK keeps event-loop handles open after disconnect; force a
      // clean exit so the command returns promptly for the caller/agent.
      // Drain stdout first — process.exit() can truncate a pending write when
      // stdout is a pipe, and the JSON result is this command's whole product.
      // Preserves any exit code main() set (e.g. 1 for a failed payment).
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

module.exports = {
  main,
  parseArgs,
  feeFromPrepare,
  isLnurlPayInput,
  lnurlPayRequestFrom,
  isFailedStatus,
  classifyDestination,
  prepareLnurl,
  prepareBolt,
};
