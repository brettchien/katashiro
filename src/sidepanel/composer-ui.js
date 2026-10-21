// Katashiro side panel — composer: pasted-image staging and dropped files (staged attachments and
// their previews), the send button state, the send itself (sendMessage, with the page target's tab
// check chain) and ⏹, the ↩ reply target and its chip, the 💬 Ask agent on a web page target, and
// the chat-selection 💬. Moved verbatim out of sidepanel.js (plan B, step 3); no logic change.
//
// Classic script, loaded by sidepanel.html after conversations.js and BEFORE canvas-glue.js, cards.js
// and sidepanel.js; all scripts share one global scope. Load-order rule: this file holds
// declarations only. Its top level must not run anything that touches a name declared in a
// later-loaded file (DOM refs, room state, …) — that would be a TDZ ReferenceError at load. Its
// initializers are plain values only (literals, [], new Set(), Promise.resolve()). Function bodies may use names from any file,
// later-loaded ones included (sendMessage calls closeCmdMenu in cards.js and postUserText in
// sidepanel.js): they only run once every script has loaded. The wiring that runs at load (the
// drop, input, paste, keydown, send, ⏹, focus, selectionchange listeners, the page-ask onMessage
// listener, the 💬 pill) and the DOM refs it reads (attach-preview, the drop zone, reply-chip, the
// input's placeholder) stay in sidepanel.js, at the spot these sections came from, so their order is
// unchanged.

// --- Pasted-image staging ----------------------------------------------------
// Screenshots pasted into the composer are staged as ACP image content blocks and previewed
// before send. Kept in memory only (never persisted to history) to avoid bloating storage.local.
// Composer owns the rules (accepted types, paste classification, the per-turn size budget).
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;              // refuse to even decode beyond this
let stagedImages = [];                                   // [{ mimeType, data(base64), dataUrl }]
let stagedFiles = [];                                    // dropped text files: [{ name, size, text }]
let stagingChain = Promise.resolve();                    // serialize pastes so the budget check holds
let stagingPending = 0;                                  // pastes still encoding — send waits for them

// 💬 Ask agent on a page (§2.4): the panel cannot take the keyboard focus from the page, so until
// the input gets it the placeholder says to click there (clearPageAskHint).
let pageAskHint = false;
function updateSendEnabled() {
  const missing = convAgentMissing(conversationId);      // agent-per-conversation §2.6: read-only
  messageInput.disabled = missing;
  messageInput.placeholder = missing ? "agent 已移除：這段對話無法再傳訊息" : pageAskHint ? PageAskCore.INPUT_HINT : messageInputPlaceholder;
  sendBtn.disabled = missing || stagingPending > 0
    || (messageInput.value.trim().length === 0 && stagedImages.length === 0 && stagedFiles.length === 0);
}

