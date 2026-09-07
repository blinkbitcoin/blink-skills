# Blink Lightning CLI

Bitcoin Lightning wallet for the command line — zero runtime npm dependencies, Node.js 18+ built-ins only.

24 commands for wallet management, payments, invoices, swaps, L402 paywall operations (consumer + producer), service discovery, and budget controls. Designed for humans and AI agents alike.

## Highlights

- **Zero runtime dependencies** — only Node.js 18+ built-ins (`node:crypto`, `node:fs`, `node:util`, etc.)
- **24 commands** — balance, payments, invoices, QR codes, swaps, L402 consumer + producer, service discovery, budget controls
- **L402 paywall toolkit** — create Lightning paywalls (producer) and pay them (consumer)
- **261 tests**, 0 failing — `node:test` framework, no test library dependencies
- **JSON-first output** — structured JSON to stdout, status messages to stderr
- **AI-agent native** — published on [ClawHub](https://clawhub.com) for OpenClaw/Hermes agents; also works with any LLM or human

## Quick Start

```bash
export BLINK_API_KEY="blink_..."

blink balance                                          # wallet balances + USD estimates
blink create-invoice 1000 "Coffee payment"             # create a Lightning invoice
blink pay-invoice lnbc...                              # pay a Lightning invoice
blink price 50000                                      # convert sats to USD
blink l402-challenge --amount 100 --expiry 3600        # create an L402 paywall challenge
blink l402-verify --token <macaroon>:<preimage>        # verify a client's payment proof
```

## Commands

### Wallet

| Command              | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `blink balance`      | Show BTC and USD wallet balances with pre-computed USD estimates            |
| `blink account-info` | Show account level, spending limits, and wallet summary                     |
| `blink transactions` | List recent wallet transactions with pagination                             |
| `blink price`        | BTC/USD price, currency conversion, and price history (no API key required) |

### Payments

| Command                             | Description                                                     |
| ----------------------------------- | --------------------------------------------------------------- |
| `blink pay-invoice <bolt11>`        | Pay a BOLT-11 Lightning invoice                                 |
| `blink pay-lnaddress <addr> <sats>` | Send sats to a Lightning Address (user@domain)                  |
| `blink pay-lnurl <lnurl> <sats>`    | Send sats to a raw LNURL payRequest string                      |
| `blink fee-probe <bolt11>`          | Estimate the fee for paying a Lightning invoice without sending |

### Invoices

| Command                                   | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `blink create-invoice <sats> [memo]`      | Create a BTC Lightning invoice with optional auto-subscribe      |
| `blink create-invoice-usd <cents> [memo]` | Create a USD-denominated Lightning invoice                       |
| `blink check-invoice <hash>`              | Check payment status of a Lightning invoice by payment hash      |
| `blink subscribe-invoice <bolt11>`        | Watch an invoice for payment via WebSocket                       |
| `blink subscribe-updates`                 | Stream account activity updates via WebSocket (NDJSON)           |
| `blink qr <bolt11>`                       | Generate a QR code for a Lightning invoice (terminal + PNG file) |

### Non-custodial (Spark) accounts

Blink now offers **self-custodial (Spark)** accounts alongside custodial ones.
These commands add parity for non-custodial accounts. See
[`blink/references/non-custodial.md`](blink/references/non-custodial.md) for the
full model and the API-growth research.

**Receive — no credentials, no seed** (works for _any_ Blink Lightning Address,
custodial or non-custodial; uses public LNURL-pay on `blink.sv`):

| Command                                              | Description                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `blink resolve-receiver <identifier>`                | Classify a `user@blink.sv` / bare username as custodial or Spark        |
| `blink create-invoice-lnaddress <addr> <sats> [memo]`| Receive to any Blink address via LNURL-pay + LUD-21 verify (no API key) |

**Balance / send / history / events — require the account seed** via the Breez
Spark SDK (optional dependency `@breeztech/breez-sdk-spark`, **Node 22+**). Set
`SPARK_MNEMONIC` (12/24 BIP39 words — spend authority, keep secret) and
`BREEZ_API_KEY`:

| Command                                   | Description                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `blink spark-balance`                     | Show a Spark account BTC balance via the SDK                       |
| `blink spark-send <destination> <sats>`   | Sign & send BTC from a Spark account (`--dry-run` shows fees)      |
| `blink spark-transactions`                | List Spark account payments (SDK-local history)                   |
| `blink spark-subscribe`                   | Stream live Spark wallet events                                   |

> **Note:** Non-custodial **send** is BTC-only in this spike and cannot go
> through the Blink API — it is signed locally with the seed. Only receive works
> credential-free. USD/Stablesats is out of scope.

### Swaps

| Command                                   | Description                                         |
| ----------------------------------------- | --------------------------------------------------- |
| `blink swap-quote <direction> <amount>`   | Get a BTC <-> USD conversion quote (no funds moved) |
| `blink swap-execute <direction> <amount>` | Execute a BTC <-> USD wallet conversion             |

### L402 Consumer (pay paywalls)

| Command                         | Description                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `blink l402-discover <url>`     | Probe a URL for L402 payment requirements (no payment made)  |
| `blink l402-pay <url>`          | Fetch an L402-gated resource, paying automatically via Blink |
| `blink l402-store <subcommand>` | Manage the L402 token cache (~/.blink/l402-tokens.json)      |
| `blink l402-search [query]`     | Search L402 service directories (l402.directory, 402index.io) |
| `blink l402-info <service_id>`  | Get full service details + paid health reports                |

### L402 Producer (create paywalls)

| Command                                 | Description                                                  |
| --------------------------------------- | ------------------------------------------------------------ |
| `blink l402-challenge --amount <sats>`  | Create an L402 payment challenge (invoice + signed macaroon) |
| `blink l402-verify --token <mac>:<pre>` | Verify an L402 payment token (preimage + HMAC + caveats)     |

### Budget Controls

| Command                                              | Description                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `blink budget status`                                | Show current spend vs rolling limits and remaining budget         |
| `blink budget set --hourly <sats> --daily <sats>`    | Set per-hour and per-day spending limits                          |
| `blink budget allowlist list\|add\|remove <domain>`  | Manage L402 domain allowlist                                      |
| `blink budget log [--last N]`                        | Show recent spending entries                                      |
| `blink budget reset`                                 | Clear spending history                                            |

## Installation

### Standalone

```bash
git clone https://github.com/blinkbitcoin/blink-skills.git
cd blink-skills
export BLINK_API_KEY="blink_..."
./bin/blink.js balance
```

Or add to your PATH:

```bash
export PATH="$PATH:$(pwd)/bin"
blink balance
```

### OpenClaw / Hermes Agents

Published on ClawHub as `blink@1.7.0`. The full skill manifest and agent instructions are in [`blink/SKILL.md`](blink/SKILL.md).

### With blink-mcp

For MCP-native clients (Claude Desktop, Cursor, etc.), see [blink-mcp](https://github.com/blinkbitcoin/blink-mcp). The CLI is typically 80-100x more token-efficient per agent session than MCP tool calls.

## Configuration

| Variable              | Required         | Description                                                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `BLINK_API_KEY`       | Yes (wallet ops) | Blink API key (`blink_...`). Not needed for `price`.                                                        |
| `BLINK_API_URL`       | No               | Override API endpoint. Default: `https://api.blink.sv/graphql`                                              |
| `BLINK_L402_ROOT_KEY` | No               | 64-char hex root key for L402 producer HMAC signing. Auto-generated to `~/.blink/l402-root-key` if not set. |
| `BLINK_BUDGET_HOURLY_SATS` | No          | Max sats spendable in rolling 1-hour window. |
| `BLINK_BUDGET_DAILY_SATS` | No           | Max sats spendable in rolling 24-hour window. |
| `BLINK_L402_ALLOWED_DOMAINS` | No        | Comma-separated domain allowlist for L402 auto-pay. |

**Staging / testnet:**

```bash
export BLINK_API_URL="https://api.staging.blink.sv/graphql"
```

## Testing

```bash
npm test    # 261 tests, node:test framework, zero test dependencies
```

## Documentation

Full command reference, output examples, security model, and agent instructions: [`blink/SKILL.md`](blink/SKILL.md)

## License

MIT
