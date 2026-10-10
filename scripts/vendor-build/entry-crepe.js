// Milkdown crepe for canvas editing (ADR docs/adr/canvas.md §3.5): the editor, plus the parser /
// serializer contexts the frame uses to normalize agent markdown without showing an editor.
import { Crepe } from "@milkdown/crepe";
import { parserCtx, serializerCtx } from "@milkdown/kit/core";
globalThis.KatashiroMilkdown = { Crepe, parserCtx, serializerCtx };