function renderStagedPreviews() {
  if (!attachPreview) return;
  attachPreview.textContent = "";
  stagedImages.forEach((img, i) => {
    const thumb = document.createElement("div");
    thumb.className = "attach-thumb";
    const el = document.createElement("img");
    el.src = img.dataUrl;                                // our own canvas/FileReader output, safe
    el.alt = "pasted image";
    const rm = document.createElement("button");
    rm.className = "attach-remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => { stagedImages.splice(i, 1); renderStagedPreviews(); updateSendEnabled(); });
    thumb.append(el, rm);
    attachPreview.appendChild(thumb);
  });
  // Text files: a chip (name + size), expanded into the prompt only on send (ADR chat-attachments §2.4).
  stagedFiles.forEach((f, i) => {
    const chip = fileChipEl(f);
    const rm = document.createElement("button");
    rm.className = "attach-remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => { stagedFiles.splice(i, 1); renderStagedPreviews(); updateSendEnabled(); });
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
  attachPreview.hidden = stagedImages.length === 0 && stagedFiles.length === 0;
}

// A text attachment as a chip — in the composer and in the sent bubble. Text only (textContent).
function fileChipEl(f) {
  const chip = document.createElement("div");
  chip.className = "attach-file";
  const name = Composer.displayName(f.name);
  chip.title = name;
  const label = document.createElement("span");
  label.className = "attach-file-name";
  label.textContent = `📎 ${name}`;
  const size = document.createElement("span");
  size.className = "attach-file-size";
  size.textContent = Composer.formatBytes(f.size);
  chip.append(label, size);
  return chip;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Fit one image into `budget` base64 chars: as-is if it is already small enough, else downscaled
// to MAX_IMAGE_EDGE and re-encoded as JPEG at falling quality. null if it still does not fit.
async function encodeForAgent(blob, budget) {
  const bmp = await createImageBitmap(blob);
  try {
    const { width, height } = Composer.fitDimensions(bmp.width, bmp.height, Composer.MAX_IMAGE_EDGE);
    if (width === bmp.width && height === bmp.height) {
      const img = Composer.parseImageDataUrl(await blobToDataUrl(blob));
      if (img && img.data.length <= budget) return img;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx2d = canvas.getContext("2d");
    ctx2d.fillStyle = "#fff";                            // JPEG has no alpha — flatten onto white
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.drawImage(bmp, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const img = Composer.parseImageDataUrl(await blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality })));
      if (img && img.data.length <= budget) return img;
    }
    return null;
  } finally {
    bmp.close();
  }
}

// `target` = the conversation it was pasted / dropped in: a switch while it encodes must not move it
// into another conversation's composer (multi-conversation §4.8).
async function stageImages(blobs, target = currentConv) {
  for (const blob of blobs) {
    if (blob.size > MAX_SOURCE_BYTES) {
      appendSystemMessage(`圖片太大（約 ${Math.round(blob.size / 1048576)}MB），未附加`);
      continue;
    }
    if (!stagingTarget(target)) return;                  // its conversation was archived meanwhile
    const budget = Composer.MAX_TOTAL_IMAGE_B64 - Composer.stagedSize(stagingTarget(target).images);
    let img = null;
    try {
      img = budget > 0 ? await encodeForAgent(blob, budget) : null;
    } catch {
      appendSystemMessage("無法讀取這張圖片，未附加");
      continue;
    }
    if (!img) {
      appendSystemMessage("圖片超過單次傳送上限（所有圖片合計約 1MB，已縮小並壓縮過），未附加");
      continue;
    }
    const into = stagingTarget(target);
    if (!into) return;
    into.images.push({ ...img, dataUrl: `data:${img.mimeType};base64,${img.data}` });
    if (into.live) { renderStagedPreviews(); updateSendEnabled(); }
  }
}

// --- Dropped files (ADR docs/adr/chat-attachments.md) -------------------------
// The whole chat area takes files; what a file is comes from its bytes (Composer). Images join the
// paste pipeline above; text files become chips. Everything stays in memory.

async function stageDroppedFiles(files, target = currentConv) {
  const at = stagingTarget(target);
  if (!at) return;
  const plan = Composer.planDrop(at.images.length + at.files.length,
    files.map((f) => ({ size: f.size })), attachConfig.maxFileMB * 1024 * 1024);
  const names = (idx) => idx.map((i) => Composer.displayName(files[i].name)).join("、");
  if (plan.tooBig.length) appendSystemMessage(`檔案超過大小上限 ${attachConfig.maxFileMB} MB（${names(plan.tooBig)}），未附加。可到設定 → 附加檔案調整。`);
  if (plan.overCount.length) appendSystemMessage(`一則訊息最多附加 ${Composer.MAX_ATTACHMENTS} 個檔案（${names(plan.overCount)} 未附加）。`);
  const images = [];
  const binary = [];
  for (const i of plan.accept) {
    const file = files[i];
    const name = Composer.displayName(file.name);
    let kind;
    try {
      const head = new Uint8Array(await file.slice(0, Composer.SNIFF_BYTES).arrayBuffer());
      kind = Composer.classifyFileBytes(head, file.size <= Composer.SNIFF_BYTES).kind;
    } catch {
      appendSystemMessage(`無法讀取 ${name}（是資料夾嗎？），未附加`);
      continue;
    }
    if (kind === "image") { images.push(file); continue; }
    if (kind === "binary") { binary.push(name); continue; }
    // Never sendable at any cap setting — refuse before reading the whole file into memory.
    const hardCapKB = Composer.ATTACH_LIMITS.textCapKB[1];
    if (file.size > hardCapKB * 1024) {
      appendSystemMessage(`文字檔 ${name}（${Composer.formatBytes(file.size)}）超過可傳送的最大上限 ${Composer.formatBytes(hardCapKB * 1024)}，未附加`);
      continue;
    }
    let text = null;
    try { text = Composer.decodeText(new Uint8Array(await file.arrayBuffer())); } catch { /* reported below */ }
    if (text === null) {
      appendSystemMessage(`${name} 不是有效的 UTF-8 文字檔，未附加`);
      continue;
    }
    const into = stagingTarget(target);
    if (!into) return;
    into.files.push({ name: file.name, size: file.size, text });
    if (into.live) { renderStagedPreviews(); updateSendEnabled(); }
  }
  if (binary.length) appendSystemMessage(`不支援的檔案類型（看起來是二進位檔）：${binary.join("、")}，未附加`);
  if (!images.length) return;
  const active = connOfConv(target ? target.id : conversationId);   // §2.7: the staging conversation's agent
  if (active && active.acpReady && !active.canImage) {
    appendSystemMessage(`${active.name} 不支援圖片，未附加`);
    return;
  }
  await stageImages(images, target);
}

function dragHasFiles(e) {
  return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
}
function inDropZone(node) {
  return !!(chatDropZone && chatView.classList.contains("active") && node && chatDropZone.contains(node));
}
function setDropHighlight(on) {
  if (chatDropZone) chatDropZone.classList.toggle("drop-active", on);
}

// --- Message input -----------------------------------------------------------
// Stop the on-screen conversation's in-flight turn (each conn sends its own session/cancel). ⏹,
// Ctrl/⌘+., the menu's Cancel and a typed /cancel all come here.
function stopReplyOnScreen() { if (conversationId) room.forEach((c) => c.cancelTurn(conversationId)); }

// Sends waiting for a page target's tab check (§2.4), in order: null when none is pending.
let pageSendChain = null;
function afterPageSend(fn) {
  const p = (pageSendChain || Promise.resolve()).then(fn).catch((e) => console.warn("katashiro: send failed:", e));
  pageSendChain = p;
  p.then(() => { if (pageSendChain === p) pageSendChain = null; });
}

// Send a user turn to the on-screen conversation's agent, under a [time user (↩ quoted)] header
// (RoomCore.framePrompt; the gateway adds its own sender_context on top).
function sendMessage() {
  // A command (CommandCore.parseCommand: "/" + a letter first, no leading space) is never sent as a
  // message: ours run, anything else stays in the composer with a hint. With the typed menu open,
  // send runs its selected entry, like Enter.
  if (cmdMenuState && cmdMenuState.via === "typed") { runCmdMenuItem(cmdMenuState.items[cmdMenuState.selected].id); return; }
  const cmd = CommandCore.parseCommand(messageInput.value);
  if (cmd) {
    closeCmdMenu();
    if (cmd.id === "unknown") showComposerHint(CommandCore.TEXT.noSuchCommand);
    else if (runCommand(cmd)) clearComposer();
    return;
  }
  if (!currentConv) { appendSystemMessage("目前沒有開著的對話：先封存一段，或從 🗂️ 總覽重新打開。"); return; }
  if (convAgentMissing(conversationId)) { appendSystemMessage(ConvCore.AGENT_REMOVED_TEXT); return; }
  const text = messageInput.value.trim();
  const images = stagedImages.slice();                   // snapshot the staged attachments
  const files = stagedFiles.slice();
  if (stagingPending > 0) return;                        // Enter mid-encode: don't strand the image for the next message
  if (!text && images.length === 0 && files.length === 0) return;
  // Text cap on send (ADR chat-attachments §2.3): refuse, never truncate; keep everything staged.
  const capError = Composer.textCapError(files, attachConfig.textCapKB * 1024);
  if (capError) { appendSystemMessage(capError); return; }
  const replyTo = replyTarget;                           // what this message answers (or null)
  setReplyTarget(null);
  const post = (pageAt) => {
    if (!postUserText(text, images, replyTo, files, pageAt).length) appendSystemMessage("訊息沒有送出：這段對話的 agent 目前沒有連線（看上方 chip 的狀態，或稍後再送）。");
    // Q6 (multi-conversation §4.3): at the send — never mid-turn — bring the conversation's working
    // tab to the front if the user is looking at another tab.
    switchToWorkingTab(conversationId).catch(() => {});
  };
  // 💬 Ask agent on a page (ADR page-send-to-agent §2.4): at Enter, look at the tab again — closed,
  // or navigated to another document, is said in the prompt. That look is async, so this send (and
  // any typed right after it) waits for it, in order; a plain send with none pending goes at once.
  if (replyTo && replyTo.page) {
    const cid = conversationId;
    afterPageSend(async () => {
      const at = PageAskCore.tabStateAtSend(replyTo.page, await getTab(replyTo.page.tabId));
      if (conversationId !== cid) { appendSystemMessage("訊息沒有送出：送出前切換了對話，請再送一次。"); return; }
      post(at);
    });
  } else if (pageSendChain) {
    const cid = conversationId;
    afterPageSend(() => { if (conversationId === cid) post(); else appendSystemMessage("訊息沒有送出：送出前切換了對話，請再送一次。"); });
  } else post();

  messageInput.value = "";
  messageInput.style.height = "auto";
  stagedImages = [];
  stagedFiles = [];
  renderStagedPreviews();
  sendBtn.disabled = true;
}

// --- reply-to ------------------------------------------------------------------------------------
// ↩ on a message → a quote chip above the input; the next send answers it (framed in the prompt as
// "↩ HH:MM:SS sender「excerpt」"). The chip shows who/when/what; ✕ or Esc cancels.
let replyTarget = null;                                  // { id, senderName, timestamp, text, selection? } or null

// How a sender appears to the agent: the user's own messages are "user" (the panel calls them "You").
function promptName(name) {
  return name === myUserName ? "user" : (name || "?");
}

function setReplyTarget(t) {
  replyTarget = t || null;
  if (!(replyTarget && replyTarget.page)) clearPageAskHint();
  if (!replyChip) return;
  replyChip.replaceChildren();
  replyChip.hidden = !replyTarget;
  if (!replyTarget) return;
  const label = document.createElement("span");
  label.className = "reply-chip-text";
  const page = replyTarget.page;
  const sel = replyTarget.selection;
  if (page) {
    // 💬 Ask agent on a page (§2.4): what the chip carries was read at the click; it does not
    // watch the tab. A click brings the tab forward, as the sent message's 📄 quote does.
    const h = PageAskCore.historyPage(page);
    label.textContent = PageAskCore.chipText(page);
    label.title = RoomCore.excerpt(page.kind === "selection" ? page.selection : h.excerpt, 400);
    label.addEventListener("click", () => activatePageTab(h, replyTarget && replyTarget.convId));
  } else {
    label.textContent = sel
      ? `💬 針對 ${replyTarget.senderName || "?"} ${RoomCore.uiTime(replyTarget.timestamp)} 選取的文字：「${RoomCore.excerpt(sel, 60)}」`
      : `↩ 回覆 ${replyTarget.senderName || "?"} ${RoomCore.uiTime(replyTarget.timestamp)}：「${RoomCore.excerpt(replyTarget.text, 60)}」`;
    label.title = RoomCore.excerpt(sel || replyTarget.text, 400);
    label.addEventListener("click", () => jumpToMessage(replyTarget && replyTarget.id));
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "reply-chip-cancel";
  x.textContent = "✕";
  x.title = "取消回覆";
  x.addEventListener("click", () => setReplyTarget(null));
  replyChip.append(label, x);
  messageInput.focus();
}

// The small "↩ sender time：excerpt" line above a reply's bubble; click jumps to the original.
function replyQuoteEl(replyTo) {
  const q = document.createElement("div");
  q.className = "reply-quote";
  const when = Number.isFinite(replyTo.timestamp) ? RoomCore.uiTime(replyTo.timestamp) : "?";
  // A 💬 selection quotes the selected text, not the whole message.
  q.textContent = replyTo.selection
    ? `↩ ${replyTo.senderName || "?"} ${when} 選取：「${RoomCore.excerpt(replyTo.selection, 80)}」`
    : `↩ ${replyTo.senderName || "?"} ${when}：${RoomCore.excerpt(replyTo.text, 80)}`;
  if (!replyTo.id) q.classList.add("missing");
  q.title = "跳到原訊息";
  q.addEventListener("click", () => jumpToMessage(replyTo.id));
  return q;
}

// --- 💬 Ask agent on a web page (ADR docs/adr/page-send-to-agent.md) ------------------------------
// Chrome's own context menu on a web page → the service worker (background.js) opens this panel,
// collects the selection or the right-clicked element, and hands it here (a runtime message, and
// storage.session for a panel only now opening). The panel picks the conversation (§2.3), makes
// the tab its working tab, and puts the page target in the reply chip — nothing is sent until the
// user types and presses Enter (§2.4); the agent then gets the text and the page as fenced data (§2.5).

// The sent message's 📄 quote (§2.6); a click brings that tab forward if it is still open.
function pageQuoteEl(page, convId) {
  const q = document.createElement("div");
  q.className = "reply-quote page-quote";
  q.textContent = PageAskCore.quoteText(page);
  q.title = `${page.url}\n（點一下切到那個分頁）`;
  q.addEventListener("click", () => activatePageTab(page, convId));
  return q;
}

// The tab a page target came from: by id (same origin), else a tab of the conversation's group with
// the same origin and path (PageAskCore.quoteTab). Nothing when it is gone.
async function activatePageTab(page, convId) {
  if (!page) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
  const groupId = convId ? await liveGroupId(convId).catch(() => null) : null;
  const tab = PageAskCore.quoteTab({ tabs, tabId: page.tabId, url: page.url, groupId });
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== panelWindowId) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) { /* closed meanwhile */ }
}

