# ADR: Accessibility-Tree Snapshot + Element Refs as the Primary Perception Model

- **Status:** Proposed
- **Date:** 2026-08-02
- **Author:** Brett Chien
- **Related:** [ROADMAP](../../ROADMAP.md), MCP-over-ACP tunnel contract (openab `docs/mcp-over-acp-tunnel-contract.md`)

> Citations are inline as `[Key]` at the point of the claim; each key resolves in **References** at the
> end. This makes provenance traceable per-decision — which part is inspired by what.
>
> **Rev. 2 (2026-08-02):** incorporated round-1 review (Falcon / Mira / Orca). Material changes:
> ref registry moved to the content-script (per frame); open shadow DOM promoted to P0 (only *closed*
> → power mode); cross-origin iframes treated as a frame-addressing architecture item; concrete
> stale-ref assertion; actionability narrowed to a feasible P0 subset; interactability filter for
> non-semantic elements; snapshot settle strategy; `chrome.automation` wording + a misplaced CDP
> citation fixed. `dom-accessibility-api` role support (Orca F1) verified in source — it **does**
> resolve role.

---

## 1. Context

### 1.1 Problem — screenshot-centric interaction is slow and expensive

A live measurement of an agent driving katashiro over the MCP-over-ACP tunnel showed the cost is
structural, not incidental:

- A browser-using turn took **~46 s** vs **~4 s** for a plain chat turn.
- In ~12 minutes the agent made **12 tool calls — 5 of them `screenshot`** (the most-used tool),
  plus `read_dom` ×3, `navigate` ×2, `click` ×2.
- The transport is **not** the bottleneck: the actual tool round-trip (facade → katashiro → browser →
  back) measured **57–122 ms** per call, all `200`/`202`, zero retries.

The latency is model round-trips: each `screenshot` returns a multi-thousand-token image the model must
ingest and reason over, and a screenshot-primary toolset *forces* a see → reason → act → see-again loop
where every "see" is an expensive image and every step is a separate model turn. (Source: our own
Falcon+katashiro measurement, 2026-08-02.)

### 1.2 katashiro's current tools

`click {selector}`, `read_dom {selector?}` (raw DOM), `navigate {url}`, `type {selector, text}`,
`screenshot {}`. All CSS-selector based, operating on the active tab. There is **no** stable element
handle, **no** auto-wait, and the only whole-page "see" primitives are a heavy screenshot or a
noisy raw-DOM dump (~3–5k tokens `[token-cost]`).

### 1.3 MV3 execution model — where state lives

A content script can walk the DOM and compute role/accessible-name/state to build a usable a11y
snapshot with **no new permissions** (beyond existing `activeTab`/host grants — see §5). Full-fidelity
a11y (`Accessibility.getFullAXTree`), trusted input, and file upload need CDP via `chrome.debugger`
`[CDP-AXTree]` — deferred to an opt-in power mode (out of scope here).

Where state lives is load-bearing and was corrected in review:

- **The ref registry (`refId → Element`) lives in the content script, per frame.** Element handles
  cannot cross `postMessage`; the side-panel only ever holds `ref → {tabId, frameId, generation}`
  addressing, never Element references.
- **Neither the service worker nor the side-panel is durably long-lived.** The SW sleeps (~30 s idle,
  and single events are capped at ~5 min), so any `wait_for` polling runs in the content script or
  panel — the SW only relays messages. The side-panel document is destroyed when the user closes the
  panel (and is per-window), so snapshot/generation state must either survive via `chrome.offscreen`
  or the design must **tolerate panel-close = session reset** (reconnect → re-snapshot). This is
  stated in the tunnel contract.

---

## 2. Research — prior art

The design below is not novel; it is the convergence point of two independent lineages. This section
documents how each family addresses elements, so the decision rests on precedent, not assertion.

### 2.1 Browser-agent tools — the direct mechanism

| Tool | Perception model | Element addressing | Source |
|---|---|---|---|
| **Playwright MCP** | a11y-tree **snapshot**, auto-returned after actions | stable `ref=eN` per interactive node; actions target the ref | `[PW-MCP]` |
| **Chrome DevTools MCP** | `take_snapshot` (a11y), Puppeteer underneath | `uid` refs | `[CDT-MCP]` |
| **Stagehand** | NL primitives `act`/`observe`/`extract` over Playwright | `observe()` returns candidate actions; refs internal | `[Stagehand]` |
| **browser-use** | indexed interactive elements + optional vision | numeric index per element | `[browser-use]` |

