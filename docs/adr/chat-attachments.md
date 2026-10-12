# ADR: Chat attachments — drop image and text files on the chat

- **Status:** Accepted 2026-10-10 (Brett; detection + text cap option (a), 23:31–23:32 TPE);
  defaults below approved 2026-10-12 16:09 TPE ("go do 85")
- **Date:** 2026-10-12
- **Author:** Brett Chien (drafted by Orca)
- **Related:** issue #85; pasted images in the composer (`composer.js` `classifyPaste`);
  reply-to (#61); [ask_user](./ask-user.md) §2.3 (a message closes open ask cards).

---

## 1. Context

Screenshots can be pasted into the composer today. Users also want to hand the agent a file they
have on disk: a log, a config, a snippet, a picture. The agent cannot read the user's disk, so the
panel has to read the file and put it into the prompt.

## 2. Decision

### 2.1 Where files can be dropped

- The **whole chat area** of the side panel is the drop target. While files are dragged over it,
  it shows a drop-zone highlight. Drops anywhere else in the panel are ignored (and never open the
  file as a page). Canvas tabs do not accept drops.
- Several files per drop. At most **10 attachments** (images + text files) per message.

### 2.2 What a file is — from its bytes, never its name

No new dependency. Everything runs on the first 8 KB of the file, as pure functions on a
`Uint8Array` in `composer.js`:

1. **Image: magic bytes.** PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`, WebP
   `RIFF····WEBP`. A match goes through the existing paste-image pipeline (re-encode, per-turn
   budget, the agent's `promptCapabilities.image`).
2. **Text: git's NUL check plus two stricter rules.** Any NUL byte → binary (this is all git's
   `buffer_is_binary` checks). The bytes must decode with
   `new TextDecoder("utf-8", { fatal: true })` (a BOM is fine; a multi-byte character cut at the
   8 KB boundary is tolerated with `stream: true`). More than ~1 % other C0 control characters
   (tab, LF, CR, FF and ESC excluded — ESC so ANSI-coloured logs pass) → binary. When a text file
   is read in full, the whole file is checked again the same way.
3. **Anything else** is refused: 「不支援的檔案類型（看起來是二進位檔）」.

The extension and MIME type are used only for the chip label and the code-fence language.

### 2.3 Limits (Settings → 附加檔案)

- **File size limit**, default **10 MB**: a larger file is refused at drop. A text file larger than
  the highest text cap the settings allow (4096 KB) is refused at drop too, before it is read.
- **Text cap**, default **256 KB**: checked **on send**, per text file and for the **total** of all
  text attachments in one message. Over it, the message is not sent and the panel says why; the
  text is never truncated (issue #85 option (a)). The cap exists because the gateway caps
  `session/prompt` at 8 MiB and the model's context is far smaller than 10 MB of text.

### 2.4 How a text file reaches the agent

A text file is staged as an **attachment chip** in the composer (removable, like a staged image)
and expanded into the prompt on send, after the message text:

    📎 notes.md（3 KB）
    ```markdown
    …file content…
    ```

The fence is longer than any backtick run in the content (at least three), and its language comes
from the extension when known. The content is user input, with the user's trust level.

### 2.5 What is kept

Everything stays in memory. Chat history records a marker per file, `[file: notes.md, 3 KB]`,
never the content — like images, which are not stored either.

### 2.6 Interactions

- Sending with attachments is an ordinary user message: it closes open ask cards (ask_user §2.3)
  and carries the reply-to quote when one is set.
- @mention routing reads the typed text only, never file content.

## 3. Consequences

- Large text files can be attached but not sent; the user removes the chip or raises the cap.
- A text file whose first 8 KB is clean but whose later bytes are not UTF-8 is refused when it is
  read in full (the decision stays "text or nothing", no replacement characters).
- Only UTF-8 text is accepted: UTF-16, Big5 and other legacy encodings are refused as binary.