// §2.4: flash the input once; the placeholder says to click there until the input has the focus.
function hintPageAskInput() {
  messageInput.classList.remove("page-ask-flash");
  void messageInput.offsetWidth;                         // restart the animation
  messageInput.classList.add("page-ask-flash");
  if (document.hasFocus() && document.activeElement === messageInput) return;
  pageAskHint = true;
  updateSendEnabled();
}
function clearPageAskHint() {
  if (!pageAskHint) return;
  pageAskHint = false;
  updateSendEnabled();
}

// One page target per request id: the message and the stored copy both arrive for an open panel.
const handledPageAsks = new Set();
async function handlePageAsk(p) {
  if (handledPageAsks.has(p.reqId)) return;
  handledPageAsks.add(p.reqId);
  const k = `${PageAskCore.HANDOFF_KEY_PREFIX}${panelWindowId}`;
  try {
    const got = await chrome.storage.session.get(k);
    if (got[k] && got[k].reqId === p.reqId) await chrome.storage.session.remove(k);
  } catch (_) { /* no storage.session */ }
  const notice = PageAskCore.noticeText(p);              // nothing readable (§2.2 step 3, Q8)
  if (notice) { appendSystemMessage(notice); return; }
  // §2.3: the tab's group's conversation if it is open in this panel, else the one on screen.
  const openGroups = await Promise.all([...convs.keys()].map(async (id) => ({ id, groupId: await liveGroupId(id).catch(() => null) })));
  const pick = PageAskCore.chooseConversation({
    groupId: p.groupId, openGroups, currentId: currentConv ? conversationId : null, agentMissing: (id) => convAgentMissing(id),
  });
  if (pick.error) { appendSystemMessage(pick.error === "agent-removed" ? ConvCore.AGENT_REMOVED_TEXT : PageAskCore.NO_CONVERSATION_TEXT); return; }
  if (pick.switchTo) switchConversation(pick.id);        // P2: never blocked, a running reply continues behind
  if (conversationId !== pick.id) return;
  // §4.3: the agent's page tools act on this tab next. Never moved into a group (Q7, §4.1).
  noteWorkingTab(pick.id, p.tabId).catch(() => {});
  setReplyTarget({ page: p, convId: pick.id });          // replaces a ↩ / 💬 chip: one target per message
  hintPageAskInput();
}