All four replaced screenshots/raw-DOM with a **structured text snapshot carrying stable element
handles**. Blog measurements put a text snapshot roughly an order of magnitude cheaper than the
alternatives — a vision screenshot commonly runs ~10k–50k tokens and a raw-DOM dump a few thousand,
while a lean snapshot is much smaller (exact figures are page-dependent and blog-sourced, not an
authoritative benchmark) `[PW-MCP]` `[token-cost]`. It is also parsed instantly rather than via vision
inference, and deterministic (immune to CSS/viewport drift). Consolidating multi-step flows into fewer,
higher-level tools is also Anthropic's own tool-design guidance `[Anthropic-Tools]`.

### 2.2 Testing frameworks — the *origin* of the role/name locator model

The role + accessible-name addressing scheme did **not** start in agent tooling. Its origin is
**Testing Library** (Kent C. Dodds, 2018 `[TL-Origin]`) and its guiding principle: *"the more your
tests resemble the way your software is used, the more confidence they can give you"* `[TL-Principles]`.
Testing Library encodes this as an explicit **query-priority ladder** — `getByRole` (+ accessible
`name`) first because it "can be used to query every element that is exposed in the **accessibility
tree**"; `getByTestId` sits **last**, "only recommended for cases where you can't match by role or
text" since "the user cannot see (or hear) these" `[TL-Queries]`. (Our own reading — not a Testing
Library claim — is that because `getByRole` rewards a11y-correct markup, routinely needing a test-id
tends to signal an accessibility gap.)

- **Playwright** adopted it: `getByRole({name})` is the recommended default locator over CSS/XPath
  `[PW-Loc]` — and **Playwright MCP is the same locator/snapshot engine** repackaged for an agent
  `[PW-MCP]`. The agent-tool in §2.1 *is* Testing Library's philosophy operationalized for LLMs.
- **Cypress** centers CSS/`data-testid` in core `[Cypress-BP]`, but the official **Cypress Testing
  Library** plugin ports the same `findByRole`/`findByText` ladder in `[Cypress-TL]`.
- **Auto-wait consensus** (independent validation for `wait_for`): Playwright auto-waits on
  actionability (its six checks — attached/visible/stable/receives-events/enabled/editable) before
  every action `[PW-Act]`; Cypress re-queries the DOM and re-runs assertions until pass/timeout, with
  fixed `cy.wait(N)` as the named anti-pattern `[Cypress-Retry]`; Selenium leaves waits manual and
  mixing implicit+explicit is a documented footgun `[Selenium-Waits]`. "Auto-wait beats hard-sleep" is
  an industry-wide consensus — direct precedent for folding auto-wait **into** katashiro's actions
  rather than exposing sleeps to the agent. (katashiro implements a feasible subset of the six at P0 —
  see §3.4.)

### 2.3 Scraping / spider frameworks — extraction reference only

Honest scope: Scrapy, BeautifulSoup, and Cheerio are **stateless HTML processors** — raw CSS/XPath over
a static document, **no accessibility concept, no interaction model, no auto-wait** `[Scrapy]`. Their
selector philosophy is the *opposite* of this ADR's (brittle, structure-coupled paths — exactly what
a11y+refs exists to escape); Crawlee's interaction/waiting is only inherited from a Playwright/Puppeteer
backend `[Crawlee]`. Citing spiders for the *interaction* model would import the wrong lineage. Where
they **do** earn a place is the **extraction** side: **Mozilla Readability** `[Readability]` (powers
Firefox Reader View; strips nav/ads/sidebars; HTML + plain-text out) is the best-in-class reference for
a future `get_text` tool, and Cheerio/Scrapy's traversal is the mental model if `get_text` ever grows
structured extraction.

### 2.4 Comparison

