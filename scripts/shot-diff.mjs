#!/usr/bin/env node
// shot-diff.mjs — where two screenshots differ: `node scripts/shot-diff.mjs a.png b.png` prints the
// number of differing pixels, their bounding box and the first few (x, y, a rgb, b rgb). Used by CI's
// theme-shots compare to say WHERE an unstable or changed shot differs. 8-bit RGB / RGBA PNGs, as
// Chrome writes them; no dependency.
import fs from "node:fs";
import zlib from "node:zlib";

function decode(file) {
  const buf = fs.readFileSync(file);
  let i = 8, w = 0, h = 0, ch = 4;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString("ascii", i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; }
    if (type === "IDAT") idat.push(d);
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= ch && y ? out[(y - 1) * stride + x - ch] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, px: (x, y) => [...out.subarray((y * w + x) * ch, (y * w + x) * ch + 3)] };
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error("usage: shot-diff.mjs a.png b.png"); process.exit(2); }
const a = decode(fa), b = decode(fb);
if (a.w !== b.w || a.h !== b.h) { console.log(`size ${a.w}x${a.h} vs ${b.w}x${b.h}`); process.exit(0); }
const pts = [];
for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
  const p = a.px(x, y), q = b.px(x, y);
  if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) pts.push([x, y, p, q]);
}
if (!pts.length) { console.log("identical pixels"); process.exit(0); }
const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
const maxd = Math.max(...pts.map(([, , p, q]) => Math.max(...p.map((v, k) => Math.abs(v - q[k])))));
console.log(`${pts.length} px differ, bbox x ${Math.min(...xs)}–${Math.max(...xs)} y ${Math.min(...ys)}–${Math.max(...ys)}, max channel delta ${maxd}; first: ${JSON.stringify(pts.slice(0, 4))}`);
