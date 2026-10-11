// End-to-end HTTP tests against the real Express app with the offline engine (real OCR on the samples).
import "./helpers.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { default: app } = await import("../src/app.js");
const { shutdownOcr } = await import("../src/localAI.js");
const samples = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "samples");

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await shutdownOcr();
});

const call = (p, sid, opts = {}) => fetch(base + p, { ...opts, headers: { "x-session": sid, ...(opts.json ? { "content-type": "application/json" } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body }).then((r) => r.json());
const upload = (sid, files) => {
  const fd = new FormData();
  for (const f of files) fd.append("files", new Blob([fs.readFileSync(path.join(samples, f))], { type: f.endsWith(".pdf") ? "application/pdf" : "image/jpeg" }), f);
  return call("/api/upload", sid, { method: "POST", body: fd });
};
async function audit(sid) {
  const text = await fetch(`${base}/api/submit/stream?sid=${sid}`).then((r) => r.text());
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return { events, done: events.find((e) => e.type === "done" || e.type === "error") };
}

describe("HTTP API (offline engine, synthetic samples)", { timeout: 180000 }, () => {
  test("portals and config are served", async () => {
    for (const p of ["/", "/employee", "/finance"]) assert.equal((await fetch(base + p)).status, 200);
    const cfg = await call("/api/config", "x");
    assert.equal(cfg.status.state, "no_key");
    assert.ok(cfg.policy.length > 3);
  });

  test("employee flow: upload → claim → audit stream → finance queue → human approval → employee sees result", async () => {
    const sid = "employee-1";
    const up = await upload(sid, ["01_taxi_airport.jpg", "05_taxi_airport_again.jpg", "08_fuel_edited.jpg"]);
    assert.equal(up.report.length, 3);
    assert.equal(up.claim.totals.items, 2, "re-photographed taxi held back");
    assert.equal(up.claim.totals.removed, 1);

    const { events, done } = await audit(sid);
    assert.ok(events.some((e) => e.type === "tool"));
    assert.equal(done.type, "done");
    assert.equal(done.decision.status, "pending_approval");
    assert.equal(done.duplicates.length, 1);
    assert.equal(done.duplicates[0].file, "05_taxi_airport_again.jpg");
    const fuel = done.decision.lines.find((l) => /fuel/i.test(l.vendor));
    assert.equal(fuel.recommendation, "reject");

    const queue = await call("/api/finance/claims", "finance");
    const mine = queue.find((c) => c.claimId === done.decision.claimId);
    assert.equal(mine.status, "pending_approval");
    assert.ok(!mine.decision.lines.some((l) => l.receiptFile === "05_taxi_airport_again.jpg"), "finance never sees duplicates");

    assert.equal((await call(`/api/finance/claims/${mine.claimId}/decide`, "finance", { method: "POST", json: { action: "custom" } })).error, "Approver name is required.");
    const decided = await call(`/api/finance/claims/${mine.claimId}/decide`, "finance", { method: "POST", json: { approver: "Priya Nair", action: "custom" } });
    assert.equal(decided.decision.status, "partially_approved");
    assert.equal(decided.decision.approvedAmount, 780);

    const again = await call(`/api/finance/claims/${mine.claimId}/decide`, "finance", { method: "POST", json: { approver: "Priya Nair", action: "custom" } });
    assert.equal(again.error, "Claim already decided.");

    const st = await call("/api/claim/status", sid);
    assert.equal(st.decision.approver, "Priya Nair");
  });

  test("re-uploading an already-claimed bill submits nothing to finance", async () => {
    const before = (await call("/api/finance/claims", "f")).length;
    await upload("employee-2", ["01_taxi_airport.jpg"]);
    const { done } = await audit("employee-2");
    assert.equal(done.onlyDuplicates, true);
    assert.equal(done.decision, null);
    assert.equal(done.duplicates[0].kind, "already_claimed");
    assert.equal((await call("/api/finance/claims", "f")).length, before);
  });

  test("chat answers about the claim", async () => {
    const r = await call("/api/chat", "employee-1", { method: "POST", json: { message: "what's my claim status?" } });
    assert.match(r.reply, /partially approved/);
    assert.equal((await call("/api/chat", "employee-1", { method: "POST", json: { message: "" } })).error, "Empty message.");
  });

  test("unsupported file types are ignored", async () => {
    const fd = new FormData();
    fd.append("files", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    const r = await call("/api/upload", "employee-3", { method: "POST", body: fd });
    assert.equal(r.report.length, 0);
  });
});
