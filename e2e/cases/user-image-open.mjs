// A picture the user pasted: its thumbnail in the chat opens the image full size in a new tab
// (a blob: URL, like show_image's raster images), every time it is clicked.
import * as h from "../helpers.mjs";

// A 2×1 PNG (one red, one blue pixel).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC";

export default [
  {
    name: "a pasted image's thumbnail opens it full size in a new tab",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Pics", { fresh: false });
      // Paste the PNG into the input, as Ctrl+V with an image on the clipboard does.
      await panel.evaluate((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
        const input = document.getElementById("message-input");
        input.focus();
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, PNG);
      await h.until(panel, () => document.querySelectorAll(".attach-thumb").length === 1, "the pasted image is staged");
      const since = gw.prompts.length;
      await h.send(panel, "look at this");
      const p = await gw.waitPrompt((x) => x.sessionId === sid, { since });
      t.check(p.images === 1, "the prompt carries the image", p.images);
      await h.idle(panel);
      await h.until(panel, () => !!document.querySelector(".sent .bubble-image"), "the thumbnail in the user's message");
      t.check(await panel.evaluate(() => getComputedStyle(document.querySelector(".sent .bubble-image")).cursor) === "zoom-in", "the thumbnail shows a zoom-in cursor");

      for (const n of [1, 2]) {
        const before = (await h.allTabs(ctx)).length;
        await panel.evaluate(() => document.querySelector(".sent .bubble-image").click());
        let tab = null;
        await h.until(null, async () => { tab = (await h.allTabs(ctx)).find((x) => x.url.startsWith("blob:chrome-extension://")); return (await h.allTabs(ctx)).length === before + 1 && !!tab; }, `click ${n} opens a new tab`);
        const page = (await ctx.browser.pages()).find((pg) => pg.url() === tab.url);
        const size = page && await page.evaluate(() => { const im = document.querySelector("img"); return im && `${im.naturalWidth}×${im.naturalHeight}`; });
        t.check(size === "2×1", `click ${n}: the new tab shows the image at full size`, size);
        await ctx.control.evaluate((id) => chrome.tabs.remove(id), tab.id);
      }
    },
  },
];
