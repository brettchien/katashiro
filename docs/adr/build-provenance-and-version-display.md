# ADR: Build provenance & version display

- **Status:** Accepted 2026-08-06
- **Date:** 2026-08-06
- **Author:** Brett Chien
- **Related:** [Browser-tunnel liveness ADR](./browser-tunnel-liveness.md) (§8 — the same connection-screen
  legibility work); the extension already reads `chrome.runtime.getManifest().version` in `sidepanel.js`
  to report itself to the agent on handshake.

---

## 1. Context

Two facts about this codebase make "which build am I running?" a recurring, unanswered question during
testing:

- **MV3 side panels keep the JS they loaded at open-time.** `chrome://extensions` → Update reloads the
  background service worker but **not** an already-open side panel — so after an Update, the panel may
  still be running old `sidepanel.js` until it is fully closed and reopened. This has already caused a
  near-hour false-bug hunt (a stale `setActMode`), documented separately.
- **Same-version feature branches.** Across the 2026-08-06 test session, `feat/clear-chat`,
  `feat/origin-allowlist`, `feat/batch-queued-messages` and `feat/tunnel-liveness-core` all carried
  manifest version `2.2.0`. The manifest version alone **cannot distinguish two builds at the same
  version**, so it can't confirm the reopen actually loaded the intended branch.

There is no build step to lean on: the repo is **zero-build vanilla-JS MV3** (no `node_modules`, no
bundler), loaded unpacked from the git working tree.

## 2. Decision

Surface build identity on the **connection screen**, in two tiers.

### 2.1 Version — always, zero-build

Render `chrome.runtime.getManifest().version` (already read in `sidepanel.js`) as muted text next to the
agent-count line — e.g. `1/1 agents 上線 · v2.2.0`. Always correct to the manifest, needs no build step,
no new plumbing beyond one DOM write.

### 2.2 Commit provenance (sha / tag) — `build-info.json`

A small `build-info.json` `{ "tag": string|null, "sha": string, "builtAt": string }` fetched at runtime
and shown next to the version when present, e.g. `v2.2.0 · a1b2c3d` (or the tag for a release build):

- **Released zips.** The release GitHub Action stamps `build-info.json` at package time from
  `GITHUB_REF_NAME` (tag) + `github.sha` + the build timestamp, and includes it in the zip. Installed
  users then see the exact released commit.
- **Local unpacked dev.** `build-info.json` is **gitignored**; an optional `scripts/stamp-build.sh` (or a
  `post-checkout` / `post-commit` git hook that calls it) writes `git rev-parse --short HEAD` plus a
  `-dirty` suffix when the tree has uncommitted changes. If the file is **absent**, the display reads
  `dev` — never an error.

Keeping `build-info.json` optional and gitignored preserves the **zero-build** property: nothing is
required to run the extension; the stamp is metadata whose absence degrades to `dev`.

## 3. Consequences

- After an Update + panel reopen, a glance at the connection screen confirms which build is live —
  **distinguishing same-version branches by short sha** (dev) or exact tag (release).
- Release provenance is auditable from the installed extension.
- **Cost:** one gitignored file, ~3 lines in the release workflow, an optional stamp script/hook, and a
  small fetch + render in the panel. No `node_modules`, no bundler, no change to the load-unpacked flow.
- **Non-goal:** this does not detect stale JS on its own — it lets a human *notice* it. The reload
  discipline ("fully close and reopen the panel") is still required; the badge just makes a mismatch
  visible instead of silent.
