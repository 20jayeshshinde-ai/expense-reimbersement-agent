// Measures live extraction accuracy against the synthetic ground truth.
//   ANTHROPIC_API_KEY=... node scripts/eval-extraction.js
import fs from "node:fs";
import { extractDocument, LIVE, MODEL } from "../src/extractor.js";

if (!LIVE) {
  console.error("Set ANTHROPIC_API_KEY to run the live extraction eval.");
  process.exit(1);
}
const truth = JSON.parse(fs.readFileSync(new URL("../samples/ground-truth.json", import.meta.url), "utf8"));
const FIELDS = ["vendor", "date", "total", "currency", "category", "invoice_number"];
const norm = (v) => (v == null ? null : String(v).toLowerCase().replace(/[^a-z0-9.]/g, ""));
let hits = 0, total = 0;
for (const t of truth) {
  const path = new URL(`../samples/${t.file}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
  const ex = await extractDocument({ path, originalname: t.file });
  const e = ex.expenses[0] || {};
  const row = FIELDS.map((f) => {
    const ok = f === "total" ? Math.abs((e.total ?? -1) - (t.total ?? -1)) < 1 : f === "vendor" ? norm(e.vendor)?.includes(norm(t.vendor)?.slice(0, 6)) ?? t.vendor == null : norm(e[f]) === norm(t[f]);
    hits += ok ? 1 : 0; total++;
    return ok ? "✓" : `✗(${e[f]})`;
  });
  console.log(`${t.file.padEnd(30)} ${(ex.ms / 1000).toFixed(1)}s  ${FIELDS.map((f, i) => `${f}:${row[i]}`).join("  ")}`);
}
console.log(`\n${MODEL}: field accuracy ${((hits / total) * 100).toFixed(1)}% (${hits}/${total})`);
