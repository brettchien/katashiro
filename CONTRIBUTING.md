# Contributing to Katashiro

Thanks for your interest in improving Katashiro — the OpenAB Side Panel
companion. This guide covers local development and, most importantly, the
commit convention this repo follows.

## Local development

Katashiro is a zero-build, vanilla-JS Chrome Extension (Manifest V3) — no
bundler, no `node_modules`.

1. Clone the repo.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Edit the source, then hit the **↻ reload** button on the extension card to
   pick up changes. Reload the Side Panel to re-run `sidepanel.js`.

### Project layout

| File             | Responsibility                                             |
|------------------|------------------------------------------------------------|
| `manifest.json`  | MV3 config, permissions, Side Panel registration           |
| `background.js`  | Service worker — opens the Side Panel on action click       |
| `sidepanel.html` | Chat UI markup                                             |
| `sidepanel.css`  | Glassmorphic dark-mode styling                            |
| `sidepanel.js`   | ACP/WebSocket transport, agent management, message rendering|

## Code style

- Vanilla JS, no framework. Match the surrounding style (2-space indent, `const`/`let`, small focused functions).
- Render any agent- or network-sourced text via `textContent`, never `innerHTML` — no HTML injection from remote data.
- Keep comments in English; user-facing UI strings may be Traditional Chinese.
- **No secrets.** Never commit tokens, keys, or private endpoints. `ws://localhost:8080/acp` is the only endpoint placeholder.

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
| `docs`     | Documentation only (README, ROADMAP, this file)          |
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