| Framework | Addressing | a11y role+name? | Stable handle | Auto-wait | Source |
|---|---|---|---|---|---|
| Testing Library | `getByRole`→`getByLabel`→`getByText`→`getByTestId` | **Yes (origin)** | testid (last resort) | `findBy*`/`waitFor` | `[TL-Queries]` |
| Playwright (test) | `getByRole`+name; CSS/XPath | **Yes (default)** | `getByTestId` | **Yes (actionability)** | `[PW-Loc]` `[PW-Act]` |
| Playwright MCP | a11y snapshot + `ref=eN` | **Yes (snapshot)** | `ref` | Yes (same engine) | `[PW-MCP]` |
| Cypress core / +TL | CSS/`data-testid` / `findByRole` | via TL plugin | **`data-testid`** | **Yes (retry-ability)** | `[Cypress-BP]` `[Cypress-TL]` `[Cypress-Retry]` |
| Selenium | By css/xpath/id | No | — | Manual | `[Selenium-Waits]` |
| Scrapy / Cheerio / BS4 | CSS/XPath | No | No | No (static) | `[Scrapy]` |
| Mozilla Readability | heuristic main-content | n/a | n/a | n/a | `[Readability]` |

### 2.5 The load-bearing distinction — author-writes-query vs tool-presents-tree

Every test framework has **a human author who already knows the element and writes a query to *locate*
it** — `getByRole('button', {name:'Submit'})` resolves one pre-known element `[TL-Queries]`; role/name
is an *input filter authored by a human*, and the framework never enumerates the page.

katashiro is the **inverse**: the agent does not know what's on the page, so the tool must **present the
whole a11y tree and let the agent pick**. Role/name here is *output metadata for disambiguation*, not an
input query. Consequences that shape the `ref` design:

- **Refs are required precisely because there is no human author to write a selector.** Test frameworks
  never needed refs — the query *is* the address. Playwright *MCP* introduced `ref=eN` the moment it
  flipped to tool-presents-tree `[PW-MCP]`. That is katashiro's closest precedent: **testing = the
  philosophy, MCP = the mechanism.**
- **The `ref` is the primary key; role+name is the human-readable label on it.** Two "Submit" buttons
  are a non-issue for a human who writes `.nth(1)`; for an agent picking from a tree, each must carry a
  distinct ref.
- **Refs are snapshot-scoped and carry a `snapshotId` (generation).** Refs are valid within one
  snapshot; any navigation/DOM mutation yields a fresh snapshot with new refs. Actions carry the
  `snapshotId` they were derived from; a mismatch is a clean error, so `e5` from an old tree can never
  silently resolve to a different node in a new tree. Cross-snapshot identity is deliberately not
  attempted — it is the class of bug that bit the Falcon "Session-not-found" work.
- **Frame and shadow coverage is part of the ref model, not an afterthought** (see §3.1): open shadow
  roots are walked at P0; refs are frame-namespaced (`fN:eM`) so a ref resolves in the right frame.

---

## 3. Decision

Adopt the **accessibility-tree snapshot + element refs** model as katashiro's primary way for an agent
to perceive and act on a page. Screenshots become a fallback for genuinely visual cases only.

### 3.1 Add a `snapshot` tool

`snapshot {}` → returns the page's accessibility tree as compact text, one line per element, with a
stable `ref` on each interactive element (format after Playwright MCP `[PW-MCP]` / `[PW-ariaSnapshot]`):

```
- heading "Sign in" [level=1]
- textbox "Email" [ref=e5] {required}
- textbox "Password" [ref=e6] {required}
- button "Submit" [ref=e7]
- link "Forgot password?" [ref=e8]
```

Rules:

- **Label each node by (role, accessible name)** following Testing Library's priority ladder (name →
  label → text → alt/title) `[TL-Queries]`; label only elements a user could act on or that carry
  meaning, not every wrapper.
- **Interactability filter — do not rely on a11y role alone.** A `<div onclick>` or a custom widget
  with no role and no accessible name is *invisible* in an a11y-only tree, so the agent could neither
  see nor click it (the most common a11y-primary failure mode, shared with Playwright MCP). The walker
  therefore also includes elements that are interactive by heuristic — `tabindex >= 0`,
  `cursor: pointer`, form controls, `contenteditable` — even when their role is generic. (Content
  scripts cannot read event listeners — `getEventListeners` is DevTools-only — so this is a heuristic,
  not exhaustive; genuinely opaque widgets remain a `screenshot` case.)
