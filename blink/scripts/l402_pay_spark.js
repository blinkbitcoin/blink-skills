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
 *     caller releases the budget reservation), so they are rethrown unttagged.
 *   - sendPayment failures happen AFTER dispatch (outcome unknown — the
 *     payment may still settle), so they are rethrown with e.stage set to
 *     'dispatch' and the caller KEEPS the reservation (fail-closed).
 */

const { connect } = require('./_spark_sdk');
const { feeFromPrepare } = require('./spark_send');

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
      e.stage = 'dispatch'; // outcome unknown — the caller must keep the reservation
      throw e;
    }

    const payment = result && result.payment ? result.payment : result;
    const rawStatus = String((payment && payment.status) || 'SUBMITTED');
    const lower = rawStatus.toLowerCase();

    let status;
    if (lower === 'completed' || lower === 'success') status = 'SUCCESS';
    else if (lower === 'pending' || lower === 'submitted') status = 'PENDING';
    else if (lower === 'failed' || lower === 'failure') status = 'FAILURE';
    else status = rawStatus; // unknown — preserved raw so the caller sees the truth

    let preimage = null;
    const details = payment && payment.details;
    if (details && details.type === 'lightning' && details.htlcDetails) {
      preimage = details.htlcDetails.preimage || null;
    }

    return { payment, status, preimage, feeSats };
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  console.error('This module is a payment leg for l402-pay (use: blink l402-pay --spark).');
  process.exit(1);
}

module.exports = { payInvoiceViaSpark };
