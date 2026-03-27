---
name: blink
description: Bitcoin Lightning wallet for agents — balances, invoices, payments, BTC/USD swaps, QR codes, price conversion, transaction history, and L402 auto-pay client via the Blink API. All output is JSON.
version: 1.7.0
repository: https://github.com/blinkbitcoin/blink-skill
metadata:
  oa:
    project: blink
    identifier: blink
    version: '1.4.6'
    expires_at_unix: 1798761600
    capabilities:
      - http:outbound
      - filesystem:read
      - filesystem:write
  openclaw:
    requires:
      env: [BLINK_API_KEY]
      bins: [node]
    optionalEnv: [BLINK_API_URL, BLINK_WS_URL, BLINK_L402_ROOT_KEY, BLINK_BUDGET_HOURLY_SATS, BLINK_BUDGET_DAILY_SATS, BLINK_L402_ALLOWED_DOMAINS]
    primaryEnv: BLINK_API_KEY
    emoji: '⚡'
    homepage: 'https://github.com/blinkbitcoin/blink-skill'
    security:
      secrets: ['BLINK_API_KEY']
      network: 'outbound HTTPS to api.blink.sv (or BLINK_API_URL override); outbound WSS to ws.blink.sv for subscriptions'
      filesystem: 'reads ~/.profile, ~/.bashrc, ~/.bash_profile, ~/.zshrc to locate BLINK_API_KEY export (env var checked first); writes temporary QR PNGs to /tmp; writes L402 token cache to ~/.blink/l402-tokens.json; writes budget config to ~/.blink/budget.json and spending log to ~/.blink/spending-log.json'
      persistence: 'L402 token cache at ~/.blink/l402-tokens.json; budget config at ~/.blink/budget.json; spending log at ~/.blink/spending-log.json (auto-pruned, 25h retention)'
      notes: 'Zero npm runtime dependencies. Only Node.js built-in modules used. No global installs required — scripts run standalone via node.'
---

# Blink Skill

Bitcoin Lightning wallet operations via the Blink API. Enables agents to check balances, receive payments via invoices, send payments over Lightning, track transactions, monitor prices, and automatically pay for L402-gated web services.

## What is Blink?

Blink is a custodial Bitcoin Lightning wallet with a GraphQL API. Key concepts:

- **API Key** — authentication token (format: `blink_...`) with scoped permissions (Read, Receive, Write)
- **BTC Wallet** — balance denominated in satoshis
- **USD Wallet** — balance denominated in cents (stablecoin pegged to USD)
- **Lightning Invoice** — BOLT-11 payment request string (`lnbc...`) used to receive payments
- **Lightning Address** — human-readable address (`user@domain`) for sending payments without an invoice
- **LNURL** — protocol for interacting with Lightning services via encoded URLs
- **L402** — HTTP payment protocol (RFC draft) that gates resources behind a Lightning invoice. Servers return HTTP 402 with a macaroon + invoice; clients pay and retry with the token.

## Environment

- Requires `bash` and Node.js 18+.
- Requires `BLINK_API_KEY` environment variable with appropriate scopes.
- For WebSocket subscriptions: Node 22+ (native) or Node 20+ with `--experimental-websocket`.
- Zero runtime npm dependencies. Only Node.js built-in modules are used (`node:util`, `node:fs`, `node:path`, `node:child_process`).

Use this skill for concrete wallet operations, not generic Lightning theory.

## Getting Started

### 1. Get your API key

