import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocument, interpretChat, LIVE, MODEL } from "./extractor.js";
import { addExtraction, answerTopQuestion, applyUpdate, buildSubmission, createClaim, evaluate } from "./claim.js";
import { submitClaim, listClaims } from "./mockFinance.js";
import { CATEGORIES, POLICY_SUMMARY } from "./policy.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uploadDir = path.join(root, ".uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));
app.use("/samples", express.static(path.join(root, "samples")));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype)),
});

// Single-user prototype: one claim per session id, kept in memory.
const claims = new Map();
const getClaim = (req) => {
  const sid = req.get("x-session") || "default";
  if (!claims.has(sid)) claims.set(sid, createClaim());
  return claims.get(sid);
};

app.get("/api/config", (_req, res) => res.json({ live: LIVE, model: LIVE ? MODEL : "offline-demo", categories: CATEGORIES, policy: POLICY_SUMMARY }));

app.get("/api/claim", (req, res) => res.json(evaluate(getClaim(req))));

app.post("/api/claim/reset", (req, res) => {
  claims.set(req.get("x-session") || "default", createClaim());
  res.json(evaluate(getClaim(req)));
});

app.post("/api/upload", upload.array("files"), async (req, res) => {
  const claim = getClaim(req);
  const results = await Promise.allSettled((req.files || []).map(async (f) => {
    try {
      const ex = await extractDocument(f);
      return { file: f.originalname, added: addExtraction(claim, f.originalname, ex).length, ms: ex.ms, notes: ex.notes };
    } finally {
      fs.rm(f.path, { force: true }, () => {});
    }
  }));
  const report = results.map((r, i) => r.status === "fulfilled" ? r.value : { file: req.files[i].originalname, error: r.reason?.message || String(r.reason) });
  res.json({ report, claim: evaluate(claim) });
});

// Load the bundled synthetic receipts (for demos without your own files).
app.post("/api/demo", async (req, res) => {
  const claim = getClaim(req);
  const dir = path.join(root, "samples");
  const files = fs.readdirSync(dir).filter((f) => /\.(jpg|png|pdf)$/i.test(f));
  const report = [];
  for (const name of files) {
    try {
      const ex = await extractDocument({ path: path.join(dir, name), originalname: name });
      report.push({ file: name, added: addExtraction(claim, name, ex).length, ms: ex.ms });
    } catch (e) {
      report.push({ file: name, error: e.message });
    }
  }
  res.json({ report, claim: evaluate(claim) });
});

app.post("/api/answer", (req, res) => {
  const claim = getClaim(req);
  const { target, field, value } = req.body;
  const ok = applyUpdate(claim, target, field, value);
  res.status(ok ? 200 : 400).json({ ok, claim: evaluate(claim) });
});

app.post("/api/chat", async (req, res) => {
  const claim = getClaim(req);
  const message = String(req.body.message || "").slice(0, 2000);
  const state = evaluate(claim);
  let reply;
  try {
    const snapshot = {
      groups: state.groups.map(({ id, title, start, end }) => ({ id, title, start, end })),
      items: state.items.filter((i) => !i.excluded).map(({ id, vendor, date, total, currency, category, status, groupId, issues }) => ({ id, vendor, date, total, currency, category, status, groupId, issues: issues.map((x) => x.text) })),
      open_questions: state.questions.map(({ id, target, field, text }) => ({ id, target, field, text })),
    };
    const ai = await interpretChat(message, snapshot);
    if (ai) {
      const applied = ai.updates.filter((u) => {
        if (u.field === "confirm") return true;
        const field = u.field === "exclude" ? "exclude" : u.field;
        return applyUpdate(claim, u.target_id, field, u.value);
      });
      reply = ai.reply + (applied.length < ai.updates.length ? " (Some changes couldn't be applied.)" : "");
    } else {
      reply = answerTopQuestion(claim, message).reply;
    }
  } catch (e) {
    reply = `Sorry – I hit an error: ${e.message}`;
  }
  res.json({ reply, claim: evaluate(claim) });
});

app.post("/api/submit", (req, res) => {
  const claim = getClaim(req);
  const state = evaluate(claim);
  if (!state.readiness.ready) return res.status(409).json({ error: "Claim is not ready yet.", claim: state });
  const payload = buildSubmission(claim);
  claim.submitted = { ...submitClaim(payload), payload };
  res.json({ submitted: claim.submitted, claim: evaluate(claim) });
});

app.get("/api/finance/claims", (_req, res) => res.json(listClaims()));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Expense & Reimbursement Agent on http://localhost:${port}  (${LIVE ? `live AI: ${MODEL}` : "offline demo mode – set ANTHROPIC_API_KEY for live extraction"})`);
});
