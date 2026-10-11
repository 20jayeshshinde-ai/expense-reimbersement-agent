import { receipt, extraction } from "./helpers.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClaim, addExtraction, evaluate, buildSubmission } from "../src/claim.js";
import { runAudit, makeTools } from "../src/auditAgent.js";
import { finalize } from "../src/financeAgent.js";
import { answerOffline, snapshot, chat } from "../src/chatAgent.js";
import { resetFinance, enqueue, markDecided, priorClaimItems } from "../src/mockFinance.js";

beforeEach(() => resetFinance());

const genuine = receipt();
const tampered = receipt({
  vendor: "Highway Fuels", category: "fuel_mileage", date: "2026-09-13", time: "19:22", invoice_number: "HF-77120", total: 5386.5, tax: null,
  attendees: null, gstin: "27AACCH1170D1ZX", line_items: [{ description: "Petrol", amount: 3386.5 }],
  amount_lines: [{ label: "Petrol", amount: 3386.5, kind: "item" }],
});
const undated = receipt({ vendor: "Stationery Mart", category: "office_supplies", date: null, time: null, invoice_number: "00912", total: 1150, tax: null, gstin: null, attendees: null, line_items: [], amount_lines: [] });

function submissionOf(...rs) {
  const c = createClaim();
  rs.forEach((r, i) => {
    const ex = extraction(r, `h${i}`);
    if (r === tampered) ex.editingTraces = ['EXIF Software tag: "Adobe Photoshop 25.0"'];
    addExtraction(c, `r${i}.jpg`, ex);
  });
  evaluate(c);
  return { claim: c, submission: buildSubmission(c) };
}

describe("Audit Agent tools", () => {
  const { submission } = submissionOf(genuine, tampered, undated);
  const tools = makeTools(submission.lines, {});
  const [g, t, u] = submission.lines.map((l) => l.itemId);

  test("list_bills returns every bill", () => assert.equal(tools.list_bills().bills.length, 3));
  test("verify_gstin passes a registered vendor and fails a bad checksum", () => {
    assert.equal(tools.verify_gstin({ item_id: g }).status, "pass");
    assert.equal(tools.verify_gstin({ item_id: t }).status, "fail");
  });
  test("check_arithmetic catches the edited total", () => {
    assert.equal(tools.check_arithmetic({ item_id: t }).status, "fail");
  });
  test("check_metadata_tampering reports editing software", () => {
    assert.equal(tools.check_metadata_tampering({ item_id: t }).status, "fail");
    assert.equal(tools.check_metadata_tampering({ item_id: g }).status, "pass");
  });
  test("check_policy fails a bill with no date", () => {
    assert.equal(tools.check_policy({ item_id: u }).status, "fail");
  });
  test("unknown bill ids raise an error the agent can see", () => {
    assert.throws(() => tools.verify_gstin({ item_id: "nope" }), /Unknown item_id/);
  });
});

describe("Audit Agent run (offline agent)", () => {
  test("recommends approve for genuine bills and reject for tampered / undated ones", async () => {
    const { submission } = submissionOf(genuine, tampered, undated);
    const events = [];
    const d = await runAudit(submission, {}, (e) => events.push(e));
    const rec = Object.fromEntries(d.lines.map((l) => [l.vendor, l.recommendation]));
    assert.deepEqual(rec, { "Spice Route": "approve", "Highway Fuels": "reject", "Stationery Mart": "reject" });
    assert.equal(d.status, "pending_approval");
    assert.equal(d.flaggedCount, 2);
    assert.equal(d.recommendedAmount, 3240);
    assert.ok(events.some((e) => e.type === "tool") && events.filter((e) => e.type === "verdict").length === 3);
  });
  test("never approves money itself", async () => {
    const d = await runAudit(submissionOf(genuine).submission, {});
    assert.equal(d.approvedAmount, 0);
    assert.equal(d.approver, null);
    assert.ok(d.lines.every((l) => l.verdict === null));
  });
  test("claims above ₹25,000 need finance + manager", async () => {
    const d = await runAudit(submissionOf(receipt({ total: 30000, category: "other", attendees: null, amount_lines: [] })).submission, {});
    assert.equal(d.approvalLevel, "Finance + manager");
  });
});

describe("human approval (finance)", () => {
  test("approver can override the agent per bill; only then is money approved", async () => {
    const d = await runAudit(submissionOf(genuine, undated).submission, {});
    const [g, u] = d.lines.map((l) => l.itemId);
    finalize(d, "Priya Nair", { [u]: "approve" }, "date confirmed by phone");
    assert.equal(d.status, "approved");
    assert.equal(d.approver, "Priya Nair");
    assert.equal(d.overrides, 1);
    assert.equal(d.approvedAmount, 3240 + 1150);
    assert.equal(d.lines.find((l) => l.itemId === g).verdict, "approved");
  });
  test("rejecting a flagged bill gives a partial approval", async () => {
    const d = await runAudit(submissionOf(genuine, tampered).submission, {});
    finalize(d, "Priya Nair");
    assert.equal(d.status, "partially_approved");
    assert.equal(d.approvedAmount, 3240);
  });
  test("pending claims block re-submission of the same bill", async () => {
    const d = await runAudit(submissionOf(genuine).submission, {});
    enqueue({ name: "Asha" }, d);
    assert.ok(priorClaimItems().some((p) => p.claimId === d.claimId && p.status === "pending_approval"));
    finalize(d, "Priya");
    markDecided(d.claimId);
    assert.ok(priorClaimItems().some((p) => p.claimId === d.claimId && p.status === "approved"));
  });
});

describe("Chat assistant (offline answers)", () => {
  test("explains why a named bill was flagged", async () => {
    const { claim, submission } = submissionOf(genuine, tampered);
    claim.decision = await runAudit(submission, {});
    const reply = answerOffline("why was the highway fuel bill rejected?", snapshot(evaluate(claim)));
    assert.match(reply, /Highway Fuels/);
    assert.match(reply, /reject/);
  });
  test("reports duplicate tickets", () => {
    const c = createClaim();
    addExtraction(c, "a.jpg", extraction(genuine, "x"));
    addExtraction(c, "b.jpg", extraction({ ...genuine }, "y"));
    const reply = answerOffline("any duplicates?", snapshot(evaluate(c)));
    assert.match(reply, /1 duplicate ticket was held back/);
  });
  test("status question before any claim", async () => {
    const r = await chat("what's my status?", [], evaluate(createClaim()));
    assert.equal(r.engine, "offline");
    assert.match(r.reply, /don't have a claim yet/);
  });
});
