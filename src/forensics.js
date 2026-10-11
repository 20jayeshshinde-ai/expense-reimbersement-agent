// Document-authenticity helpers used by the finance agent.

const GST_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// GSTIN = 2-digit state + 10-char PAN + entity + 'Z' + mod-36 check character.
export function validateGstin(gstin) {
  if (!gstin) return { present: false };
  const g = gstin.toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { present: true, valid: false, reason: "format is invalid" };
  const state = Number(g.slice(0, 2));
  if (state < 1 || state > 38) return { present: true, valid: false, reason: `state code ${g.slice(0, 2)} does not exist` };
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const p = GST_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    total += Math.floor(p / 36) + (p % 36);
  }
  const check = GST_CHARS[(36 - (total % 36)) % 36];
  return check === g[14]
    ? { present: true, valid: true }
    : { present: true, valid: false, reason: `check digit should be ${check}, document shows ${g[14]}` };
}

// Repair common OCR confusions in a GSTIN using its fixed digit/letter positions.
export function repairGstin(raw) {
  if (!raw || raw.length !== 15) return raw;
  const toDigit = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
  const toAlpha = { 0: "O", 1: "I", 2: "Z", 5: "S", 8: "B", 6: "G" };
  const digitPos = new Set([0, 1, 7, 8, 9, 10]);
  const alphaPos = new Set([2, 3, 4, 5, 6, 11]);
  return [...raw.toUpperCase()].map((c, i) =>
    digitPos.has(i) ? toDigit[c] ?? c : alphaPos.has(i) ? toAlpha[c] ?? c : i === 13 && c === "2" ? "Z" : c).join("");
}

// Read the EXIF "Software" tag (0x0131) from a JPEG without dependencies.
function jpegExifSoftware(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off < buf.length - 4) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") {
      const tiff = off + 10;
      const le = buf.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0131) {
          const count = u32(e + 4);
          const start = count <= 4 ? e + 8 : tiff + u32(e + 8);
          return buf.toString("latin1", start, start + count).replace(/\0+$/, "");
        }
      }
      return null;
    }
    if (marker === 0xda) return null; // start of scan: no more metadata
    off += 2 + len;
  }
  return null;
}

const EDITORS = /photoshop|gimp|canva|picsart|snapseed|pixelmator|affinity photo|lightroom|paint\.net|photopea|fotor|inpaint|pdf ?(editor|escape|filler)|sejda|ilovepdf|smallpdf/i;

// Look for traces of image/PDF editing tools in file metadata (EXIF, XMP, PDF Producer/Creator).
export function editingTraces(buf, mediaType) {
  const traces = [];
  if (mediaType === "image/jpeg") {
    const sw = jpegExifSoftware(buf);
    if (sw && EDITORS.test(sw)) traces.push(`EXIF Software tag: "${sw}"`);
  }
  const head = buf.toString("latin1", 0, Math.min(buf.length, 131072));
  const tail = buf.toString("latin1", Math.max(0, buf.length - 65536));
  for (const chunk of [head, tail]) {
    const m = chunk.match(new RegExp(`(?:Producer|Creator|CreatorTool|Software)[^A-Za-z]{0,6}([^)<>\\n]{0,60}(?:${EDITORS.source})[^)<>\\n]{0,30})`, "i"));
    if (m && !traces.some((t) => t.includes(m[1].trim()))) traces.push(`Metadata: "${m[1].trim()}"`);
  }
  return [...new Set(traces)];
}

// Do the printed components add up to the printed total?
export function reconcile(amountLines, total) {
  if (total == null || !amountLines?.length) return { status: "na" };
  const by = (k) => amountLines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
  const sub = amountLines.find((l) => l.kind === "subtotal");
  const base = sub ? sub.amount : by("item");
  if (!base) return { status: "na" };
  const expected = base + by("tax") + by("charge") - by("discount");
  const diff = Math.round((total - expected) * 100) / 100;
  const ok = Math.abs(diff) <= Math.max(1.5, total * 0.01);
  return { status: ok ? "ok" : "mismatch", expected: Math.round(expected * 100) / 100, total, diff };
}
