# Contributing to Katashiro

Thanks for your interest in improving Katashiro — the OpenAB Side Panel
companion. This guide covers local development and, most importantly, the
commit convention this repo follows.

## Local development

Katashiro is a zero-build, vanilla-JS Chrome Extension (Manifest V3) — no
bundler, and the extension loads nothing from `node_modules`. `package.json` holds
dev tooling only (puppeteer-core for the headless smokes); see
[Running the tests](#running-the-tests).

1. Clone the repo.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Edit the source, then hit the **↻ reload** button on the extension card to
   pick up changes. Reload the Side Panel to re-run `src/sidepanel/sidepanel.js`.

## Project structure

The manifest and the four extension pages (`sidepanel.html`, `canvas.html`, `canvas-gallery.html`, `canvas-frame.html`) stay at the repo root, so the unpacked folder and the canvas tab URLs never change; their scripts and styles live under `src/` — `src/core/` (pure logic, also `require`d by the Node tests), `src/mcp/`, `src/sidepanel/`, `src/canvas/`, `src/page/` (scripts injected into web pages) and the service worker `src/background.js` (its `importScripts` paths are relative to `src/`).

- `manifest.json`: Manifest V3, with the Side Panel API.
- `src/background.js`: Service worker; opens the side panel from the toolbar icon, registers the right-click **💬 Ask agent** item and hands what was right-clicked to the panel, and on install / update / browser start runs the conversation-storage migration, finishes conversation deletes a closed gallery tab left half done, and removes canvases older versions stored for incognito windows.
- `sidepanel.html` / `src/sidepanel/sidepanel.css`: The side panel's layout and styles.
- `src/sidepanel/sidepanel.js`: The side panel — WebSocket connections, storage, reconnects, message rendering.
- `src/sidepanel/conversations.js`: The side panel's conversations — their storage (conv:index, window records, Web Locks), loading and adoption, showing / switching, ＋ / archive / reopen and the pickers, the tab strip. Loaded before `sidepanel.js`; declarations only.
- `src/sidepanel/composer-ui.js`: The side panel's composer — pasted / dropped attachments, the send button and the send, the ↩ reply target, the 💬 Ask agent on a web page target and the chat-selection 💬. Loaded before `sidepanel.js`; declarations only.
- `src/sidepanel/canvas-glue.js`: The side panel's canvas glue — canvas store and folder mirror, opening and finding canvas tabs, the canvas tab group + Split View, one tab group per conversation. Loaded before `sidepanel.js`; declarations only.
- `src/sidepanel/cards.js`: The side panel's chat cards — the 🔒 confirm card, the ask_user card, the ⚡ command menu and its commands. Loaded before `sidepanel.js`; declarations only.
- `src/mcp/browser-mcp.js`: The MCP server we serve back to the agent over the ACP tunnel — tool registry, schemas, and DOM tool bodies. See [Serving an MCP server over reverse MCP-over-ACP](docs/mcp-over-acp.md).
- `src/core/room-core.js`: Pure panel logic — prompt framing and batching, heartbeat and reconnect decisions, roster status.
- `src/core/conv-core.js`: Pure multi-conversation logic — storage layout, the open set (at most 3 across windows), adoption after a browser restart, titles, agent binding. See [`docs/adr/multi-conversation.md`](docs/adr/multi-conversation.md) and [`docs/adr/agent-per-conversation.md`](docs/adr/agent-per-conversation.md).
- `src/core/composer.js`: Pure rules for pasted images and dropped files — what to intercept, type and size limits, and how text + attachments become an ACP `session/prompt`. See [`docs/adr/chat-attachments.md`](docs/adr/chat-attachments.md).
- `src/core/agent-tools.js`: Maps the agent's own tool-call updates (ACP `tool_call` / `tool_call_update`) to tool-strip pills.
- `src/core/ask-core.js`: The pure half of `katashiro.ask_user` — question rules, how a card settles, its visible-time clock, the answer text. See [`docs/adr/ask-user.md`](docs/adr/ask-user.md).
- `src/core/confirm-core.js`: The pure half of the panel's 🔒 confirm card — text rules and the one-shot decision state machine.
- `src/core/command-core.js`: The pure half of the ⚡ command menu — its entries, keys and shortcuts, what counts as a typed command, when one is refused, and parsing the OpenAB gateway's `/reset`, `/models` and `/model set` replies (formats pinned by `test/fixtures/openab-slash-replies.json`). See [docs/features.md → ⚡ Commands](docs/features.md).
- `src/core/jev-grounding.js`: Optional Jev (TypeSafe) decision helper behind `assert`, `click_text` and `type_text` (BYO OpenRouter key).
- `src/core/markdown.js`: The single sanitized `renderMarkdown` sink (markdown-it → DOMPurify) + copy-code and link/media hardening. See [`docs/adr/chat-markdown-rendering.md`](docs/adr/chat-markdown-rendering.md).
- `src/page/a11y-walker.js`: Content-script injected into the page — builds the accessibility-tree snapshot and resolves element refs (`__katashiroResolve`).
- `src/page/ctx-target.js`: The one manifest content script (every page and frame) — remembers the target of the last trusted right-click, and whether text was selected before it, for **💬 Ask agent**.
- `src/core/page-ask-core.js`: The pure half of 💬 Ask agent on a web page — the menu, the selection-or-element choice, the in-page reader / element describer / selector builder (also `get_selection`'s reader), the payload and its checks, the conversation choice, the chip, the prompt block and the history record. See [`docs/adr/page-send-to-agent.md`](docs/adr/page-send-to-agent.md).
- `vendor/`: Prebuilt, eval-free IIFE bundles (MV3 `script-src 'self'`): `dom-accessibility-api`, `markdown-it`, `dompurify`, `highlight.js`; for the canvas frame only, `reveal.js`, Milkdown crepe and `@mermaid-js/tiny`. Rebuild steps in [`vendor/BUILD.md`](vendor/BUILD.md).
- `skills/`: Agent skills that ship with Katashiro — install them into your agent (see [README → Agent skills](README.md#-agent-skills)).
- `canvas.html` / `src/canvas/canvas.js` (with `src/core/canvas-core.js`, `src/core/canvas-store.js`, `src/core/canvas-tabs.js`, `src/core/canvas-mirror.js` and the sandboxed `canvas-frame.html`): canvases, one tab each. `canvas-gallery.html` / `src/canvas/canvas-gallery.js` (with `src/core/canvas-gallery-core.js`): the canvas gallery. See [`docs/adr/canvas.md`](docs/adr/canvas.md).
- `test/`: `node --test` suites. No Chrome required; `chrome.*`, `crypto`, and the socket are mocked.
- `scripts/`: smoke tests in a real headless Chrome (`smoke-*.mjs`, run by `npm run smoke`), the two-session ACP check against a real gateway (`acp-two-sessions.mjs`, see [docs/testing.md](docs/testing.md#p2-prerequisite-two-session-test)), the release build stamp, and vendor rebuild helpers.
- `e2e/`: end-to-end tests of the real extension and side panel against a fake ACP gateway (`npm run e2e`; see [`e2e/README.md`](e2e/README.md)).
- `docs/adr/`: the design decisions behind each feature (canvas, multi-conversation, agent per conversation, ask_user, attachments, tunnel liveness, …).
- `icons/`: The extension icon set — `icon16/32/48/128.png` (manifest icons + toolbar) plus `icon.png` (side-panel brand logo). Cyberpunk digital paper-doll with neon circuitry.


## Running the tests

The extension has no dependencies; `package.json` is dev tooling only (it never ships, and nothing
the extension loads comes from `node_modules`).

```bash
npm test                      # = node --test test/*.test.js — no install, no Chrome (chrome.*/crypto/socket are mocked)

npm ci && npm run chrome      # once: puppeteer-core, and chrome-headless-shell (pinned in package.json) into .cache/chrome
npm run smoke                 # every scripts/smoke-*.mjs in a real headless Chrome, with a summary
npm run smoke -- mermaid      # only the named ones; or run one directly: node scripts/smoke-mermaid.mjs

npm run chrome:full           # once: full Chrome for Testing (same version) — the smokes' headless shell cannot load extensions
npm run e2e                   # T2 E2E: the real extension and side panel against a fake ACP gateway (e2e/README.md)
```

CI (`.github/workflows/ci.yml`) runs all three on every PR and push to `main`. The smokes find
puppeteer-core and Chrome through `scripts/lib/smoke-env.mjs`; `CHROME=/path/to/chrome-headless-shell`
and `PUPPETEER_CORE=/path/to/node_modules/puppeteer-core` override them.

What they check: `scripts/smoke-mermaid.mjs` (ADR canvas §2) renders diagrams in the real canvas
frame under the sandbox CSP and fails on any CSP violation outside its allow-list (it also writes a
screenshot of the fixture, to its first argument or `/tmp/ks11-mermaid.png`);
`scripts/smoke-glow-ranges.mjs` checks `canvas_patch`'s exact-range glow (ADR
canvas §3.10) in the real canvas frame, and `scripts/smoke-editor-undo.mjs` the edit-mode ↶ 復原 /
↷ 重做 (ADR canvas §3.5: the editor's own history, focus kept in the editor).
`scripts/smoke-ask-selection.mjs` checks the frame's `selection{rect}` (where the 💬 goes, re-sent on
scroll, dropped out of view) and `scripts/smoke-ask-popover.mjs` the Ask agent popover in the real
`canvas.html` with stubbed `chrome.*` APIs (ADR canvas §3.7). `scripts/smoke-diagram-notice.mjs`
checks that a diagram error notice in the canvas header belongs to the render it came from, and
`scripts/smoke-multi-conversation.mjs` the multi-conversation side panel and gallery (see
[docs/testing.md](docs/testing.md)).


## Code style

- Vanilla JS, no framework. Match the surrounding style (2-space indent, `const`/`let`, small focused functions).
- Render agent- or network-sourced text via `textContent` — **except the chat message body**, which is markdown and may reach `innerHTML` **only** through the single `renderMarkdown`/DOMPurify sink (`src/core/markdown.js`). No other `innerHTML` of remote data.
- Keep comments in English; user-facing UI strings may be Traditional Chinese.
- **No secrets.** Never commit tokens, keys, or private endpoints. `ws://localhost:8080/acp` is the only endpoint placeholder.

## Adding a feature or a tool

- **Design first.** A feature that changes behaviour beyond one module gets an ADR in
  [`docs/adr/`](docs/adr/) before the code (see the existing ones for the shape).
- **A new browser tool** is one entry in `TOOLS` in `src/mcp/browser-mcp.js`: schema and implementation
  together, so `tools/list` is derived from it. Name it `katashiro.<verb>`, and:
  - mark `write: true` if it acts on a page or on tabs on the user's behalf (act mode gates it);
    side-panel features — canvases, `notify`, `ask_user` — are not writes, even when they open a tab;
  - mark `sessionScope: true` if it works on tabs or the browser rather than the active page's DOM —
    otherwise it first resolves the active tab and checks its origin, and fails on a tab Katashiro
    cannot script. A `sessionScope` tool is refused in a background conversation unless it is listed
    in `BACKGROUND_SESSION_TOOLS` — add it there only if it never brings a tab forward or acts on
    the tab the user is on (see [docs/tools.md → In a background conversation](docs/tools.md#in-a-background-conversation));
  - give it a `redact(args)` hook so the activity pill never shows secrets (a test enforces it), and
    a `secrets(args)` hook for short values — passwords, typed text — that must also be scrubbed
    from the result summary;
  - add its row to [`docs/tools.md`](docs/tools.md), and bump the tool count in the README
    ("51 `katashiro.*` tools") and in [`docs/features.md`](docs/features.md) ("and 46 more").
- **A feature the agent needs more than one tool call to use well** (or a rule it must follow,
  like ending the turn after `ask_user`) gets a skill in [`skills/`](skills/) and a row in the
  README's Agent skills table.
- User-visible behaviour goes in [`docs/features.md`](docs/features.md); the README keeps only
  what a new user needs.

## Commit convention — Conventional Commits

All commits **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>(<optional scope>): <short summary in imperative mood>

<optional body — the what and why, wrapped at ~72 chars>

<optional footer — BREAKING CHANGE:, refs #123>
```

### Types

| Type       | When to use                                              |
|------------|----------------------------------------------------------|
| `feat`     | A new user-facing capability                              |
| `fix`      | A bug fix                                                 |
| `docs`     | Documentation only (README, ROADMAP, docs/, this file)   |
| `style`    | Formatting / whitespace, no behavior change              |
| `refactor` | Code change that neither fixes a bug nor adds a feature   |
| `perf`     | Performance improvement                                   |
| `test`     | Adding or fixing tests                                    |
| `build`    | Build tooling, manifest packaging                        |
| `chore`    | Maintenance, deps, housekeeping                          |

### Suggested scopes

`acp`, `sidepanel`, `agents`, `ui`, `manifest`, `docs`

### Examples

```
feat(agents): add per-agent ACP session resume
fix(acp): requeue in-flight turn after mid-turn disconnect
feat(sidepanel): render page context toggle for read access
docs(roadmap): add Doc Canvas phase
refactor(ui): extract message bubble builder
chore: bump manifest version to 1.1.0
```

### Rules

- Summary in the **imperative mood** ("add", not "added" / "adds").
- Keep the summary ≤ 72 chars, lower-case, no trailing period.
- Breaking changes: add a `BREAKING CHANGE:` footer **or** a `!` after the type
  (`feat!: drop legacy single-url config`).
- One logical change per commit — don't mix a feature and an unrelated fix.

## Pull requests

- Branch from `main`; keep PRs focused and small.
- The PR title should itself be a Conventional Commit line.
- Describe what changed and how you verified it (which page / agent you tested against).
- Ensure the extension loads without console errors before requesting review.
- CI (`.github/workflows/ci.yml`) syntax-checks every runtime script, runs
  `node --test test/*.test.js`, the puppeteer smokes (`npm run smoke`) and the T2 E2E
  (`npm run e2e`) on each PR; run the same locally before pushing (`npm test`,
  `npm ci && npm run chrome && npm run smoke`, and `npm run chrome:full && npm run e2e`).
