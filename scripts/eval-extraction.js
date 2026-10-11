// Measures extraction accuracy against the synthetic ground truth.
//   node scripts/eval-extraction.js           -> uses the engine configured in .env (Live AI if a key is set)
//   node scripts/eval-extraction.js --offline -> forces the offline engine (neural OCR + parser)
import "../src/env.js";
import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--offline")) {
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}
const { extractDocument, engineName } = await import("../src/extractor.js");
const { checkAI } = await import("../src/llm.js");
await checkAI();

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const truth = JSON.parse(fs.readFileSync(path.join(root, "samples", "ground-truth.json"), "utf8"));
const FIELDS = ["vendor", "date", "total", "currency", "category", "invoice_number"];
const norm = (v) => (v == null ? null : String(v).toLowerCase().replace(/[^a-z0-9.]/g, ""));

let hits = 0, total = 0;
for (const t of truth) {
  const ex = await extractDocument({ path: path.join(root, "samples", t.file), originalname: t.file });
  const e = ex.expenses[0] || {};
  const row = FIELDS.map((f) => {
    const ok = f === "total" ? Math.abs((e.total ?? -1) - (t.total ?? -1)) < 1 : norm(e[f]) === norm(t[f]);
    hits += ok ? 1 : 0;
    total++;
    return `${f}:${ok ? "✓" : `✗(${e[f]})`}`;
  });
  console.log(`${t.file.padEnd(32)} ${(ex.ms / 1000).toFixed(1).padStart(5)}s  ${row.join("  ")}`);
}
console.log(`\n${engineName()}: field accuracy ${((hits / total) * 100).toFixed(1)}% (${hits}/${total})`);
process.exit(0);