- **Open shadow DOM is walked (P0):** the walker recurses into `element.shadowRoot` for
  `mode:'open'` roots (modern web components — YouTube, most design systems — depend on this). Only
  `mode:'closed'` roots, which a content script cannot enter, fall back to screenshot/CDP power mode.
- **Frames:** same-origin iframes are walked via `contentDocument`; cross-origin iframes require
  per-frame content-script injection (`all_frames: true`), each producing its own sub-snapshot, merged
  by the side-panel with a frame prefix so refs are addressable as `fN:eM`.
- Refs are **snapshot-scoped** and carry a `snapshotId` (§2.5), reissued on the next snapshot.

### 3.2 `click` and `type` accept a `ref`

Primary target becomes `{ref}` from the most recent snapshot; `{selector}` remains a fallback `[PW-MCP]`.
The agent acts on exactly the element it just saw — no extra "construct a selector" reasoning turn, no
re-locate round-trip, no layout-shift brittleness.

- **Stale-ref is a concrete assertion, not a hope.** Before acting, the content script resolves the ref
  and checks `element.isConnected` and `element.checkVisibility()`; if the node is detached or the
  action's `snapshotId` no longer matches the current one, it throws a **`StaleRefError`** that
  instructs the agent to re-`snapshot` — it never mis-clicks a recycled node. (SPA frameworks routinely
  replace DOM nodes on update, so this check is mandatory: a `WeakMap` drops a detached node's entry,
  but a `refId → Element` strong map does not, which is exactly why the `isConnected` guard is required
  on every action.)
