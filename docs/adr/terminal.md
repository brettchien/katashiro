# ADR: Terminal — a shell on the user's Mac, for the user and the agent

- **Status:** Proposed 2026-10-19 (Brett asked 18:56 TPE; "both the user and the agent" 19:07 TPE).
  Decisions Q1–Q8 (§6) are waiting for Brett.
- **Date:** 2026-10-19
- **Author:** Brett Chien (drafted by Orca)
- **Related:** the 🔒 confirm card (#80, `confirm-core.js`); act mode ([tools](../tools.md#act-mode--writes-are-off-by-default));
  [ask-user](./ask-user.md) §1.3 (the 170 s limit on one tunnelled tool call); [canvas](./canvas.md) §3.1
  (a tab of its own, in the conversation's tab group); [multi-conversation](./multi-conversation.md)
  (one tab group per conversation, background conversations).

---

## 1. Context

### 1.1 Problem

The agent behind Katashiro usually runs somewhere else. Orca, for example, runs on ECS Fargate. It can
read and operate the user's browser through the MCP-over-ACP tunnel, but it cannot touch the machine
the browser runs on. Things like "run the tests in my checkout", "what does `git status` say", "tail
this log" need the user to copy and paste. The user also wants a terminal of their own in the browser,
next to the conversation and its canvases (Brett 2026-10-19 19:07 TPE: **both**).

### 1.2 What a Chrome extension can do

An extension cannot start a process. The supported way to reach the local machine is **Native
Messaging**:

- A small program (the *native host*) is installed on the Mac.
- A manifest in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json` names
  the program and the **extension ids allowed to connect** (`allowed_origins`).
- The extension calls `chrome.runtime.connectNative(name)`. Chrome starts the host and connects the
  two over stdin/stdout, with length-prefixed JSON messages (≤ 1 MB host → extension).
- This needs the `nativeMessaging` permission. The host runs as the user, with the user's rights.

No network port is opened. Only Katashiro (by extension id) can start the host, and only while Chrome
is running. Chrome kills the host when the port closes.

### 1.3 Two consumers, one terminal

- **The user:** a real interactive terminal (zsh, colours, vim, Ctrl-C) in a browser tab.
- **The agent:** runs a command and gets its output and exit status; reads the screen; types into a
  program that asks a question.

They share one design: a PTY on the Mac, shown in a Katashiro tab, which the agent can use through
tools when the user lets it.

## 2. Decision (proposed)

### 2.1 Pieces

```
agent ⇄ ACP / MCP tunnel ⇄ side panel (tools, confirm cards)
                               ⇅ chrome.runtime messaging
                           terminal tab (xterm.js)  ⇄  connectNative  ⇄  katashiro-host (Mac)  ⇄  PTY → $SHELL -l
```

- **`katashiro-host`:** a single static binary (Go: `creack/pty`, no runtime to install) in a new
  repo directory `native-host/`, plus an install script.
  - The install script copies the binary to `~/Library/Application Support/Katashiro/` and writes the
    host manifest with this extension's id.
  - It opens PTYs on request, streams output, takes input and resizes, and reports the exit status.
  - It runs no command on its own and has no config that widens what it does.
- **The terminal tab:** `terminal.html`, an extension page with vendored xterm.js (eval-free, like the
  other vendor bundles). It shows one PTY and holds the native port for it. It sits in the calling
  conversation's tab group, like a canvas.
- **Agent tools:** in `browser-mcp.js`, answered by the side panel, which asks the terminal tab over
  runtime messaging (the canvas pattern).

### 2.2 Terminals and who may use them

- **A terminal belongs to one conversation**, like a canvas. The user opens one from the panel (a
  `>_` button) or the agent opens one (`terminal_open`).
- **Shared or private.** A terminal the agent opened is shared with that conversation's agent. A
  terminal the user opened is **private**: no tool can read or type into it until the user turns on
  **與 agent 共用** in its header. The user can turn sharing off at any time. Reason: the user's own
  shell shows things (history, tokens in the environment, other projects) they did not hand over.
- **The user can always type** in any terminal, shared or not. When both type, input simply
  interleaves, as on a shared tmux; the header shows **agent 正在輸入** while an agent call is running.
- **⏹ 中斷 / ✕ in the header:** ⏹ sends Ctrl-C; ✕ closes the tab, which kills the PTY (the host
  sends SIGHUP to the process group). Archiving a conversation closes its terminal tabs as it closes
  its other group tabs (multi-conversation §4.5).

### 2.3 Agent tools

| Tool | Args | Does |
|---|---|---|
| `terminal_open` | `cwd?`, `title?` | Opens a new shared terminal (login shell) in a background tab of this conversation's group. → `{ terminalId }` |
| `terminal_run` | `terminalId`, `command`, `timeoutSec?` (≤ 150) | Types `command` + Enter, waits until it finishes or `timeoutSec` → `{ output, exitCode? , running }`. Still running at the timeout: returns what it has, with `running: true`. |
| `terminal_read` | `terminalId`, `lines?` | The screen (and up to `lines` of scrollback) as text. |
| `terminal_write` | `terminalId`, `text` \| `keys` | Raw input for an interactive program: text, or named keys (`Enter`, `Ctrl-C`, `Up`, `Tab`…). |
| `terminal_list` | — | This conversation's terminals the agent may use: id, title, cwd, busy or not. |

- **Finishing a command.** The host knows when the shell is back at the prompt and what the last exit
  status was: it starts zsh/bash with a small rc snippet that prints an OSC 133 mark (`ESC ] 133;D;<status>`)
  at each prompt, as iTerm2 and VS Code do. `terminal_run` returns at that mark. The output is
  the bytes between the command and the mark, with escape sequences stripped and capped (64 KB, the
  tail kept).
- **The 170 s limit** (ask-user §1.3): no call waits longer than 150 s. A long build returns
  `running: true` and the agent polls with `terminal_read`.
- **Background conversations:** `terminal_run`, `terminal_read`, `terminal_write` and `terminal_list`
  work there (they act on the conversation's own terminal, not on what the user is looking at);
  `terminal_open` too (a background tab).

### 2.4 Consent — the part that matters

The agent runs commands **as the user, on the user's computer**. That is more than anything Katashiro
does today, so:

1. **Off until installed and enabled.** Nothing works without the host installed (the panel says how
   to install it), plus **Settings → 本機終端機 → 啟用**. Turning it off closes every terminal.
2. **Act mode.** `terminal_open`, `terminal_run` and `terminal_write` are `write: true`, so they are
   refused unless act mode is on. `terminal_read` and `terminal_list` are reads, but only of shared
   terminals.
3. **A 🔒 confirm card per command** (proposed default, Q3): `terminal_run` and `terminal_write` show
   the exact command (plain text, one line per line, control characters made visible) and the
   terminal it goes to. 允許 runs it, 拒絕 or 2 minutes of silence declines, and the turn ending
   cancels it. The card fits in the 150 s budget because it times out at 120 s.
4. **Optional allowlist** (Q4), in Settings: command prefixes that run without a card, matched on the
   whole command line after trimming. Example: `git status`, `git diff`, `ls`, `pwd`, `npm test`. A
   line containing `;`, `&&`, `|`, `` ` ``, `$(` or a redirect never matches. Empty by default.
5. **Never:** no `sudo` prompt is answered by the agent (a `terminal_write` while the screen shows a
   password prompt is refused); the host does not read or forward the keychain; no command is run at
   connect time.
6. **Visible:** everything the agent types appears in the terminal tab as it happens. The tab title
   shows `🤖` while an agent call runs, and the panel lists open terminals in the conversation header.

### 2.5 Not in scope (v1)

- Windows or Linux hosts (the host is plain Go, so later is cheap; the install script is the work).
- File transfer (agents can `cat` / use canvases); port forwarding; several machines.
- Recording sessions to disk (the scrollback lives only in the tab).
- Agent access to a terminal of another conversation.

## 3. Alternatives considered

- **A local agent on the Mac instead** (Falcon / Kirin under OrbStack, or Claude Code itself): already
  possible and the right choice for heavy local work. It does not give *this* conversation's agent
  (e.g. Orca on ECS) the machine, and it does not give the user a terminal next to the conversation.
- **A localhost WebSocket daemon** (ttyd and the like): needs an open port and a token that any page
  could try to reach; Native Messaging is limited to one extension id by Chrome, with no port.
- **SSH from the agent's side to the Mac:** the Mac is usually behind NAT and the agent host should
  not hold the user's SSH key; it would also bypass every Katashiro consent.

## 4. Consequences

- A new permission (`nativeMessaging`): Chrome asks the user again when the update arrives. Could be
  an **optional permission** requested when the user enables the feature (Q7), so users who never use
  it are not asked.
- A second artefact to build and sign: the Go binary, per architecture (arm64 + amd64, or universal).
  An unsigned binary trips Gatekeeper on first run; the install script removes the quarantine flag,
  or we notarize (Q6).
- The biggest new risk surface in Katashiro. The confirm card, the private-by-default user terminals
  and act mode are what keep it acceptable; dropping any of them needs a new decision here.

## 5. Plan (if accepted)

1. `native-host/` (Go) + install script + host protocol doc; a fake host for tests.
2. `terminal.html` (xterm.js vendored), user-opened terminals, ⏹ / ✕, sharing switch.
3. Agent tools + confirm cards + allowlist setting; docs/tools.md; skill `katashiro-terminal`.
4. E2E with the real extension and a fake host (Native Messaging works with a host manifest in the
   test profile's directory).

## 6. Questions for Brett

- **Q1** Host language: Go single binary (proposed), Rust, or a Node script (needs Node on the Mac)?
- **Q2** User terminals private until shared (proposed), or shared with the agent by default?
- **Q3** Confirm card for **every** agent command (proposed), or only outside the allowlist?
- **Q4** Allowlist at all in v1, or cards only until we see how it feels?
- **Q5** `terminal_run`'s wait cap: 150 s (proposed), or shorter so a turn does not sit idle?
- **Q6** Distribution: build from source with the install script (v1, proposed), or notarized
  binaries in the GitHub release?
- **Q7** `nativeMessaging` as an optional permission requested on enable (proposed; to be confirmed on Chrome 155 before relying on it), or required?
- **Q8** Name in the UI: 終端機 / Terminal, and the panel button `>_`?
