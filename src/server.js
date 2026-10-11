import "./env.js"; // loads .env (ANTHROPIC_API_KEY etc.) before anything else
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaude, engineName, extractDocument, status } from "./extractor.js";
import { warmUpOcr } from "./localAI.js";
import { addExtraction, buildSubmission, createClaim, evaluate } from "./claim.js";
import { finalize } from "./financeAgent.js";
import { runAudit } from "./auditAgent.js";
import { chat } from "./chatAgent.js";
import { enqueue, getClaimRecord, listClaims, markDecided } from "./mockFinance.js";
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

// One claim per browser session, in memory (prototype).
const claims = new Map();
const sidOf = (req) => req.get("x-session") || "default";
const getClaim = (req) => {
  if (!claims.has(sidOf(req))) claims.set(sidOf(req), createClaim());
  return claims.get(sidOf(req));
};

const SERVER_VERSION = 4; // bump when the API changes; the page checks it
app.get("/api/config", (_req, res) => res.json({ version: SERVER_VERSION, live: status.claude === "ok", status, engine: engineName(), categories: CATEGORIES, policy: POLICY_SUMMARY }));
app.post("/api/engine/recheck", async (_req, res) => res.json(await checkClaude()));
app.get("/api/claim", (req, res) => res.json(evaluate(getClaim(req))));
app.post("/api/claim/reset", (req, res) => {
  claims.set(sidOf(req), createClaim());
  res.json(evaluate(getClaim(req)));
});

async function ingest(claim, files) {
  const report = [];
  // Files are read in parallel; items are added in upload order so duplicate detection is stable.
  const results = await Promise.allSettled(files.map((f) => extractDocument(f)));
  results.forEach((r, i) => {
    const name = files[i].originalname;
    if (r.status === "fulfilled") report.push({ file: name, added: addExtraction(claim, name, r.value).length, ms: r.value.ms, engine: r.value.engine });
    else report.push({ file: name, error: r.reason?.message || String(r.reason) });
  });
  return report;
}

app.post("/api/upload", upload.array("files"), async (req, res) => {
  const claim = getClaim(req);
  if (claim.decision) claims.set(sidOf(req), createClaim());
  const files = req.files || [];
  try {
    const report = await ingest(getClaim(req), files);
    res.json({ report, claim: evaluate(getClaim(req)) });
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }
});

app.post("/api/demo", async (req, res) => {
  claims.set(sidOf(req), createClaim());
  const dir = path.join(root, "samples");
  const files = fs.readdirSync(dir).filter((f) => /\.(jpg|png|pdf)$/i.test(f)).map((f) => ({ path: path.join(dir, f), originalname: f }));
  const report = await ingest(getClaim(req), files);
  res.json({ report, claim: evaluate(getClaim(req)) });
});

app.post("/api/item/:id/exclude", (req, res) => {
  const claim = getClaim(req);
  claim.items = claim.items.filter((i) => i.id !== req.params.id);
  res.json({ claim: evaluate(claim) });
});

// Employee submits → Audit Agent investigates every bill (streamed live over SSE) → claim waits for a human approver.
app.get("/api/submit/stream", async (req, res) => {
  const claim = claims.get(String(req.query.sid || "")) || null;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}

`);
  try {
    if (!claim) throw new Error("No claim for this session.");
    const state = evaluate(claim);
    if (!state.totals.items) throw new Error("Add at least one receipt first.");
    if (!claim.decision) {
      const priorDup = Object.fromEntries(state.items.filter((i) => i.duplicate?.kind === "already_claimed").map((i) => [i.id, i.duplicate.reason]));
      const decision = await runAudit(buildSubmission(claim), priorDup, send);
      enqueue(claim.employee, decision);
      claim.decision = decision; // shared object: the employee view sees the approver's decision when it lands
    }
    send({ type: "done", decision: claim.decision });
  } catch (e) {
    send({ type: "error", error: e.message });
  }
  res.end();
});

// Chat assistant (chat mode): answers questions about the claim.
app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message || "").slice(0, 2000).trim();
  if (!message) return res.status(400).json({ error: "Empty message." });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];
  res.json(await chat(message, history, evaluate(getClaim(req))));
});

// Employee polls their claim's status.
app.get("/api/claim/status", (req, res) => res.json({ decision: getClaim(req).decision }));

// Human finance approver decides (the ONLY path to approval).
app.post("/api/finance/claims/:id/decide", (req, res) => {
  const rec = getClaimRecord(req.params.id);
  if (!rec?.decision) return res.status(404).json({ error: "Claim not found." });
  if (rec.decision.status !== "pending_approval") return res.status(409).json({ error: "Claim already decided." });
  const approver = String(req.body.approver || "").trim();
  if (!approver) return res.status(400).json({ error: "Approver name is required." });
  const { action, lines = {}, comment = "" } = req.body;
  let lineDecisions = lines;
  if (action === "approve_all") lineDecisions = Object.fromEntries(rec.decision.lines.map((l) => [l.itemId, "approve"]));
  else if (action === "reject_all") lineDecisions = Object.fromEntries(rec.decision.lines.map((l) => [l.itemId, "reject"]));
  finalize(rec.decision, approver, lineDecisions, comment);
  markDecided(rec.claimId);
  res.json({ decision: rec.decision });
});

app.get("/api/finance/claims", (_req, res) => res.json(listClaims()));

function start(port, attemptsLeft = 10) {
  const server = app.listen(port);
  server.on("listening", async () => {
    console.log(`Expense & Reimbursement Agent on http://localhost:${port}`);
    warmUpOcr().catch((e) => console.warn(`Local OCR warm-up failed: ${e.message}`));
    const s = await checkClaude();
    console.log(s.claude === "ok" ? `AI engine: Claude ✔ (${s.detail})` : `AI engine: Local AI (offline) – Claude: ${s.detail}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`Port ${port} is already in use – trying ${port + 1}…`);
      start(port + 1, attemptsLeft - 1);
    } else {
      console.error(`Could not start server: ${err.message}`);
      process.exit(1);
    }
  });
}
start(Number(process.env.PORT || 3000));