- **`type` must survive controlled inputs.** Setting `element.value` + dispatching `input` is ignored
  by React 18+ controlled inputs. `type` uses the native prototype setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)`, likewise
  `HTMLTextAreaElement`) and then dispatches `input` + `change`. `contenteditable` and `<select>` are
  separate code paths — not the same trick. (Implementation note; the `isTrusted=false` limitation of
  synthetic events still applies — see §3.7 / Negative.)

### 3.3 Snapshot-after-action

`navigate`, `click`, and `type` return the fresh post-action `snapshot` in the same tool result
`[PW-MCP]`. This removes the "act, then screenshot to see what happened" second turn that currently
doubles the call count — the single biggest round-trip reduction.

**Settle before snapshotting.** An action that triggers navigation or an SPA re-render often leaves the
DOM in a transitional state; snapshotting immediately captures a half-rendered tree and hands the agent
wrong refs. The post-action snapshot waits for a settle signal — DOM mutations quiet for a short window,
or `load`/`DOMContentLoaded`, bounded by a short timeout — before serializing.

### 3.4 `wait_for` and actionability (a feasible P0 subset)

`wait_for {selector? | text? | ref?, state?, timeout}` plus internal auto-wait folded into
`click`/`type`/`navigate`, so the agent never polls with screenshots to check readiness. `wait_for`
retries-until-condition, never sleep-N (the Cypress anti-pattern `[Cypress-Retry]`).

Playwright documents **six** actionability checks `[PW-Act]`, but reproducing all six in a content
script is expensive (hit-testing for *receives-events* and animation-*stable* especially). **P0
implements the cheap, high-value subset: attached + visible + enabled (+ editable for `type`);**
`stable` and `receives-events` are best-effort and may land later. `wait_for` conditions should key on
**text / role / selector**, not `ref` — a ref is snapshot-scoped, so it goes stale the moment the DOM
changes during the wait; a ref is at most a short-lived "still attached?" hint.

### 3.5 Reframe tool descriptions to demote `screenshot`

Per Anthropic's tool-design guidance, descriptions steer the model to the cheap path `[Anthropic-Tools]`:
- `snapshot`: "PRIMARY way to see the page. Returns page structure + element refs as text. Use before
  every action; prefer over screenshot."
- `screenshot`: "EXPENSIVE (large image, slow vision reasoning). ONLY when a text snapshot cannot
  answer — visual layout, images/charts/canvas, elements with no accessible name, or a widget the
  snapshot could not surface. NEVER to confirm an action succeeded — action tools already return the
  updated snapshot."
- `click`/`type`: "Pass a `ref` from the most recent snapshot. Returns the updated snapshot; do not
  screenshot afterward."

### 3.6 Reshape `read_dom`

Default `read_dom` to the snapshot format (or a filtered/paginated view) rather than raw HTML, with an
optional `concise|detailed` mode `[Anthropic-Tools]` — `detailed` adds non-interactive/structural
nodes that `snapshot` omits. To avoid tool-overlap confusion, `read_dom` and `snapshot` must document
their difference explicitly (or `read_dom` becomes a thin alias) so the model does not pick randomly.
Raw-HTML dumps are the ~3–5k-token trap `[token-cost]` and bloat every subsequent turn's context.

### 3.7 Implementation building blocks — build vs borrow

Borrow the hard ARIA computation; write only katashiro-specific glue.

- **`dom-accessibility-api` `[dom-a11y-api]` — BORROW (primary block).** Verified in source (v0.7.1):
  it exports `computeAccessibleName`, `computeAccessibleDescription`, **and `getRole`** — and `getRole`
  is a real spec-aware resolver (explicit role, implicit-role-from-tag, and the
  `presentation`/`none` conflict-resolution rules). So both **name and role** are borrowed, not glue.
  Zero runtime deps, no eval, MIT. Ships CJS/ESM only → vendor via a **one-time offline bundle to IIFE
  `'self'`** (a packaging step, not a runtime build system). **Capability boundary:** it computes
  name/role/limited state, not the full browser AXTree — relationships, live regions, and
  browser-specific ignored-node rules are approximated; genuinely full-fidelity a11y is the CDP
  power-mode path `[CDP-AXTree]`.
- **Playwright `ariaSnapshot.ts` `[PW-ariaSnapshot]` — REFERENCE-PORT, don't import.** Verified: the
  `role "name" [ref=eN]` refs are generated inside this file in its **`'ai'` render mode** (the
  `default`/`codegen`/`autoexpect` modes emit no refs), so the ref-generation logic is portable from
  that one file — it is *not* a separate MCP-layer concern. It is Apache-2.0 but coupled to Playwright's
  internal `roleUtils`/`domUtils`; copy its tree-walk + ai-mode serialization, and swap its role/name
  computation for `dom-accessibility-api`.
- **`chrome.automation` — DON'T (unsuitable as a product dependency).** It is an experimental/private
  API; `getDesktop()` is ChromeOS-only and never shipped for desktop, and the tab-tree path is on a
  deprecation track `[chrome-automation]`. Compute from the DOM instead. (The full AXTree that this
  ADR forgoes at P0 comes from **CDP** `Accessibility.getFullAXTree` `[CDP-AXTree]`, not this API.)
- **`axe-core` `[axe-core]` — DON'T.** Audit engine (~550 KB), wrong shape (rules→violations, not a
  serialized tree).
- **`aria-query` `[aria-query]` — optional.** Static ARIA role metadata; only if the interactability
  filter needs role relationships beyond what `getRole` already returns.
- Adjacent (tracked separately): **`@mozilla/readability` + DOMPurify** for a `get_text` tool
  `[Readability]`; **`@dagrejs/dagre`** for the later whiteboard DAG layout `[dagre]` (pin the scoped
  `@dagrejs` package — the unscoped `dagre` is stale).

**Glue katashiro must write itself (no lib covers it):** (1) the ref registry — a **content-script,
per-frame** `Map<refId, Element>` for resolution plus a `WeakMap<Element, refId>` for stable re-issue
*within* a snapshot; the side-panel holds only `ref → {tabId, frameId, generation}`; (2) the tree
walker + snapshot serialization, including the interactability filter (§3.1), open-shadow recursion,
and the settle wait (§3.3); (3) frame merge + `fN:eM` addressing and message routing back to the owning
frame; (4) the MCP tool surface (`snapshot`/`click(ref)`/`type(ref)`/`get_text`) + content-script ↔
side-panel plumbing, including the `snapshotId`/`StaleRefError` contract.

> The offline-bundle requirement (vendoring CJS/ESM libs as `'self'` IIFE) is itself a decision worth a
> companion ADR on katashiro's vendoring/build strategy.

---

## Consequences

### Positive
- Per-observation cost drops roughly an order of magnitude (~10–15× per Playwright's own table; higher
  on extreme pages, blog-sourced) — text tree vs image `[PW-MCP]` `[token-cost]`; no vision inference
  on the hot path.
- Round-trips are *expected* to roughly halve: snapshot-after-action removes the confirm turn;
  ref-targeting removes the re-locate turn — the two dominant contributors to the measured 46 s turn.
  (Expectation, not a guarantee.)
- Deterministic interaction (ref/role/name) instead of CSS/viewport-brittle selectors.
- Residual screenshots confined to the genuine visual-verification minority.
- Aligns katashiro with a model validated by *two* lineages: agent tools `[PW-MCP]` `[CDT-MCP]`
  `[Stagehand]` and the testing world `[TL-Queries]` `[PW-Loc]` `[Cypress-TL]`.

### Negative / tradeoffs
- New work: a content-script a11y walker + a per-frame ref registry, frame merge, and the settle/stale
  machinery.
- The content-script a11y tree is an **approximation** of the browser's true a11y tree (the full tree
  is CDP-only `[CDP-AXTree]`); custom widgets with poor ARIA are surfaced only via the interactability
  heuristic (§3.1), and truly opaque ones remain a `screenshot` case.
- **Closed** shadow roots and **cross-origin** iframes are hard boundaries: closed shadow is invisible
  to content scripts (power-mode only); cross-origin iframes need per-frame injection + routing.
- Synthetic content-script events are `isTrusted=false`; some strict sites ignore them — trusted input
  is a later CDP upgrade. Controlled inputs need the prototype-setter workaround (§3.2).
- **Walker cost:** computing visibility with `getComputedStyle`/`getBoundingClientRect` over a large DOM
  can force reflow and is itself a latency source on huge pages — the serializer needs a node budget /
  short-circuits, which is mildly ironic given the perf motivation.
- Snapshot-scoped ref lifetime means the agent must re-snapshot after page changes; a stale ref must
  fail cleanly (§3.2).

### Neutral
- `screenshot` stays in the toolset; only its role and description change.
- Selector-based `click`/`type` remain as a fallback, so existing flows keep working during migration.

---

## 4. Alternatives Considered

- **Keep screenshot-primary, fix with prompting only.** Rejected: the pathology is structural — with
  screenshot first-class and no snapshot/ref system, the model is *forced* into the see→reason→act→see
  loop. Descriptions help `[Anthropic-Tools]` but can't substitute for the missing primitives.
- **Full CDP `Accessibility.getFullAXTree` via `chrome.debugger` now `[CDP-AXTree]`.** Rejected for P0:
  needs the `debugger` permission, shows the persistent "started debugging this browser" infobar,
  conflicts with open DevTools. Deferred to opt-in power mode; the content-script approximation covers
  most pages (incl. open shadow DOM) with zero new permissions.
- **Richer raw-DOM extraction / CSS-selector locators (the scraping model `[Scrapy]`).** Rejected:
  raw DOM and CSS/XPath are the token-heavy, structure-brittle approach the ecosystem moved away from;
  the a11y tree is leaner and semantically closer to what the model needs.
- **Human-authored `data-testid` handles (the Cypress model `[Cypress-BP]`).** Not applicable: katashiro
  drives arbitrary third-party pages it does not author, so it cannot rely on page-provided test-ids;
  the tool-minted `ref` is the necessary equivalent (§2.5).

---

## 5. Scope & Non-Goals

- **In scope (P0, content-script):** `snapshot` + refs (incl. open-shadow walk, same-origin frames,
  interactability filter, `snapshotId`/`StaleRefError`), `wait_for` + the actionability subset,
  snapshot-after-action with settle, ref-accepting `click`/`type` (incl. controlled-input setter),
  description reframing, `read_dom` reshape. Uses existing `activeTab`/host grants; snapshotting an
  arbitrary third-party page still needs that page's host permission (activeTab gesture or
  `optional_host_permissions`) — not literally "zero permissions for any site."
- **Out of scope (later / opt-in power mode):** CDP full a11y tree `[CDP-AXTree]`, closed shadow DOM,
  trusted input, file upload, network interception, PDF — each requires `chrome.debugger`.
- **Cross-origin iframe frame-merge/routing** is P0 *architecture* (refs must be frame-namespaced from
  day one) even if deep cross-origin support lands incrementally.
- **Extraction lineage (separate):** a `get_text` tool based on Mozilla Readability `[Readability]` is
  tracked separately; §2.3 records it as extraction precedent, not part of this interaction ADR.
- This ADR governs the **perception/interaction model** only; breadth tools (scroll, tabs, evaluate,
  etc.) and the messaging/whiteboard work are tracked separately.

---

## References

**Agent tools**
- **[PW-MCP]** Playwright MCP — Snapshots (refs, snapshot-after-action, token comparison) — https://playwright.dev/mcp/snapshots
- **[PW-ariaSnapshot]** Playwright — `packages/injected/src/ariaSnapshot.ts` (`ai`-mode `role "name" [ref=eN]` generator, Apache-2.0) — https://github.com/microsoft/playwright/blob/main/packages/injected/src/ariaSnapshot.ts
- **[CDT-MCP]** Chrome DevTools MCP — tool reference — https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
- **[Stagehand]** Stagehand (act/observe/extract) — https://docs.stagehand.dev/
- **[browser-use]** browser-use — available tools — https://docs.browser-use.com/open-source/customize/tools/available
- **[Anthropic-Tools]** Anthropic — Writing effective tools for AI agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- **[token-cost]** a11y-tree vs screenshot/DOM token cost — blog estimate, not an authoritative benchmark — https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a

**Testing frameworks (origin of the role/name model)**
- **[TL-Queries]** Testing Library — About Queries (priority ladder) — https://testing-library.com/docs/queries/about/
- **[TL-Principles]** Testing Library — Guiding Principles — https://testing-library.com/docs/guiding-principles/
- **[TL-Origin]** Kent C. Dodds — origin (2018) — https://x.com/kentcdodds/status/977018512689455106
- **[PW-Loc]** Playwright — Locators (getByRole recommended) — https://playwright.dev/docs/locators
- **[PW-Act]** Playwright — Auto-waiting / actionability (six checks) — https://playwright.dev/docs/actionability
- **[Cypress-Retry]** Cypress — Retry-ability — https://docs.cypress.io/app/core-concepts/retry-ability
- **[Cypress-BP]** Cypress — Best Practices (data-testid) — https://docs.cypress.io/app/core-concepts/best-practices
- **[Cypress-TL]** Cypress Testing Library — https://testing-library.com/docs/cypress-testing-library/intro/
- **[Selenium-Waits]** Selenium — Waiting Strategies — https://www.selenium.dev/documentation/webdriver/waits/

**Scraping / extraction (extraction reference only)**
- **[Readability]** Mozilla Readability — https://github.com/mozilla/readability
- **[Scrapy]** Scrapy — Selectors — https://docs.scrapy.org/en/latest/topics/selectors.html
- **[Crawlee]** Crawlee — https://github.com/apify/crawlee

**Implementation libraries (build vs borrow)**
- **[dom-a11y-api]** `dom-accessibility-api` (accessible name + `getRole`; Testing Library's engine; MIT; v0.7.1) — https://github.com/eps1lon/dom-accessibility-api
- **[aria-query]** `aria-query` (static ARIA role metadata; Apache-2.0) — https://github.com/A11yance/aria-query
- **[axe-core]** Deque axe-core (audit engine — considered, rejected) — https://github.com/dequelabs/axe-core
- **[chrome-automation]** `chrome.automation` (experimental/private; `getDesktop` ChromeOS-only — rejected) — https://developer.chrome.com/docs/extensions/reference/api
- **[CDP-AXTree]** Chrome DevTools Protocol — Accessibility domain (`getFullAXTree`, the power-mode full-tree source) — https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/
- **[dagre]** `@dagrejs/dagre` (DAG layout for the later whiteboard; MIT) — https://github.com/dagrejs/dagre

**Local**
- Design note: `/workspace/drafts/katashiro_capability_and_messaging_plan.md` (Part 1)
- Round-1 review (Falcon / Mira / Orca), 2026-08-02 — findings incorporated in Rev. 2.
