# AGENTS.md — operational notes for agents working on blink-skills

Concise, hard-won operational facts. Read before releasing, reviewing, or bumping versions.

## Repo & remotes

- `origin` = `blinkbitcoin/blink-skills` — all PRs go here (`gh … --repo blinkbitcoin/blink-skills`).
- `upstream` = `pretyflaco/blink-claw-skill` — reference only, NEVER open PRs there.
- Merge pattern: squash + admin (`--squash --admin --delete-branch`) once the user approves.

## Setup gotchas

- Node lines (release matrix = all three): **24** = primary dev/release Node (nvm default, `.nvmrc`); **22** = the Spark floor (system `/usr/bin/node`); **18** = the declared `engines` floor for the custodial commands (`~/.nvm/versions/node/v18.20.8/bin/node`). The user-facing Spark floor stays "Node 22+" — do not raise it to 24 (nothing needs 24; Node 22 is supported until ~Apr 2027). `engines` stays `>=18` because README/SKILL.md document custodial as Node 18+; the Node 18 run is what keeps that contract honest. Dropping it means raising `engines` AND updating those docs in one coordinated support-policy change (PR #22 review).
- NEVER `npm install` under Node 18 — it would silently drop the Node-22-only optional deps. Run Node 18 tests against the tree installed under 22/24.
- The Breez SDK requires **Node 22+**. npm under Node 20 **silently skips** the optional dependency (`engines` mismatch) leaving `node_modules/@breeztech` EMPTY — installs must run under Node 22+.
- `better-sqlite3` is a native build compiled for ONE Node ABI (22 = 127, 24 = 137). Switching Node versions in the same tree breaks it (`ERR_DLOPEN_FAILED … NODE_MODULE_VERSION`) — `npm rebuild better-sqlite3` under the Node you are about to use, and verify by opening a database, not by exit code:
  `node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"`
- The test suite **mocks** `better-sqlite3`, so a green run (even 0 skipped) does NOT prove the real binding loads. Run the smoke check above.

## Testing

- The suite must run on ALL THREE Node lines before releasing:
  - Node 24 (`npm test`) and Node 22 (`/usr/bin/node --test test/*.test.js`): **all tests passing, 0 skipped**.
  - Node 18 (`~/.nvm/versions/node/v18.20.8/bin/node --test test/*.test.js`): **0 failed**, and every skip must be a Node-22-gated one (reason `requires Node 22+`) — any other skip or a failure is a broken custodial contract. Check reasons, not counts: `… | grep -E '# SKIP' | grep -v 'requires Node 22+'` must print nothing. The `better-sqlite3` smoke check does not apply on 18 (Spark is unsupported there).
  - Do not hard-code counts here — they drift every release.
- Test architecture: CLI tests spawn `bin/blink.js` with `test/fixtures/spark_sdk_stub.js` via `--require` (`Module._load` interception of `_spark_sdk`). Pure helpers (e.g. `normalizePayment`) are passed through from PRODUCTION via load-through capture — never re-mirror them in fixtures; mirrors drift.
- Guard/stateful helpers in `_spark_sdk` (`suppressSdkStdoutNoise`) have lifecycle tests that are Node-22-gated; the pinned-storage regression test self-validates (counterfactual first) and `t.skip`s when the native binding is unavailable.

## Version bumps — the exact spots

1. `package.json` (1×)
2. `package-lock.json` — the **root pair only** (top-level + `packages[""]`). Beware deps that coincidentally share the version number (`pg-types`, `tar-stream` sat at 2.2.0 once) — never bump those.
3. `blink/SKILL.md` frontmatter (2×: `version:` and `oa.version:`-style entry)
4. `README.md`: **both** test-count mentions (line ~13 and ~258). The ClawHub reference is deliberately VERSION-NEUTRAL (PR #21 review) — never hard-code a version there; the registry lag makes any pinned claim false until post-merge publication, and it re-falsifies on the next bump

## Release ritual (in order — every step)

1. Merge the PR (squash + admin + delete branch).
2. Verify main locally: full suite on Node 24, 22, and 18 (see Testing), the `better-sqlite3` smoke check on 24 and 22 (rebuild per Node, see Setup gotchas), lint, `format:check`, clean tree.
3. Tag `vX.Y.Z` at the merge commit, push the tag.
4. GitHub release (`gh release create vX.Y.Z --latest`) with notes + stats table.
5. **Publish to ClawHub from main** (clean provenance):
   ```bash
   clawhub skill publish blink --slug blink-wallet --owner pretyflaco \
     --version X.Y.Z --tags latest --changelog "…" \
     --topics "agents,bitcoin,lightning-network,spark,cli" \
     --source-repo blinkbitcoin/blink-skills --source-ref vX.Y.Z \
     --source-commit <merge-sha> --source-path blink --json
   ```
   Dry-run first (`--dry-run --json`). CLI is installed at the nvm Node 24 bin (maintainer host: `~/.nvm/versions/node/v24.22.1/bin/clawhub`); auth persists (`clawhub whoami` → pretyflaco).
   ClawHub gotchas (learned publishing 2.6.0):
   - The topic `openclaw` is **reserved** by ClawHub — using it fails the publish (and rate-limits validation ~50s).
   - Publish returns `pending-publication`: the version goes through ClawHub's security scan before the registry serves it. `clawhub skill verify` fails while the current published version is not scan-clean.
   - This skill inherently trips two scan heuristics: `suspicious.env_credential_access` (reads `BLINK_API_KEY` + network send — the skill IS an API client) and `suspicious.insecure_tls_verification` (the `--no-verify` flag whose DEFAULT is verify-on). Both are by-design; do NOT contort the code to satisfy the scanner.
   - Retrieve evidence: `clawhub scan download blink-wallet --version X.Y.Z` (writes a ZIP to cwd — delete it, don't commit).
6. **Verify the registry**: `https://clawhub.ai/api/v1/skills/blink-wallet?ownerHandle=pretyflaco` must report the new `version`, and `clawhub inspect blink-wallet@X.Y.Z` must resolve. The README's ClawHub reference is deliberately version-neutral (see the version-bump list) — but the registry actually serving the new version is still a release gate. If the scan leaves the version pending (suspicious heuristics), surface it to the user immediately rather than waiting.

## Multi-model review loop

- Reviews arrive from `@blink-dev-bot` (3 models, consolidated). Read: `gh api repos/blinkbitcoin/blink-skills/pulls/N/reviews --jq '.[-1].body'`.
- ALWAYS verify each finding against the code before planning; several "findings" across rounds have been wrong or already-fixed — and several have been exactly right (emission path, lease overlap, timeout ownership).
- Post per-finding resolution comments via a **python3 heredoc** (`gh pr comment` inside bash double-quotes mangles backticks).

## Field testing (Hermes / OpenClaw agent)

- Releases are validated by live mainnet field tests run by the user's agent. Prompts always start with **P0: discover and install the LATEST tag** (`git ls-remote --tags --sort=-v:refname`), make the tree byte-identical, and hard-stop if `blink --version` mismatches.
- Budget caps, self-controlled destinations only, secrets never printed, stop-and-report on any breez.tips mention or unexplained balance delta.
- Six live defects have been found and fixed this way (v2.3.0–v2.5.0). Keep the loop.

## Open upstream items

- `blinkbitcoin/blink-lnurl-server#43`: LNURL management endpoints unreachable from SDK 0.23.1+ (path-ordering mismatch `/lnurlpay/<name>/available` vs `/lnurlpay/available/<name>`; recovery is username+signature keyed). Client-side we fail honestly (`registered: "unknown"`, `lnAddressStatus: "unverified"`). Re-check the pulse on SDK upgrades.

## Secrets hygiene

- Never print seeds, `BREEZ_API_KEY`, or `BLINK_API_KEY`. Regtest credentials are held by the operator (not in this repo). Mask any output that would echo them.
