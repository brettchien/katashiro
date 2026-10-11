// Milkdown crepe for canvas editing (ADR docs/adr/canvas.md §3.5): the editor, plus the parser /
// serializer contexts the frame uses to normalize agent markdown without showing an editor, and the
// editor's own history commands for the edit-mode ↶ / ↷ buttons (the prosemirror-history crepe uses).
import { Crepe } from "@milkdown/crepe";
import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { undo, redo, undoDepth, redoDepth } from "@milkdown/kit/prose/history";
globalThis.KatashiroMilkdown = { Crepe, parserCtx, serializerCtx, undo, redo, undoDepth, redoDepth };