// A panel opened by the menu click itself: the service worker left the page target in
// storage.session (written by the service worker, so it is not a page's word) — taken if < 60 s old.
async function pickUpPageAsk() {
  if (panelWindowId == null) return;
  const k = `${PageAskCore.HANDOFF_KEY_PREFIX}${panelWindowId}`;
  let r = null;
  try { r = (await chrome.storage.session.get(k))[k]; } catch (_) { return; }
  if (!r) return;
  const p = PageAskCore.handoffFresh(r, Date.now()) ? PageAskCore.acceptPayload(r) : null;
  if (!p || String(p.windowId) !== String(panelWindowId)) {
    try { await chrome.storage.session.remove(k); } catch (_) { /* best effort */ }
    return;
  }
  handlePageAsk(p);
}

function attachReplyButton(contentEl, target) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "reply-btn";
  b.textContent = "↩";
  b.title = "回覆這則";
  b.addEventListener("click", () => setReplyTarget(target));
  // Beside the message's time ("19:04 (TPE) ↩", Brett): never on top of the bubble's own controls
  // (code-block copy) or the tool pills. Falls back to the content box if a row has no timestamp.
  const ts = contentEl.querySelector(":scope > .timestamp");
  (ts || contentEl).appendChild(b);
}

// 💬 on text selected in a chat message (the chat's counterpart of the canvas's 💬 Ask agent): a
// small 💬 beside the selection makes it the reply target — the chip says 💬 針對…選取的文字 — and
// focuses the input; the request is typed there and sent as usual (Enter, attachments and Esc work
// as for ↩). The agent gets the ↩ header with the selection's excerpt, and the whole selection as
// data after the text (RoomCore.withSelection). Only within one finished message's bubble: a
// selection across messages, in a streaming reply, or outside the bubbles shows nothing.
let selAsk = null;                                       // { target, text } while the 💬 is shown

