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

### SSRF guard

Two distinct allowlists, because the user-supplied address and the
server-supplied follow-up URLs are different trust surfaces:

| Set            | Governs                                                   | Contents                      |
| -------------- | --------------------------------------------------------- | ----------------------------- |
| Address domain | the user-supplied `user@domain` — the narrow SSRF surface | `blink.sv` only               |
| Service hosts  | server-supplied `callback`, `verify`, redirect targets    | `blink.sv` + `lnurl.blink.sv` |

Blink serves its LNURL callbacks from a dedicated host (`lnurl.blink.sv`),
distinct from the address domain — confirmed against live production metadata.
LNURL is a protocol in which the server hands the client further URLs to fetch,
so the service-host allowlist is enforced at the network boundary — inside the
one function every request funnels through — and re-checked on **every hop**:

| Hop                                      | Checked                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `.well-known/lnurlp/<user>` metadata URL | host allowlist, HTTPS                                                |
| payRequest `callback`                    | host allowlist, HTTPS                                                |
| LUD-21 `verify`                          | host allowlist, HTTPS                                                |
| every HTTP redirect                      | redirects are followed manually, each `Location` re-validated, max 3 |

Being a local address is **not** a licence to be fetched: only the allowlist
admits a host. Private, loopback and link-local IP literals are refused in every
spelling — `127.0.0.1`, the integer form `2130706433`, `0x7f000001`, `127.1`,
`[::1]`, and IPv4-mapped IPv6 (`::ffff:a9fe:a9fe`, which is what `URL` actually
produces) — including `169.254.0.0/16` cloud metadata. Non-standard ports are
refused unless the caller listed `host:port` explicitly. Plaintext `http` is
permitted only for a local host the caller deliberately allowed; the match is
exact, so `localhost.attacker.example` does not qualify.

**Known limit:** the guard is name-based and does not pin the resolved address,
so it does not defend against DNS rebinding. Closing that needs resolve-then-pin
at the socket layer, which Node's `fetch` does not currently expose.

### Response binding

A remote server's answer is checked against the request that produced it:

- The callback's `pr` must decode as a BOLT-11 invoice, on the expected network,
  for **exactly** the amount requested. Amountless invoices are refused.
- A LUD-21 `settled: true` is accepted only when its `pr` matches the invoice
  being polled — otherwise another payment's settlement would read as your own.

## Balance / send / history / events (require the seed)

These operations need the account seed and run the Breez Spark SDK headless in
Node (Node 22+). Set `SPARK_MNEMONIC` and `BREEZ_API_KEY`.

**Install requirement:** the SDK persists wallet state through `better-sqlite3`,
a native module compiled at install time (needs `python3`, `make`, a C++
compiler). Under `--ignore-scripts` the package is unpacked but never built and
the SDK suppresses the warning, so `require()` still succeeds. The SDK's own
`defaultStorage()` factory is _lazy_ — it returns an object without opening a
database — so probing it cannot catch this. `connect()` therefore requires
`better-sqlite3` directly and opens an in-memory database, failing with
`SPARK_STORAGE_UNAVAILABLE` and the package-manager-specific build-script
approval step (`npm rebuild better-sqlite3`, `pnpm approve-builds` then
`pnpm rebuild`, `yarn rebuild`). Verify a fix by opening a database, not by
trusting a rebuild exit code — a rebuild can exit 0 without producing a binding.

**Invoice validation scope (receive path):** the BOLT-11 check verifies
**structure and request-binding**, not the cryptographic signature. It confirms
the bech32 checksum, network, exact amount, a mandatory payment-hash (`p`) tag,
a mandatory payment-secret (`s`) tag, exactly one description form (`d` or `h`,
not both, not neither), a current non-expired timestamp, a signature whose
recovery id is in `{0,1,2,3}`, and that the description-hash matches
`sha256(LUD-06 metadata)`. It does **not** verify the secp256k1 signature — that
attests the payee node signed the invoice, not that the invoice matches our
request, which is what we are checking. The signature is verified by the paying
wallet before it signs the HTLC, so an unsigned invoice is unpayable (an
availability failure) but cannot redirect funds.

- `spark-balance` → `sdk.getInfo().balanceSats`
- `spark-send` → classify the destination with `sdk.parse()`, then:
  - Lightning Address / LNURL → `sdk.prepareLnurlPay` (fees) then `sdk.lnurlPay` (signs)
  - BOLT-11 invoice / Spark address → `sdk.prepareSendPayment` (fees) then `sdk.sendPayment` (signs)
  - A Lightning Address (e.g. `alice@blink.sv`) is an LNURL-pay destination and
    MUST use the LNURL path — `prepareSendPayment` does not accept it.
- `spark-transactions` → `sdk.listPayments`
- `spark-subscribe` → `sdk.addEventListener`

`spark-send` exits **non-zero** when the SDK reports a `failed` payment status,
so automation cannot read a failed payment as success. `pending` exits zero: it
is still in flight.

**Security:** the seed grants spend authority. It is read only from
`SPARK_MNEMONIC` (never from shell rc files), and never logged or written in
readable form. The SDK's local storage dir is keyed by a non-reversible hash of
the seed.

The BIP39 checksum check **fails closed**. A word count is not validation:
twelve arbitrary dictionary words pass it, and one mistyped word then derives a
_different, valid, empty_ wallet — indistinguishable to the user from losing
their funds. If `bip39` is unavailable the command aborts
(`MNEMONIC_VALIDATOR_UNAVAILABLE`) rather than continuing unverified, because
treating "cannot check" as "checked and fine" silently disables the control.
Neither error echoes the seed.

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
