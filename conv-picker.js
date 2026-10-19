// conv-picker.js — the 移到其他對話 picker (ADR multi-conversation §7.3), shared by the canvas tab and
// the gallery: a modal <dialog> listing conversations (ConvCore.moveTargets), filtered by a search box.
// textContent only (titles are agent- or user-written). → the picked conversation id, or null.
(function (root) {
  "use strict";

  /**
   * open({ heading, hint, rows: (query) => [{ id, title, time, archived }] }) → Promise<id | null>.
   * `rows` is called again on each keystroke (the caller filters, ConvCore.moveTargets).
   */
  function open({ heading, hint, rows }) {
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.className = "conv-picker";
      const h = document.createElement("h2");
      h.className = "conv-picker-heading";
      h.textContent = heading;
      const p = document.createElement("p");
      p.className = "conv-picker-hint";
      p.textContent = hint || "";
      const search = document.createElement("input");
      search.type = "search";
      search.className = "conv-picker-search";
      search.placeholder = "搜尋對話名稱";
      search.setAttribute("aria-label", "搜尋對話名稱");
      const list = document.createElement("ul");
      list.className = "conv-picker-list";
      const empty = document.createElement("p");
      empty.className = "conv-picker-empty";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "canvas-btn conv-picker-cancel";
      cancel.textContent = "取消";

      let done = false;
      const finish = (id) => {
        if (done) return;
        done = true;
        try { dlg.close(); } catch (_) { /* already closed */ }
        dlg.remove();
        resolve(id);
      };
      const render = () => {
        const shown = rows(search.value);
        list.replaceChildren(...shown.map((r) => {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.className = "conv-picker-row";
          b.dataset.id = r.id;
          const t = document.createElement("span");
          t.className = "conv-picker-title";
          t.textContent = r.title;
          const m = document.createElement("span");
          m.className = "conv-picker-meta";
          m.textContent = [r.archived ? "已封存" : "", r.time].filter(Boolean).join(" · ");
          b.append(t, m);
          b.addEventListener("click", () => finish(r.id));
          li.append(b);
          return li;
        }));
        empty.hidden = shown.length > 0;
        empty.textContent = search.value.trim() ? `沒有符合「${search.value.trim()}」的對話。` : "沒有其他對話。";
      };
      search.addEventListener("input", render);
      cancel.addEventListener("click", () => finish(null));
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });   // Esc
      dlg.addEventListener("close", () => finish(null));
      dlg.append(h, p, search, list, empty, cancel);
      document.body.append(dlg);
      render();
      dlg.showModal();
      search.focus();
    });
  }

  root.ConvPicker = { open };
})(typeof globalThis !== "undefined" ? globalThis : this);
