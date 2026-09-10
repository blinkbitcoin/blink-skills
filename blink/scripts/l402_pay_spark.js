#!/usr/bin/env node
/**
 * Blink Wallet - L402 Spark payment leg
 *
 * Pays a BOLT-11 invoice from a self-custodial (Spark) account via the Breez
 * Spark SDK — the payment backend for `l402-pay --spark`. No Blink API
 * involvement: the SDK signs locally with the seed, and the preimage comes
 * back in the settled payment's HTLC details (details.type === 'lightning'
 * → htlcDetails.preimage, present once the HTLC status is preimageShared).
 *
 * Failure stages matter to the caller's reservation semantics:
 *   - connect/prepare failures happen BEFORE dispatch (nothing moved — the
 *     caller releases the budget reservation), so they are rethrown untagged.
 *   - sendPayment failures happen AFTER dispatch (outcome unknown — the
 *     payment may still settle). They are wrapped in a dedicated typed Error
 *     (code SPARK_DISPATCH_OUTCOME_UNKNOWN, stage 'dispatch', original kept
 *     as `cause`) so ANY rejection value — a string, a frozen or
 *     null-prototype object, a throwing Proxy — keeps the classification,
 *     and the caller KEEPS the reservation (fail-closed).
 */

const { connect, feeFromPrepare, safeErrorDetail } = require('./_spark_sdk');

/**
 * Pay a BOLT-11 invoice from a Spark account.
 *
 * @param {string} invoice  BOLT-11 payment request (the L402 challenge invoice).
 * @param {object} [opts]
 * @param {string} [opts.network]  'mainnet' (default) or 'regtest'.
 * @returns {Promise<{ payment: object, status: string, preimage: string|null, feeSats: number|null }>}
 *   status is NORMALIZED at this boundary, case-insensitively, onto the
 *   custodial vocabulary: the SDK's 'completed'/'pending'/'failed' (any
 *   casing) become 'SUCCESS'/'PENDING'/'FAILURE'; unknown statuses pass
 *   through raw. Callers must branch on these values only.
 */
async function payInvoiceViaSpark(invoice, { network } = {}) {
  const { sdk, disconnect } = await connect({ network: network || process.env.SPARK_NETWORK || 'mainnet' });
  try {
    // Prepare: fee resolution and validation. The invoice carries its own
    // amount — no `amount` is passed (a ceil-rounded value would not match
    // the invoice's millisats).
    const prepareResponse = await sdk.prepareSendPayment({
      paymentRequest: { type: 'input', input: invoice },
    });
    const feeSats = feeFromPrepare(prepareResponse);

    let result;
    try {
      result = await sdk.sendPayment({ prepareResponse });
    } catch (e) {
      // Promises may reject with arbitrary values. A string or a
      // non-extensible object would silently drop an attached stage marker
      // (sloppy-mode no-op), and a null-prototype object or a Proxy with a
      // throwing trap cannot even be string-coerced. The typed error must be
      // constructed NO MATTER WHAT the rejected value is, or the caller would
      // misread a post-dispatch failure as pre-dispatch and free the budget.
      const err = new Error(`Spark payment failed after dispatch (outcome unknown): ${safeErrorDetail(e)}`, {
        cause: e,
      });
      err.code = 'SPARK_DISPATCH_OUTCOME_UNKNOWN';
      err.stage = 'dispatch'; // outcome unknown — the caller must keep the reservation
      throw err;
    }

    // The payment was dispatched; a poisoned resolved value (throwing getters
    // on payment/status/details) would otherwise escape untagged and the
    // caller would release the reservation. Decode failures after dispatch are
    // outcome-unknown, same class as a thrown dispatch error.
    let payment;
    let status;
    let preimage = null;
    try {
      payment = result && result.payment ? result.payment : result;
      const rawStatus = String((payment && payment.status) || 'SUBMITTED');
      const lower = rawStatus.toLowerCase();

      if (lower === 'completed' || lower === 'success') status = 'SUCCESS';
      else if (lower === 'pending' || lower === 'submitted') status = 'PENDING';
      else if (lower === 'failed' || lower === 'failure') status = 'FAILURE';
      else status = rawStatus; // unknown — preserved raw so the caller sees the truth

      const details = payment && payment.details;
      if (details && details.type === 'lightning' && details.htlcDetails) {
        preimage = details.htlcDetails.preimage || null;
      }
    } catch (e) {
      const err = new Error(
        `Spark payment result could not be decoded after dispatch (outcome unknown): ${safeErrorDetail(e)}`,
        { cause: e },
      );
      err.code = 'SPARK_DISPATCH_OUTCOME_UNKNOWN';
      err.stage = 'dispatch'; // outcome unknown — the caller must keep the reservation
      throw err;
    }

    return { payment, status, preimage, feeSats };
  } finally {
    // Cleanup must never mask the payment outcome: a disconnect rejection
    // after dispatch would otherwise REPLACE the successful result with an
    // untagged error, and the caller — reading it as a pre-dispatch failure —
    // would release the budget reservation after funds moved.
    try {
      await disconnect();
    } catch (e) {
      // safeErrorDetail: even the warning must not throw (a throwing getter on
      // a fake/alternate connector's error would otherwise replace the result).
      console.error(`Warning: Spark disconnect failed (payment result is unaffected): ${safeErrorDetail(e)}`);
    }
  }
}

if (require.main === module) {
  console.error('This module is a payment leg for l402-pay (use: blink l402-pay --spark).');
  process.exit(1);
}

module.exports = { payInvoiceViaSpark };
