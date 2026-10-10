# Testing Katashiro Browser Tools (MCP-over-ACP)

Katashiro is the **extension (client) side** of MCP-over-ACP browser control. The OpenAB
server side is deployed (Falcon) and the full loop is e2e-proven with a mock browser — loading
katashiro in Chrome replaces the mock with a real browser so the agent operates your live tab.

## Prerequisites

- An OpenAB agent with the browser-control build + `cursor-agent --approve-mcps`.
  Falcon: `ws://192.168.139.2:8080/acp` (transport token in the `falcon-acp-auth` k8s secret).

## Load the extension

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → select the `katashiro/` folder.
2. Pin it and click the **Katashiro** icon to open the Side Panel.

## Connect

3. **Settings (⚙️)** → set the endpoint to the OpenAB `/acp` URL and paste the transport token
   → **Save and Reconnect**. The status dot should go green.
   - The token is entered here at runtime — never embedded in code.
   - The browser passes it via the WebSocket subprotocol (`openab.bearer.<token>`), so it stays out of the URL.

## Try a browser tool

4. Open any web page in the active tab, and **keep the Katashiro side panel open** — it hosts
   the MCP server and executes the tools in the active tab.
5. In the chat, ask the agent to use a browser tool, e.g.:
   - "Read this page with `katashiro.read_dom` and summarize it."
   - "Click the first link on this page." / "Navigate to example.com."
6. The agent discovers the tools (`tools/list`), calls one (`tools/call`) → it executes in your
   active tab → the result flows back to the agent.

## Tools served

The surface — params, returns, and which tools count as writes — is tabulated in
[README → The tools we serve](README.md#the-tools-we-serve). Kept in one place so the two
documents cannot drift.

Two things to expect while testing: a failure (no active tab, restricted page like `chrome://`,
missing element, missing host permission) returns an MCP `isError` result the agent can see and
adapt to; and **`click` / `type` / `navigate` are refused until you turn act mode on**
(Settings → 瀏覽器寫入 → ✋ 可操作), so enable it before testing the write tools.

## Notes

- The side panel must stay open (the tunnel and tool execution live in `sidepanel.js`).
- No separate demo page is needed — the extension **is** the client. For a headless protocol
  check of the tunnel without a browser, see `scripts/acp-ws-smoke.py` (tunnel section) in the
  openab repo, which drives the gateway with a mock extension.
- Contract: `docs/mcp-over-acp-tunnel-contract.md` in the openab repo.
- **Canvas folder mirror (ADR §3.6):** Settings → 畫布存到資料夾 → 📁 選擇資料夾, pick an empty
  folder, then let the agent write a canvas: `<folder>/c_…/<title>.md` appears, plus
  `.katashiro/<id>.json`. Edit the `.md` in an editor and save in the canvas: the file is left
  alone, a `<title>.katashiro-<UTC time>.md` appears beside it, and the canvas header shows
  "📁 檔案在 Katashiro 外被修改過". Delete the `.md` and reopen the canvas tab: "資料夾裡的檔案不見了";
  the next save writes it again. Restart Chrome: the canvas header shows **📁 Reconnect folder**
  (unless Chrome kept the grant); saves made before reconnecting are written after it.
- **Canvas eviction without filling 200 MB:** in the side panel's DevTools console, run
  `chrome.storage.local.set({ "canvas:budgetBytes": 2 * 1024 * 1024 })`. The budget is now 2 MB, so a
  few image canvases trigger the eviction prompt. Run `chrome.storage.local.remove("canvas:budgetBytes")`
  to go back to 200 MB. Both take effect without a reload. Values under 1 MB are ignored, and
  values over 200 MB are capped at 200 MB.
