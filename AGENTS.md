# AGENTS.md — operational notes for agents working on blink-skills

Concise, hard-won operational facts. Read before releasing, reviewing, or bumping versions.

## Repo & remotes

- `origin` = `blinkbitcoin/blink-skills` — all PRs go here (`gh … --repo blinkbitcoin/blink-skills`).
- `upstream` = `pretyflaco/blink-claw-skill` — reference only, NEVER open PRs there.
- Merge pattern: squash + admin (`--squash --admin --delete-branch`) once the user approves.

## Setup gotchas

- The Breez SDK requires **Node 22+**. npm under Node 20 **silently skips** the optional dependency (`engines` mismatch) leaving `node_modules/@breeztech` EMPTY — installs must run under Node 22 (`~/.nvm/versions/node/v22.23.2/bin`).
- `better-sqlite3` is a native build: if tests/storage fail with binding errors, `npm rebuild better-sqlite3` under Node 22 and verify by opening a database, not by exit code.

## Testing

- `npm test` on the default Node 20: 740 pass + 8 Node-22-gated skips. Full verification requires a Node 22 run: **748/748, 0 skipped**. Always do both before releasing.
- Test architecture: CLI tests spawn `bin/blink.js` with `test/fixtures/spark_sdk_stub.js` via `--require` (Module._load interception of `_spark_sdk`). Pure helpers (e.g. `normalizePayment`) are passed through from PRODUCTION via load-through capture — never re-mirror them in fixtures; mirrors drift.
- Guard/stateful helpers in `_spark_sdk` (`suppressSdkStdoutNoise`) have lifecycle tests that are Node-22-gated; the pinned-storage regression test self-validates (counterfactual first) and `t.skip`s when the native binding is unavailable.

## Version bumps — the exact spots

1. `package.json` (1×)
2. `package-lock.json` — the **root pair only** (top-level + `packages[""]`). Beware deps that coincidentally share the version number (`pg-types`, `tar-stream` sat at 2.2.0 once) — never bump those.
3. `blink/SKILL.md` frontmatter (2×: `version:` and `oa.version:`-style entry)
4. `README.md`: ClawHub reference (`blink-wallet@X.Y.Z`) + **both** test-count mentions (line ~13 and ~258)

## Release ritual (in order — every step)

1. Merge the PR (squash + admin + delete branch).
2. Verify main locally: full suite on **both** Node versions, lint, `format:check`, clean tree.
3. Tag `vX.Y.Z` at the merge commit, push the tag.
4. GitHub release (`gh release create vX.Y.Z --latest`) with notes + stats table.
5. **Publish to ClawHub from main** (clean provenance):
   ```bash
   clawhub skill publish blink --slug blink-wallet --owner pretyflaco \
     --version X.Y.Z --tags latest --changelog "…" \
     --topics "openclaw,agents,bitcoin,lightning-network,spark,cli" \
     --source-repo blinkbitcoin/blink-skills --source-ref vX.Y.Z \
     --source-commit <merge-sha> --source-path blink --json
   ```
   Dry-run first (`--dry-run --json`). CLI is installed at the nvm node-20 bin; auth persists (`clawhub whoami` → pretyflaco).
6. **Verify the registry**: `https://clawhub.ai/api/v1/skills/blink-wallet?ownerHandle=pretyflaco` must report the new `version`, and `clawhub inspect blink-wallet@X.Y.Z` must match the tree. The README's `blink-wallet@X.Y.Z` claim is only true after this step — skipping it recreates the PR #17 review finding.

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