1. Create a free account at [dashboard.blink.sv](https://dashboard.blink.sv).
2. Go to **API Keys** and create a key with the scopes you need.
3. Set it in your environment:

```bash
export BLINK_API_KEY="blink_..."
```

**API Key Scopes:**

- **Read** — query balances, transaction history, price, account info
- **Receive** — create invoices
- **Write** — send payments (use with caution)

> **Tip:** Start with Read + Receive only. Add Write when you need to send payments.

### 2. Verify it works

```bash
node {baseDir}/scripts/balance.js
```

If you see JSON with your wallet balances, you're ready.

### 3. Staging / Testnet (recommended for first-time setup)

To use the Blink staging environment (signet) instead of real money:

```bash
export BLINK_API_URL="https://api.staging.blink.sv/graphql"
```

Create a staging API key at [dashboard.staging.blink.sv](https://dashboard.staging.blink.sv). The staging environment uses signet bitcoin (no real value) — perfect for testing payment flows safely.

If `BLINK_API_URL` is not set, production (`https://api.blink.sv/graphql`) is used by default.

### API key auto-detection

Scripts automatically resolve `BLINK_API_KEY` using this order:

1. `process.env.BLINK_API_KEY` (checked first)
2. Shell rc files: `~/.profile`, `~/.bashrc`, `~/.bash_profile`, `~/.zshrc` — scanned for an `export BLINK_API_KEY=...` line only

No `source ~/.profile` prefix is needed. The rc file scan uses a targeted regex that reads only the `BLINK_API_KEY` export line — no other data is extracted from these files.

### Optional: CLI wrapper (full GitHub repo only)

If you have cloned the [full GitHub repo](https://github.com/blinkbitcoin/blink-skill), you can optionally install a `blink` CLI command:

```bash
npm install   # install dev dependencies (eslint, prettier)
npm link      # creates global 'blink' command
blink --help  # verify
```

> **Note:** `npm link` modifies global npm state. This is optional — all functionality is available by running scripts directly with `node {baseDir}/scripts/<script>.js`. The ClawHub-installed version does not require or use `npm link`.

## Agent Safety Policy

These rules are mandatory for any AI agent using this skill:

1. **Ask before spending.** Never execute `pay-invoice`, `pay-lnaddress`, `pay-lnurl`, or `swap-execute` without explicit user confirmation of the amount and recipient.
2. **Dry-run first.** For swaps, always run with `--dry-run` before executing for real unless the user explicitly says to skip it.
3. **Check balance before sending.** Always run `balance` before any payment or swap to verify sufficient funds.
4. **Probe fees before paying.** Run `fee-probe` before `pay-invoice` to show the user the fee cost.
5. **Use minimum scopes.** Only request Write-scoped API keys when send operations are actually needed.
6. **Never log or display the API key.** Treat `BLINK_API_KEY` as a secret. Do not echo it, include it in messages, or write it to files.
7. **Prefer staging for testing.** When the user is testing or learning, suggest setting `BLINK_API_URL` to the staging endpoint.
8. **Respect irreversibility.** Warn the user that Lightning payments and swaps cannot be reversed once executed.
9. **L402 auto-pay requires confirmation.** Never call `l402-pay` without dry-running first (`--dry-run`) and confirming the satoshi amount with the user. The token cache (`~/.blink/l402-tokens.json`) means subsequent calls may reuse a paid token silently — inform the user when a cached token is used.

## Bitcoin Units

- **BTC wallet** amounts are always in **satoshis** (sats). 1 BTC = 100,000,000 sats.
- **USD wallet** amounts are always in **cents**. $1.00 = 100 cents.
- When displaying amounts to users, use the formatted fields from output JSON (e.g. `btcBalanceUsdFormatted`, `usdBalanceFormatted`).
- Do not perform manual BTC-to-USD conversion math — use `blink price <sats>` or the `btcBalanceUsd` field from `balance` output instead.
- For swap amounts, the `--unit` flag controls interpretation: `sats` for BTC, `cents` for USD.

## Workflow

1. Pick the operation path first:

- Receive payments (invoice creation, QR codes, payment monitoring).
- Send payments (invoice pay, Lightning Address, LNURL, BTC or USD wallet).
- Swap between wallets (BTC <-> USD internal conversion).
- Read-only queries (balance, transactions, price, account info).

2. Configure API access from [blink-api-and-auth](references/blink-api-and-auth.md):

- Set `BLINK_API_KEY` with the correct scopes for your operation.
- Optionally set `BLINK_API_URL` for staging/testnet.
- Verify connectivity with `blink balance`.

3. For sending payments, follow [payment-operations](references/payment-operations.md):

- Check balance before sending.
- Probe fees with `blink fee-probe`.
- Choose BTC or USD wallet with `--wallet` flag.
- Execute payment and verify in transaction history.

4. For receiving payments, follow [invoice-lifecycle](references/invoice-lifecycle.md):

- Create BTC or USD invoice.
- Parse two-phase output (invoice created, then payment resolution).
- Generate QR code and send to payer.
- Monitor via auto-subscribe, polling, or standalone subscription.

5. For swapping between wallets, follow [swap-operations](references/swap-operations.md):

- Quote first with `blink swap-quote`.
- Review quote terms (amountIn/amountOut, exchange rate).
- Execute with `blink swap-execute` (use `--dry-run` first).
- Verify settlement from `postBalance`/`balanceDelta`.

6. For accessing L402-gated services:

- Discover price with `blink l402-discover <url>` (no payment needed).
- Dry-run with `blink l402-pay <url> --dry-run` and confirm cost with user.
- Pay with `blink l402-pay <url> --max-amount <sats>` (Write scope required).
- Token is cached; subsequent requests reuse it without re-paying.

7. Apply safety constraints:

- Use minimum API key scopes for the task.
- Test on staging before production.
- Always check balance before sending.
- Payments are irreversible once settled.

## Quick Commands

```bash
# Check balances
blink balance

# Create BTC invoice (auto-subscribes to payment)
blink create-invoice 1000 "Payment for service"

# Pay a Lightning invoice
blink pay-invoice lnbc1000n1...

# Pay from USD wallet
blink pay-invoice lnbc1000n1... --wallet USD

# Get current BTC/USD price
blink price

# Swap 1000 sats to USD
blink swap-execute btc-to-usd 1000

# Get swap quote without executing
blink swap-quote usd-to-btc 500 --unit cents

# Probe an L402-gated URL (discover price without paying)
blink l402-discover https://api.example.com/resource

# Pay for an L402-gated resource (dry-run first)
blink l402-pay https://api.example.com/resource --dry-run
blink l402-pay https://api.example.com/resource --max-amount 1000

# List cached L402 tokens
blink l402-store list
```

## Core Commands

### Check Wallet Balances

```bash
blink balance
```

Returns JSON with all wallet balances (BTC in sats, USD in cents), wallet IDs, pending incoming amounts, and a **pre-computed USD estimate** for the BTC wallet. Use `btcBalanceUsd` for the BTC wallet's USD value — do not calculate it yourself.

### Create Lightning Invoice (BTC)

```bash
blink create-invoice <amount_sats> [--timeout <seconds>] [--no-subscribe] [memo...]
```

Generates a BOLT-11 Lightning invoice for the specified amount in satoshis. Returns the `paymentRequest` string that can be paid by any Lightning wallet. The BTC wallet ID is resolved automatically.

**Auto-subscribe**: After creating the invoice, the script automatically opens a WebSocket subscription and waits for payment. It outputs **two JSON objects** to stdout:

1. **Immediately** — `{"event": "invoice_created", ...}` with `paymentRequest`, `paymentHash`, etc.
2. **When resolved** — `{"event": "subscription_result", "status": "PAID"|"EXPIRED"|"TIMEOUT", ...}`

The agent should read the first JSON to share the invoice/QR with the user right away, then wait for the second JSON to confirm payment.

- `amount_sats` — amount in satoshis (required)
- `--timeout <seconds>` — subscription timeout (default: 300). Use 0 for no timeout.
- `--no-subscribe` — skip WebSocket auto-subscribe, just create the invoice and exit
- `memo...` — optional description attached to the invoice (remaining args joined)

### Create Lightning Invoice (USD)

```bash
blink create-invoice-usd <amount_cents> [--timeout <seconds>] [--no-subscribe] [memo...]
```

Creates a Lightning invoice denominated in USD cents. The sender pays in BTC/Lightning, but the received amount is locked to a USD value at the current exchange rate. Credited to the USD wallet. **Expires in ~5 minutes** due to exchange rate lock.

**Auto-subscribe**: Same two-phase output as `create-invoice` — first JSON is the created invoice, second JSON is the payment resolution (PAID/EXPIRED/TIMEOUT).

- `amount_cents` — amount in USD cents, e.g. 100 = $1.00 (required)
- `--timeout <seconds>` — subscription timeout (default: 300). Use 0 for no timeout.
- `--no-subscribe` — skip WebSocket auto-subscribe, just create the invoice and exit
- `memo...` — optional description attached to the invoice (remaining args joined)

### Check Invoice Status

```bash
blink check-invoice <payment_hash>
```

Checks the payment status of a Lightning invoice by its payment hash. Use after creating an invoice to detect when it has been paid. Returns status: `PAID`, `PENDING`, or `EXPIRED`.

- `payment_hash` — the 64-char hex payment hash from `create-invoice` output (required)

### Pay Lightning Invoice

```bash
blink pay-invoice <bolt11_invoice> [--wallet BTC|USD]
```

Pays a BOLT-11 Lightning invoice from the BTC or USD wallet. Returns payment status: `SUCCESS`, `PENDING`, `FAILURE`, or `ALREADY_PAID`. The wallet ID is resolved automatically.

- `bolt11_invoice` — the BOLT-11 payment request string, e.g. `lnbc...` (required)
- `--wallet BTC|USD` — wallet to pay from (default: BTC). When USD is selected, the Blink API debits the USD equivalent from the USD wallet.

**Requires Write scope on the API key.**

> **AGENT:** This command spends funds. Always run `balance` and `fee-probe` first, then confirm amount and recipient with the user before executing.

### Pay to Lightning Address

```bash
blink pay-lnaddress <lightning_address> <amount_sats> [--wallet BTC|USD]
```

Sends satoshis to a Lightning Address (e.g. `user@blink.sv`). Returns payment status. The wallet ID is resolved automatically.

- `lightning_address` — recipient in `user@domain` format (required)
- `amount_sats` — amount in satoshis (required)
- `--wallet BTC|USD` — wallet to pay from (default: BTC). When USD is selected, the amount is still specified in satoshis; the Blink API debits the USD equivalent from the USD wallet automatically.

**Requires Write scope on the API key.**

> **AGENT:** This command spends funds. Always run `balance` first, confirm the Lightning Address and amount with the user, then execute.

### Pay to LNURL

```bash
blink pay-lnurl <lnurl> <amount_sats> [--wallet BTC|USD]
```

Sends satoshis to a raw LNURL payRequest string. For Lightning Addresses (`user@domain`), use `pay-lnaddress` instead.

- `lnurl` — LNURL string, e.g. `lnurl1...` (required)
- `amount_sats` — amount in satoshis (required)
- `--wallet BTC|USD` — wallet to pay from (default: BTC). When USD is selected, the amount is still specified in satoshis; the Blink API debits the USD equivalent from the USD wallet automatically.

**Requires Write scope on the API key.**

> **AGENT:** This command spends funds. Always run `balance` first, confirm the LNURL and amount with the user, then execute.

### Estimate Payment Fee

```bash
blink fee-probe <bolt11_invoice> [--wallet BTC|USD]
```

Estimates the fee for paying a Lightning invoice without actually sending. Use before `pay-invoice` to check costs. Payments to other Blink users and direct-channel nodes are free (0 sats).

- `bolt11_invoice` — the BOLT-11 payment request string (required)
- `--wallet BTC|USD` — wallet to probe from (default: BTC). When USD is selected, uses `lnUsdInvoiceFeeProbe` to estimate fees from the USD wallet's perspective.

### Render Invoice QR Code

```bash
blink qr <bolt11_invoice>
```

Renders a terminal QR code for a Lightning invoice (BOLT-11) to stderr and generates a **PNG image file** to `/tmp`. The stdout JSON includes a `pngPath` field with the absolute path to the PNG file.

**Sending the QR image to a user**: After running this script, use the `pngPath` from the JSON output to send the PNG as a media attachment to the user in the current chat. The agent should use its native message-send capability with the file path.

- `bolt11_invoice` — the BOLT-11 payment request string (required)

Output JSON includes:

- `invoice` — uppercased invoice string
- `qrRendered` — always `true`
- `qrSize` — QR module count
- `errorCorrection` — `"L"` (LOW)
- `pngPath` — absolute path to the generated PNG file (e.g. `/tmp/blink_qr_1234567890.png`)
- `pngBytes` — file size in bytes

### List Transactions

```bash
blink transactions [--first N] [--after CURSOR] [--wallet BTC|USD]
```

Lists recent transactions (incoming and outgoing) with pagination. Returns direction, amount, status, type (lightning/onchain/intraledger), and metadata.

- `--first N` — number of transactions to return (default: 20, max: 100)
- `--after CURSOR` — pagination cursor from previous response's `endCursor`
- `--wallet BTC|USD` — filter to a specific wallet currency

### Get BTC/USD Price

```bash
blink price [amount_sats]
blink price --usd <amount_usd>
blink price --history <range>
blink price --currencies
```

Multi-purpose exchange rate tool. All price queries are **public (no API key required)**, though the key is sent if available.

**Modes:**

- **No args** — current BTC/USD price and sats-per-dollar rate
- **`<amount_sats>`** — convert a satoshi amount to USD (e.g. `blink price 1760` → `$1.20`)
- **`--usd <amount>`** — convert a USD amount to sats (e.g. `blink price --usd 5.00` → `7350 sats`)
- **`--history <range>`** — historical BTC price data with summary stats (high/low/change). Ranges: `ONE_DAY`, `ONE_WEEK`, `ONE_MONTH`, `ONE_YEAR`, `FIVE_YEARS`
- **`--currencies`** — list all supported display currencies (IDs, names, symbols, flags)

### Account Info

```bash
blink account-info
```

Shows account level, spending limits (withdrawal, internal send, convert), default wallet, and wallet summary with **pre-computed USD estimates** for BTC balances. Limits are denominated in USD cents with a rolling 24-hour window.

## Realtime Subscriptions

Blink supports GraphQL subscriptions over WebSocket using the `graphql-transport-ws` protocol. Requires Node 22+ for native WebSocket, or Node 20+ with the `--experimental-websocket` flag.

### Subscribe to Invoice Payment Status

```bash
blink subscribe-invoice <bolt11_invoice> [--timeout <seconds>]
```

Watches a single invoice and exits when it is **PAID** or **EXPIRED**. Status updates are printed to stderr. JSON result is printed to stdout.

### Subscribe to Account Updates (myUpdates)

```bash
blink subscribe-updates [--timeout <seconds>] [--max <count>]
```

Streams account updates in real time. Each event is output as a JSON line (NDJSON) to stdout. Use `--max` to stop after N events.

## API Reference

| Operation          | GraphQL                                     | Scope Required    |
| ------------------ | ------------------------------------------- | ----------------- |
| Check balance      | `query me` + `currencyConversionEstimation` | Read              |
| Create BTC invoice | `mutation lnInvoiceCreate`                  | Receive           |
| Create USD invoice | `mutation lnUsdInvoiceCreate`               | Receive           |
| Check invoice      | `query invoiceByPaymentHash`                | Read              |
| Pay invoice        | `mutation lnInvoicePaymentSend`             | Write             |
| Pay LN address     | `mutation lnAddressPaymentSend`             | Write             |
| Pay LNURL          | `mutation lnurlPaymentSend`                 | Write             |
| Fee estimate (BTC) | `mutation lnInvoiceFeeProbe`                | Read              |
| Fee estimate (USD) | `mutation lnUsdInvoiceFeeProbe`             | Read              |
| Swap BTC→USD       | `mutation intraLedgerPaymentSend`           | Write             |
| Swap USD→BTC       | `mutation intraLedgerUsdPaymentSend`        | Write             |
| Transactions       | `query transactions`                        | Read              |
| Price / convert    | `query currencyConversionEstimation`        | **None (public)** |
| Price history      | `query btcPriceList`                        | **None (public)** |
| Currency list      | `query currencyList`                        | **None (public)** |
| Realtime price     | `query realtimePrice`                       | **None (public)** |
| Account info       | `query me` + `currencyConversionEstimation` | Read              |
| Subscribe invoice  | `subscription lnInvoicePaymentStatus`       | Read              |
| Subscribe updates  | `subscription myUpdates`                    | Read              |
| L402 discover      | external HTTP (no Blink API)                | **None**          |
| L402 pay           | `mutation lnInvoicePaymentSend` (on 402)    | Write             |

**API Endpoint:** `https://api.blink.sv/graphql` (production)
**Authentication:** `X-API-KEY` header

**USD wallet notes:** The `lnInvoicePaymentSend`, `lnAddressPaymentSend`, and `lnurlPaymentSend` mutations all accept either a BTC or USD wallet ID. When a USD wallet ID is provided, the API debits the USD equivalent automatically. Amounts for `lnAddressPaymentSend` and `lnurlPaymentSend` are always specified in satoshis regardless of wallet type.

## Output Format

All commands output structured JSON to stdout. Status messages and errors go to stderr. Exit code 0 on success, 1 on failure.

### Balance output example

```json
{
  "wallets": [
    { "id": "abc123", "currency": "BTC", "balance": 1760, "unit": "sats" },
    { "id": "def456", "currency": "USD", "balance": 1500, "unit": "cents" }
  ],
  "btcWalletId": "abc123",
  "btcBalance": 1760,
  "btcBalanceSats": 1760,
  "btcBalanceUsd": 1.2,
  "btcBalanceUsdFormatted": "$1.20",
  "usdWalletId": "def456",
  "usdBalance": 1500,
  "usdBalanceCents": 1500,
  "usdBalanceFormatted": "$15.00"
}
```

### Invoice creation output example (two-phase)

First JSON (immediate):

```json
{
  "event": "invoice_created",
  "paymentRequest": "lnbc500n1...",
  "paymentHash": "abc123...",
  "satoshis": 500,
  "status": "PENDING",
  "createdAt": "2026-02-23T00:00:00Z",
  "walletId": "abc123"
}
```

Second JSON (when payment resolves):

```json
{
  "event": "subscription_result",
  "paymentRequest": "lnbc500n1...",
  "status": "PAID",
  "isPaid": true,
  "isExpired": false,
  "isPending": false
}
```

### Invoice status output example

```json
{
  "paymentHash": "abc123...",
  "paymentStatus": "PAID",
  "satoshis": 500,
  "isPaid": true,
  "isExpired": false,
  "isPending": false
}
```

### Payment output example (BTC wallet)

```json
{
  "status": "SUCCESS",
  "walletId": "abc123",
  "walletCurrency": "BTC",
  "balanceBefore": 50000
}
```

### Payment output example (USD wallet)

```json
{
  "status": "SUCCESS",
  "walletId": "def456",
  "walletCurrency": "USD",
  "balanceBefore": 1500,
  "balanceBeforeFormatted": "$15.00"
}
```

### Price output example

```json
{
  "btcPriceUsd": 68036.95,
  "satsPerDollar": 1470,
  "conversion": {
    "sats": 1760,
    "usd": 1.2,
    "usdFormatted": "$1.20"
  }
}
```

### USD-to-sats conversion output example

```json
{
  "btcPriceUsd": 68036.95,
  "satsPerDollar": 1470,
  "conversion": {
    "usd": 5.0,
    "usdFormatted": "$5.00",
    "sats": 7350
  }
}
```

### Price history output example

```json
{
  "range": "ONE_DAY",
  "dataPoints": 24,
  "summary": {
    "current": 68036.95,
    "oldest": 67500.0,
    "high": 68500.0,
    "low": 67200.0,
    "changeUsd": 536.95,
    "changePct": 0.8
  },
  "prices": [{ "timestamp": 1740000000, "date": "2025-02-20T00:00:00.000Z", "btcPriceUsd": 67500.0 }]
}
```

### Transaction list output example

```json
{
  "transactions": [
    {
      "id": "tx_123",
      "direction": "RECEIVE",
      "status": "SUCCESS",
      "amount": 1000,
      "currency": "BTC",
      "type": "lightning",
      "paymentHash": "abc...",
      "createdAt": 1740000000
    }
  ],
  "count": 1,
  "pageInfo": {
    "hasNextPage": false,
    "endCursor": "cursor_abc"
  }
}
```

## Typical Agent Workflows

### Receive a payment (recommended — auto-subscribe + QR image)

```bash
# 1. Create invoice — script auto-subscribes and outputs two JSON objects
blink create-invoice 1000 "Payment for service"
# → First JSON: {"event": "invoice_created", "paymentRequest": "lnbc...", ...}
# → Read paymentRequest from first JSON immediately

# 2. Generate QR code PNG
blink qr <paymentRequest>
# → JSON includes "pngPath": "/tmp/blink_qr_123456.png"
# → Send the PNG file to the user as a media attachment in the current chat

# 3. The create-invoice command is still running, waiting for payment
# → Second JSON: {"event": "subscription_result", "status": "PAID", ...}
# → When PAID: notify the user that payment has been received
# → When EXPIRED: notify the user the invoice expired
```

**Important**: The `create-invoice` command outputs two JSON objects separated by a newline. Parse them as separate JSON objects, not as a single JSON array. The first object arrives immediately; the second arrives when payment status resolves.

### Receive a payment (polling fallback)

```bash
# 1. Create invoice without auto-subscribe
blink create-invoice 1000 --no-subscribe "Payment for service"
# 2. Give the paymentRequest to the payer
# 3. Poll for payment
blink check-invoice <payment_hash>
# 4. Verify balance
blink balance
```

### Receive a USD payment

```bash
# Same two-phase pattern as BTC, but using create-invoice-usd
# Note: USD invoices expire in ~5 minutes
blink create-invoice-usd 500 "Five dollars for service"
# → First JSON: {"event": "invoice_created", "amountCents": 500, "amountUsd": "$5.00", ...}
# Generate QR and send to user, then wait for second JSON
```

### Send a payment (with fee check)

```bash
# 1. Check current balance
blink balance
# 2. Estimate fee
blink fee-probe lnbc1000n1...
# 3. Send payment
blink pay-invoice lnbc1000n1...
# 4. Verify in transaction history
blink transactions --first 1
```

### Send from the USD wallet

```bash
# Pay an invoice from the USD wallet
blink fee-probe lnbc1000n1... --wallet USD
blink pay-invoice lnbc1000n1... --wallet USD

# Send to a Lightning Address from the USD wallet
blink pay-lnaddress user@blink.sv 1000 --wallet USD

# Send via LNURL from the USD wallet
blink pay-lnurl lnurl1... 1000 --wallet USD

# Note: for lnaddress and lnurl, the amount is always in satoshis.
# The Blink API debits the USD equivalent from the USD wallet automatically.
```

### Convert sats to USD value

```bash
# Check how much 1760 sats is worth in USD
blink price 1760
# → $1.20
```

### Convert USD to sats

```bash
# How many sats is $5.00?
blink price --usd 5.00
# → 7350 sats
```

### Swap BTC to USD (internal conversion)

```bash
# 1. Get a quote first
blink swap-quote btc-to-usd 2000
# → Shows expected conversion terms (amountIn: 2000 sats, amountOut: ~136 cents)

# 2. Execute the swap (dry-run first)
blink swap-execute btc-to-usd 2000 --dry-run
# → Shows what would happen without moving funds

# 3. Execute for real
blink swap-execute btc-to-usd 2000
# → Converts 2000 sats from BTC wallet to ~$1.36 in USD wallet

# 4. Verify balances
blink balance
```

### Swap USD to BTC (internal conversion)

```bash
# Convert $5.00 (500 cents) to BTC
blink swap-execute usd-to-btc 500 --unit cents
# → Converts 500 cents from USD wallet to ~7350 sats in BTC wallet
```

### Pay for an L402-gated service

```bash
# 1. Discover what the service costs (no payment)
blink l402-discover https://api.example.com/resource
# → shows satoshis, format, macaroon

# 2. Dry-run to confirm price with user before spending
blink l402-pay https://api.example.com/resource --dry-run
# → {"event": "l402_dry_run", "satoshis": 100, ...}

# 3. Check your balance first
blink balance

# 4. Pay (with optional safety limit)
blink l402-pay https://api.example.com/resource --max-amount 500
# → pays invoice, caches token, returns resource data

# 5. Subsequent calls reuse cached token (no re-payment)
blink l402-pay https://api.example.com/resource
# → {"event": "l402_paid", "tokenReused": true, ...}
```

### Check price history

```bash
# Get BTC price over the last 24 hours
blink price --history ONE_DAY
# Get BTC price over the last month
blink price --history ONE_MONTH
```

## Swap Commands (BTC <-> USD)

Swap between your BTC and USD wallets using Blink's intra-ledger transfer. This is an internal conversion (not a Lightning payment), so there are no routing fees — only minor rounding spread.

### Get Swap Quote

```bash
blink swap-quote <direction> <amount> [--unit sats|cents] [--ttl-seconds N] [--immediate]
```

Estimates the conversion terms without moving funds. Returns wallet balances, exchange rate snapshot, and the expected `amountIn`/`amountOut` in the output JSON.

- `direction` — `btc-to-usd` or `usd-to-btc` (aliases: `sell-btc`, `buy-usd`, `sell-usd`, `buy-btc`)
- `amount` — positive integer amount to convert
- `--unit sats|cents` — unit of the amount (defaults to `sats` for btc-to-usd, `cents` for usd-to-btc)
- `--ttl-seconds N` — quote TTL in seconds (default: 60)
- `--immediate` — flag the quote for immediate execution

**No API key scope beyond Read is required for quotes.**

### Execute Swap

```bash
blink swap-execute <direction> <amount> [--unit sats|cents] [--dry-run] [--memo "text"]
```

Executes a real BTC <-> USD conversion. First generates a quote, then performs the intra-ledger transfer. Returns pre/post balances, delta, quote terms, and transaction ID.

- `direction` — same as swap-quote
- `amount` — positive integer amount to convert
- `--unit sats|cents` — same as swap-quote
- `--dry-run` — show what would be swapped without executing the transfer
- `--memo "text"` — optional memo attached to the transaction

**CAUTION: Without `--dry-run`, this moves real funds between wallets. Requires Write scope.**

> **AGENT:** This command moves funds between wallets. Always run with `--dry-run` first, show the quote to the user, and get explicit confirmation before executing without `--dry-run`.

### Swap Output Examples

**Quote output:**

```json
{
  "event": "swap_quote",
  "dryRun": true,
  "direction": "BTC_TO_USD",
  "preBalance": {
    "btcWalletId": "abc123",
    "usdWalletId": "def456",
    "btcBalanceSats": 50000,
    "usdBalanceCents": 1500,
    "usdBalanceFormatted": "$15.00"
  },
  "quote": {
    "quoteId": "blink-swap-1709424000-123456",
    "direction": "BTC_TO_USD",
    "requestedAmount": { "value": 1000, "unit": "sats" },
    "amountIn": { "value": 1000, "unit": "sats" },
    "amountOut": { "value": 68, "unit": "cents" },
    "feeSats": 0,
    "feeBps": 0,
    "rateSnapshot": { "satsPerDollar": 1470 },
    "executionPath": "blink:intraLedgerPaymentSend"
  }
}
```

**Execution output:**

```json
{
  "event": "swap_execution",
  "dryRun": false,
  "direction": "BTC_TO_USD",
  "status": "SUCCESS",
  "succeeded": true,
  "preBalance": { "btcBalanceSats": 50000, "usdBalanceCents": 1500 },
  "postBalance": { "btcBalanceSats": 49000, "usdBalanceCents": 1567 },
  "balanceDelta": { "btcDeltaSats": -1000, "usdDeltaCents": 67 },
  "execution": {
    "path": "blink:intraLedgerPaymentSend",
    "transactionId": "tx_abc123"
  }
}
```

## L402 Client Commands

L402 is an HTTP payment protocol: a server returns HTTP 402 with a Lightning invoice, the client pays, and retries the request with a proof-of-payment token. This skill can act as an L402 client.

Supports two L402 formats:

- **Lightning Labs** — `WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."`
- **l402-protocol.org** — JSON body with `payment_request_url` and `offers` array

### Discover L402 Pricing (no payment)

```bash
blink l402-discover <url> [--method GET|POST] [--header key:value]
```

Probes a URL for L402 payment requirements without paying. Returns the detected format, invoice, and decoded satoshi amount.

- `url` — the URL to probe (required)
- `--method GET|POST` — HTTP method to use (default: GET)
- `--header key:value` — extra request header (repeatable)

**No API key required for discovery.**

Known public L402 endpoints for testing (use specific paths, not root URLs):

- `https://l402.services/geoip/8.8.8.8` — GeoIP lookup, 1 sat, Lightning Labs format
- `https://www.l402apps.com/api/apis` — L402 API directory, 10 sats, Lightning Labs format

### Pay for an L402-Gated Resource

```bash
blink l402-pay <url> [options]
```

Makes an HTTP request. If the server returns 402, automatically parses the challenge, pays the invoice via Blink, caches the token, and retries with the payment proof.

- `url` — URL to access (required)
- `--wallet BTC|USD` — wallet to pay from (default: BTC)
- `--max-amount <sats>` — refuse to pay more than N sats (safety limit)
- `--dry-run` — discover price without paying; always bypasses the token cache so the current invoice price is always shown even if a cached token exists
- `--method GET|POST|PUT|DELETE|PATCH` — HTTP method (default: GET)
- `--header key:value` — extra request header (repeatable)
- `--body <string>` — request body for POST/PUT
- `--no-store` — disable token cache (do not read or write `~/.blink/l402-tokens.json`)
- `--force` — pay even if a valid cached token exists
- `--probe` — run a fee probe (`lnInvoiceFeeProbe`) before paying to estimate routing fees; warns and continues if the probe fails; adds a `feeProbe` field to the `l402_paid` output

**Requires Write scope on the API key.**

> **AGENT:** Always run with `--dry-run` first to show the satoshi cost to the user. Confirm the amount and target URL before executing without `--dry-run`.

### Manage Token Cache

```bash
blink l402-store list
blink l402-store get <domain>
blink l402-store clear [--expired]
```

- `list` — show all cached tokens (masks preimage for security)
- `get <domain>` — retrieve the full token for a specific domain
- `clear` — remove all cached tokens
- `clear --expired` — remove only expired tokens

Token cache location: `~/.blink/l402-tokens.json`

### L402 Output Examples

**l402-discover (Lightning Labs format):**

```json
{
  "url": "https://api.example.com/resource",
  "l402_detected": true,
  "format": "lightning-labs",
  "macaroon": "AgELZXhhbXBsZS...",
  "invoice": "lnbc1000n1...",
  "satoshis": 100,
  "satoshisFormatted": "100 sats"
}
```

**l402-pay (dry-run):**

```json
{
  "event": "l402_dry_run",
  "url": "https://api.example.com/resource",
  "format": "lightning-labs",
  "invoice": "lnbc1000n1...",
  "satoshis": 100,
  "satoshisFormatted": "100 sats",
  "maxAmount": 1000,
  "withinBudget": true,
  "message": "Dry-run: would pay this invoice to access the resource. No payment made."
}
```

**l402-pay (after payment):**

```json
{
  "event": "l402_paid",
  "url": "https://api.example.com/resource",
  "format": "lightning-labs",
  "paymentStatus": "SUCCESS",
  "walletId": "abc123",
  "walletCurrency": "BTC",
  "satoshis": 100,
  "tokenReused": false,
  "retryStatus": 200,
  "data": { "...": "response from the protected resource" }
}
```

**l402-pay (after payment, with --probe):**

```json
{
  "event": "l402_paid",
  "url": "https://api.example.com/resource",
  "format": "lightning-labs",
  "paymentStatus": "SUCCESS",
  "walletId": "abc123",
  "walletCurrency": "BTC",
  "satoshis": 100,
  "tokenReused": false,
  "retryStatus": 200,
  "feeProbe": {
    "estimatedFeeSats": 1,
    "error": null
  },
  "data": { "...": "response from the protected resource" }
}
```

## L402 Producer Commands

L402 producer tools let you **protect your own API resources** behind a Lightning paywall. Issue challenges to clients, then verify their payment proofs before granting access.

Two-step workflow:

1. When a client requests a resource, call `blink l402-challenge` to create a signed payment challenge and return it with HTTP 402.
2. When the client submits a payment token, call `blink l402-verify` to verify the preimage and macaroon signature.

> **Note:** End-to-end round-trip testing (challenge → pay → verify) requires **two separate Blink accounts**. Blink does not allow paying your own invoice (CANT_PAY_SELF). Use a second account or wallet to pay the challenge invoice during testing.

### Create an L402 Challenge

```bash
blink l402-challenge --amount <sats> [options]
```

Creates a Lightning invoice via Blink and issues a signed macaroon bound to its payment hash. Returns a ready-to-send `WWW-Authenticate` header.

- `--amount <sats>` — invoice amount in satoshis (required)
- `--wallet <id>` — Blink BTC wallet ID (auto-resolved if omitted)
- `--memo <text>` — invoice memo / description
- `--expiry <seconds>` — macaroon caveat expiry (e.g. `3600` = 1 hour); controls how long the challenge is valid, not the invoice expiry
- `--resource <id>` — resource identifier caveat (e.g. `/api/v1/data`); returned tokens will only be valid for this exact path

**Requires Write scope on the API key.**

Root key for HMAC signing resolves in this order:

1. `BLINK_L402_ROOT_KEY` env var (64-char hex, 32 bytes)
2. `~/.blink/l402-root-key` (auto-created on first run)

> **AGENT:** Keep `BLINK_L402_ROOT_KEY` or `~/.blink/l402-root-key` stable across server restarts. A different root key will invalidate all previously issued macaroons.

### Verify an L402 Payment Token

```bash
blink l402-verify --token <macaroon>:<preimage> [options]
blink l402-verify --macaroon <b64> --preimage <hex> [options]
```

Verifies a client-submitted L402 `Authorization` token. Performs three layers of verification:

1. **Preimage check:** `SHA-256(preimage) === payment_hash` — cryptographic proof the invoice was paid
2. **Signature check:** HMAC-SHA256 of macaroon body — proves the macaroon was issued by this server
3. **Caveat check:** expiry not exceeded, resource matches if constrained

- `--token <macaroon>:<preimage>` — L402 authorization token (colon-separated, from `Authorization: L402 <token>` header)
- `--macaroon <b64>` — base64url-encoded macaroon (alternative to `--token`)
- `--preimage <hex>` — 64-char hex preimage (alternative to `--token`)
- `--resource <id>` — expected resource identifier to check against the macaroon's resource caveat
- `--check-api` — additionally query the Blink API to confirm PAID status (belt-and-suspenders)

Exit code `0` when `valid: true`, exit code `1` when `valid: false` or on error.

> **Note:** The `--preimage` value must be a 64-character hex string (32 bytes). Passing a plain string like `fake_preimage` will produce an error explaining the format requirement. For testing rejection, use a valid-format but wrong preimage: 64 zeros (`0000...0000`).

### L402 Producer Output Examples

**l402-challenge:**

```json
{
  "header": "L402 macaroon=\"AgEL...\", invoice=\"lnbc100n1...\"",
  "macaroon": "AgEL...",
  "invoice": "lnbc100n1...",
  "paymentHash": "abc123...64hex",
  "satoshis": 100,
  "expiresAt": 1735689600,
  "resource": "/api/v1/data"
}
```

Return this to clients as:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="AgEL...", invoice="lnbc100n1..."
```

**l402-verify (valid payment):**

```json
{
  "valid": true,
  "preimageValid": true,
  "signatureValid": true,
  "caveatsValid": true,
  "paymentHash": "abc123...64hex",
  "resource": "/api/v1/data",
  "expiresAt": 1735689600,
  "expired": false,
  "apiStatus": "NOT_CHECKED"
}
```

**l402-verify (invalid — wrong preimage):**

```json
{
  "valid": false,
  "preimageValid": false,
  "signatureValid": true,
  "caveatsValid": true,
  "paymentHash": "abc123...64hex",
  "resource": null,
  "expiresAt": null,
  "expired": false,
  "apiStatus": "NOT_CHECKED"
}
```

## L402 Service Discovery

Find L402-gated APIs that agents can pay for and access. Two directory sources:

- **l402.directory** (default) — curated registry with rich endpoint schemas, pricing, and consumption instructions
- **402index.io** — broader coverage (50+ services), simpler flat schema

### Search Services

```bash
blink l402-search                              # all live services from l402.directory
blink l402-search video                        # keyword search
blink l402-search --category data              # filter by category
blink l402-search --status all                 # include offline/new services
blink l402-search --format minimal             # compact output
blink l402-search ai --source 402index         # search 402index.io instead
```

**No API key required** — both directories have free browse APIs.

> **AGENT:** Use `l402-search` to find services before using `l402-pay`. Check pricing in the results before paying.

### Get Service Details

```bash
blink l402-info <service_id>                   # full details (free, l402.directory)
blink l402-info <service_id> --report          # paid health report (10 sats via L402)
blink l402-info <service_id> --report --force  # bypass budget/domain checks
```

- Without `--report`: free, returns endpoints, pricing, consumption instructions
- With `--report`: 10 sats, returns uptime percentages, probe history, response times
- `--report` is subject to budget controls and domain allowlist (domain: `l402.directory`)

### Discovery Output Example

```json
{
  "source": "l402.directory",
  "query": "video",
  "count": 1,
  "services": [
    {
      "service_id": "71adb942293c89f6",
      "name": "Hyperdope Video",
      "description": "Lightning-gated video streaming...",
      "status": "live",
      "categories": ["video", "streaming"],
      "endpoints": [
        {
          "url": "https://hyperdope.com/api/l402/videos/{hash}/master.m3u8",
          "method": "GET",
          "pricing": { "amount": 10, "currency": "sats", "model": "per-request" }
        }
      ]
    }
  ]
}
```

## Budget Controls

Prevent runaway spending in autonomous agent workflows with rolling spend limits and domain allowlist.

### Configuration

Env vars take precedence over the config file (`~/.blink/budget.json`):

| Env var | Config file key | Default | Description |
|---------|----------------|---------|-------------|
| `BLINK_BUDGET_HOURLY_SATS` | `hourlyLimitSats` | none (unlimited) | Max sats in rolling 1-hour window |
| `BLINK_BUDGET_DAILY_SATS` | `dailyLimitSats` | none (unlimited) | Max sats in rolling 24-hour window |
| `BLINK_L402_ALLOWED_DOMAINS` | `allowlist` | none (all allowed) | Comma-separated domains for L402 auto-pay |

If no env vars and no config file exist, no limits are enforced (fully backward compatible).

### Budget Commands

```bash
blink budget status                              # Show current spend vs limits
blink budget set --hourly 1000 --daily 5000      # Set spending limits
blink budget set --off                           # Remove all limits
blink budget log [--last 10]                     # Show recent spending entries
blink budget reset                               # Clear spending history
blink budget allowlist list                      # Show allowed L402 domains
blink budget allowlist add satring.com           # Add domain to allowlist
blink budget allowlist remove satring.com        # Remove domain from allowlist
```

### Budget Status Output Example

```json
{
  "enabled": true,
  "hourlyLimit": 1000,
  "dailyLimit": 5000,
  "hourlySpent": 350,
  "dailySpent": 1200,
  "hourlyRemaining": 650,
  "dailyRemaining": 3800,
  "effectiveRemaining": 650,
  "allowlist": ["satring.com", "l402.services"],
  "logEntries": 8
}
```

`effectiveRemaining` = min(hourlyRemaining, dailyRemaining) — the actual amount the agent can spend right now.

### How Budget Enforcement Works

- **Checked before every outbound payment:** `pay-invoice`, `pay-lnaddress`, `pay-lnurl`, `l402-pay`
- **Domain allowlist:** checked for `l402-pay` only — blocks auto-pay to unlisted domains
- **`--force` bypasses budget:** existing `--force` flag on payment commands skips budget check
- **`--dry-run` shows budget impact:** dry-run output includes a `budget` field showing remaining budget
- **Spending recorded after success:** only successful/pending payments are logged
- **Auto-pruning:** log entries older than 25 hours are removed automatically

> **AGENT:** Before making a payment, check budget status with `blink budget status` to see remaining budget. If budget is exceeded, inform the user and suggest increasing limits with `blink budget set`.

## Security

### API Key Handling

- **Your API key is your wallet access** — anyone with a Write-scoped key can spend your entire balance.
- **Use minimum scopes** — Read-only for balance checks, Receive for invoices, Write only when sending.
- **Never expose keys in output** — do not echo, log, or include `BLINK_API_KEY` in chat messages or files.
- Keys are for server-side / agent use only. Never embed in client-side code.

### What Data Leaves the Machine

- **Outbound HTTPS** to `api.blink.sv` (or `BLINK_API_URL` override) for all GraphQL queries and mutations.
- **Outbound WSS** to `ws.blink.sv` (or `BLINK_WS_URL` override) for subscription WebSockets.
- **L402 requests** go directly to the third-party URL you provide to `l402-discover` or `l402-pay`. The Blink API is contacted only when a payment is needed.
- **No other network calls.** Scripts do not phone home, send telemetry, or contact any undisclosed third-party services.

### Filesystem Access

- **RC file reading:** If `BLINK_API_KEY` is not found in `process.env`, the client scans `~/.profile`, `~/.bashrc`, `~/.bash_profile`, and `~/.zshrc` for a line matching `export BLINK_API_KEY=...`. Only the value of that specific export is extracted — no other data is read from these files. The environment variable is always checked first.
- **QR PNG generation:** The `qr` command writes temporary PNG files to `/tmp/blink_qr_*.png`. These are standard image files with no embedded metadata beyond the QR content.
- **L402 token cache:** The `l402-pay` command writes paid tokens to `~/.blink/l402-tokens.json`. This file contains macaroons and preimages for previously-paid L402 services. Use `blink l402-store clear` to remove all cached tokens. Pass `--no-store` to disable caching entirely.
- **Budget files:** Budget config at `~/.blink/budget.json` and spending log at `~/.blink/spending-log.json`. The spending log is auto-pruned (entries older than 25h removed). Use `blink budget reset` to clear the log.

### Stateless Design

Most scripts are stateless. Exceptions:
- `l402-pay` maintains a token cache at `~/.blink/l402-tokens.json` to avoid re-paying for previously-accessed L402 services. Use `--no-store` to run without any persistence.
- All payment commands (`pay-invoice`, `pay-lnaddress`, `pay-lnurl`, `l402-pay`) log spending to `~/.blink/spending-log.json` for budget enforcement. This log is auto-pruned and can be cleared with `blink budget reset`.

### Payment Safety

- **Sending is irreversible** — Lightning payments cannot be reversed once settled.
- **Test on staging first** — use `BLINK_API_URL=https://api.staging.blink.sv/graphql` to point at the signet staging environment with test funds.
- **USD invoices expire fast** — ~5 minutes due to exchange rate lock.
- **Price queries are public** — `blink price` works without an API key; only wallet operations require authentication.
- **L402 preimage resolution** — After payment, `l402-pay` retrieves the preimage inline from the mutation response (`settlementVia.preImage`). If the inline preimage is unavailable (e.g. race condition or network issue), it falls back to a `transactions` query matched by payment hash. If the transaction is not yet indexed, it falls back to a SHA-256(invoice) placeholder, which works with servers using token-based verification but may fail with servers that cryptographically verify the preimage against the payment hash.

## Reference Files

- [blink-api-and-auth](references/blink-api-and-auth.md): API endpoints, authentication, scopes, staging/testnet configuration, and error handling.
- [payment-operations](references/payment-operations.md): send workflows, BTC vs USD wallet selection, fee probing, and safety guardrails.
- [invoice-lifecycle](references/invoice-lifecycle.md): invoice creation, two-phase output parsing, monitoring strategies, QR generation, and expiration handling.
- [swap-operations](references/swap-operations.md): BTC <-> USD internal conversion, quote/execute workflow, rounding behavior, and effective cost formulas.
- [Blink Agent Playbook](https://dev.blink.sv/api/agent-playbook): Canonical AI agent API reference — order of operations, safety constraints, and verification checklist.
- [llms.txt](https://dev.blink.sv/llms.txt): Machine-readable discovery metadata for AI agents (endpoints, source URLs, hard rules).

## Files

- `{baseDir}/scripts/balance.js` — Check wallet balances
- `{baseDir}/scripts/create_invoice.js` — Create BTC Lightning invoices (auto-subscribes to payment status)
- `{baseDir}/scripts/create_invoice_usd.js` — Create USD-denominated Lightning invoices (auto-subscribes to payment status)
- `{baseDir}/scripts/check_invoice.js` — Check invoice payment status (polling)
- `{baseDir}/scripts/pay_invoice.js` — Pay BOLT-11 invoices (BTC or USD wallet)
- `{baseDir}/scripts/pay_lnaddress.js` — Pay to Lightning Addresses (BTC or USD wallet)
- `{baseDir}/scripts/pay_lnurl.js` — Pay to LNURL strings (BTC or USD wallet)
- `{baseDir}/scripts/fee_probe.js` — Estimate payment fees (BTC or USD wallet)
- `{baseDir}/scripts/qr_invoice.js` — Render invoice QR code (terminal + PNG file)
- `{baseDir}/scripts/transactions.js` — List transaction history
- `{baseDir}/scripts/price.js` — Get BTC/USD exchange rate
- `{baseDir}/scripts/account_info.js` — Show account info and limits
- `{baseDir}/scripts/subscribe_invoice.js` — Subscribe to invoice payment status (standalone)
- `{baseDir}/scripts/subscribe_updates.js` — Subscribe to realtime account updates
- `{baseDir}/scripts/_swap_common.js` — Shared swap helpers (quote estimation, execution, wallet pair management)
- `{baseDir}/scripts/swap_quote.js` — Get BTC <-> USD conversion quote
- `{baseDir}/scripts/swap_execute.js` — Execute BTC <-> USD wallet conversion
- `{baseDir}/scripts/l402_discover.js` — Probe a URL for L402 payment requirements (no payment)
- `{baseDir}/scripts/l402_pay.js` — Auto-pay L402-gated resources via Blink + token caching
- `{baseDir}/scripts/l402_store.js` — Manage the L402 token cache (~/.blink/l402-tokens.json)
- `{baseDir}/scripts/_l402_macaroon.js` — Shared macaroon module: encode/decode/sign/verify + root key management
- `{baseDir}/scripts/l402_challenge_create.js` — Create L402 payment challenges (invoice + signed macaroon)
- `{baseDir}/scripts/l402_payment_verify.js` — Verify L402 client payment tokens (preimage + HMAC + caveats)
- `{baseDir}/scripts/l402_search.js` — Search L402 service directories (l402.directory, 402index.io)
- `{baseDir}/scripts/l402_info.js` — Get full L402 service details + paid health reports
- `{baseDir}/scripts/_budget.js` — Shared budget module: config resolution, spend log, rolling limits, domain allowlist
- `{baseDir}/scripts/budget.js` — Budget controls CLI (status, set, log, reset, allowlist)