function chatSelection() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const range = sel.getRangeAt(0);
  const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const a = elOf(range.startContainer), b = elOf(range.endContainer);
  const bubble = a && a.closest(".bubble");
  if (!bubble || bubble !== (b && b.closest(".bubble")) || !messagesList.contains(bubble)) return null;
  const row = bubble.closest(".message[data-msg-id]");
  const conv = currentConv;
  if (!row || !conv || !row.parentElement || row.parentElement !== chatList) return null;
  if (convAgentMissing(conversationId)) return null;     // read-only conversation: nothing can be sent
  const rec = (conv.messages || []).find((m) => m.id === row.dataset.msgId);
  if (!rec || rec.kind === "error") return null;         // still streaming (no record yet), or trimmed
  const text = sel.toString();
  if (!text.trim()) return null;
  const rects = range.getClientRects();
  const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  return { target: { id: rec.id, senderName: rec.senderName, timestamp: rec.timestamp, text: rec.text }, text, last };
}

function updateSelAsk() {
  const s = chatSelection();
  const box = messagesList.getBoundingClientRect();
  // Beside the selection's end, inside the messages area; hidden once that end scrolls out of view.
  if (!s || s.last.bottom < box.top || s.last.top > box.bottom) { selAsk = null; selAskPill.hidden = true; return; }
  selAsk = { target: s.target, text: s.text };
  selAskPill.hidden = false;
  const w = selAskPill.offsetWidth || 28, h = selAskPill.offsetHeight || 24;
  let top = s.last.bottom + 4;
  if (top + h > box.bottom) top = Math.max(box.top, s.last.top - h - 4);
  const left = Math.min(Math.max(box.left + 4, s.last.right - w / 2), box.right - w - 4);
  selAskPill.style.left = `${left}px`;
  selAskPill.style.top = `${top}px`;
}

let selAskFrame = 0;
function scheduleSelAsk() {
  if (selAskFrame) return;
  selAskFrame = requestAnimationFrame(() => { selAskFrame = 0; updateSelAsk(); });
}
