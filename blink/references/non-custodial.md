# Non-Custodial (Spark) Accounts

Use this reference to understand how blink-skills supports **self-custodial
(Spark)** Blink accounts, and how it differs from custodial accounts.

## Source Of Truth

- Blink LNURL server (routes recipients to Blink vs Spark): `blink-lnurl-server`
- Breez Spark SDK (Node build): `@breeztech/breez-sdk-spark` (https://breez.technology)
- Skill scripts: `blink/scripts/_lnurl.js`, `_spark_sdk.js`, `create_invoice_lnaddress.js`,
  `resolve_receiver.js`, `spark_*.js`
- Reference implementation (receive): blink-terminal PR #37

## Two Account Types

|                 | Custodial                       | Non-custodial (Spark)                                       |
| --------------- | ------------------------------- | ----------------------------------------------------------- |
| Keys            | Blink holds them                | User holds a 12/24-word seed                                |
| Auth to skill   | `BLINK_API_KEY`                 | `SPARK_MNEMONIC` (+ `BREEZ_API_KEY`) for signing ops        |
| Balance/history | Blink GraphQL API (`me`)        | Breez Spark SDK (local); **not on the Blink API**           |
| Receive         | `lnInvoiceCreate` mutation      | Public LNURL-pay on `blink.sv` (no creds)                   |
| Send            | `lnInvoicePaymentSend` mutation | SDK `sendPayment` (signs locally); **not on the Blink API** |

Both types share the `blink.sv` Lightning-address domain. The account **type is
not encoded in the domain** — the blink-lnurl-server routes each recipient to
the correct provider internally.

## Receiving (no credentials, no seed)

Any Blink Lightning Address (`user@blink.sv`) can be paid via LNURL-pay, whether
the recipient is custodial or Spark. `create-invoice-lnaddress` does this:

1. `resolve-receiver` probes custodial-first (`accountDefaultWallet`), then falls
   back to `.well-known/lnurlp/{user}`. A hit on the fallback ⇒ non-custodial.
2. It mints a BOLT-11 invoice from the LNURL-pay callback.
3. It detects settlement by polling the **LUD-21 `verify`** URL. For Spark
   recipients this flag is webhook-populated and may lag a few seconds.

SSRF guard: only `blink.sv` is an allowed resolution target.

## Balance / send / history / events (require the seed)

These operations need the account seed and run the Breez Spark SDK headless in
Node (Node 22+). Set `SPARK_MNEMONIC` and `BREEZ_API_KEY`.

- `spark-balance` → `sdk.getInfo().balanceSats`
- `spark-send` → classify the destination with `sdk.parse()`, then:
  - Lightning Address / LNURL → `sdk.prepareLnurlPay` (fees) then `sdk.lnurlPay` (signs)
  - BOLT-11 invoice / Spark address → `sdk.prepareSendPayment` (fees) then `sdk.sendPayment` (signs)
  - A Lightning Address (e.g. `alice@blink.sv`) is an LNURL-pay destination and
    MUST use the LNURL path — `prepareSendPayment` does not accept it.
- `spark-transactions` → `sdk.listPayments`
- `spark-subscribe` → `sdk.addEventListener`

**Security:** the seed grants spend authority. It is read only from
`SPARK_MNEMONIC` (never from shell rc files), and never logged or written in
readable form. The SDK's local storage dir is keyed by a non-reversible hash of
the seed.

## The Breez API key (`BREEZ_API_KEY`)

The Breez Spark SDK will not connect without a Breez API key. This is an
access credential for **Breez's infrastructure** — it is NOT custody: it never
touches the seed, cannot sign, and cannot spend. It is per-_application_, not
per-_wallet_, so any valid key works with any seed.

- In **blink-mobile** the key is baked into the app at build time from CI secrets
  (`app/self-custodial/config.ts` reads `Config.BREEZ_API_KEY`), so users never
  see it. A standalone runner (a VPS agent, this CLI) has no baked-in key and
  must supply its own.
- **Get a free key** at https://breez.technology — via the request form, or
  programmatically (the key is emailed to you):

  ```bash
  curl -d "fullname=<full name>" -d "company=<company>" \
       -d "email=<email>" -d "message=<message>" \
       https://breez.technology/contact/apikey
  ```

Set it as `BREEZ_API_KEY` alongside `SPARK_MNEMONIC`.

## Scope of this spike

- **BTC only.** No USD / Spark Stable Balance (USDB), no swaps.
- **Production `blink.sv` only.** Staging (signet vs Spark regtest) is deferred.
- Send is a proof-of-concept demonstrating that agent-side signing works with
  no Blink API change and no server signer/VPS.

## API-growth notes (issue #940)

- **Receive needs no Blink API change** — the identifier alone is sufficient.
- Convenience GraphQL mutations could let API devs skip raw LNURL:
  `lnAddressInvoiceCreate` (returns `paymentRequest` + `verify`) and
  `lnAddressInvoiceStatus` (wraps LUD-21 verify). The backend already has the
  unwired `lnurl-server` service hooks (`getIdentifier`, `transferIdentifierToSpark`).
- **Balance and transaction history are the biggest gaps** — they are SDK-local
  and invisible to the Blink API. A read model keyed on the identifier (fed by the
  LNURL server's outbound settlement webhook) would close this.
- **Send is not an API concern** — it must be signed by the seed holder.
