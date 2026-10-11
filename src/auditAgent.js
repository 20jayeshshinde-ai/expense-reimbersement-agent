// Audit Agent – an autonomous function-calling agent (Gemini or Claude) that investigates every bill.
// The model decides which checks to run, interprets the evidence, and records a verdict per bill
// with its reasoning. It only RECOMMENDS: a human finance approver makes the final decision.
// Without an API key, a rule-based agent runs the same tools in a fixed order (offline mode).
import fs from "node:fs";
import { POLICY } from "./policy.js";
import { validateGstin, reconcile } from "./forensics.js";
import { today, fmt } from "./claim.js";
import { addToolResults, aiName, aiUsable, newConversation, nudge, status, toolTurn } from "./llm.js";

const registry = JSON.parse(fs.readFileSync(new URL("./data/gst-registry.json", import.meta.url), "utf8"));
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const DAY = 86_400_000;

// ---------------- tools (shared by the Claude agent and the offline agent) ----------------
// Each returns { status: pass|warn|fail, detail, ...data } so findings render the same everywhere.
function makeTools(lines, priorDup) {
  const byId = Object.fromEntries(lines.map((l) => [l.itemId, l]));
  const need = (id) => {
    const l = byId[id];
    if (!l) throw new Error(`Unknown item_id ${id}`);
    return l;
  };
  return {
    list_bills: () => ({
      bills: lines.map((l) => ({ item_id: l.itemId, vendor: l.vendor, date: l.date, amount_inr: l.amountInr, category: l.category, file: l.receiptFile })),
    }),
    get_bill_details: ({ item_id }) => {
      const l = need(item_id);
      return {
        vendor: l.vendor, date: l.date, currency: l.currency, total: l.amount, tax: l.tax, gstin: l.gstin, invoice_number: l.invoiceNumber,
        category: l.category, city: l.city, payment_method: l.paymentMethod, attendees: l.attendees, purpose: l.purpose,
        amount_lines: l.amountLines, visual_concerns_from_vision_model: l.visualConcerns, extracted_by: l.extractedBy,
      };
    },
    verify_gstin: ({ item_id }) => {
      const l = need(item_id);
      if (!l.gstin) return l.amountInr > 2000
        ? { status: "warn", detail: "No GSTIN printed on a bill above ₹2,000" }
        : { status: "pass", detail: "Small bill – GSTIN not required" };
      const v = validateGstin(l.gstin);
      if (!v.valid) return { status: "fail", detail: `${l.gstin}: ${v.reason}` };
      const reg = registry.find((r) => r.gstin === l.gstin);
      if (!reg) return { status: "warn", detail: `${l.gstin} has a valid checksum but is not in the GST registry` };
      if (norm(reg.legalName).slice(0, 6) !== norm(l.vendor).slice(0, 6)) return { status: "fail", detail: `${l.gstin} is registered to "${reg.legalName}", not "${l.vendor}"` };
      return { status: "pass", detail: `${l.gstin} · registered to ${reg.legalName} · ${reg.status}` };
    },
    check_arithmetic: ({ item_id }) => {
      const l = need(item_id);
      const r = reconcile(l.amountLines, l.amount);
      if (r.status === "mismatch") return { status: "fail", detail: `Line items + tax = ${fmt(r.expected)} but printed total is ${fmt(r.total)} (difference ${fmt(r.diff)})` };
      if (r.status === "ok") return { status: "pass", detail: `Components add up to ${fmt(r.total)}` };
      return { status: "pass", detail: "Single-amount bill, nothing to reconcile" };
    },
    check_metadata_tampering: ({ item_id }) => {
      const l = need(item_id);
      if (l.editingTraces?.length) return { status: "fail", detail: `File was saved by an image/PDF editor: ${l.editingTraces.join("; ")}` };
      if (l.visualConcerns?.length) return { status: "fail", detail: `Visual anomalies: ${l.visualConcerns.join("; ")}` };
      return { status: "pass", detail: "No editing-software traces in file metadata" };
    },
    check_claim_history: ({ item_id }) => {
      const l = need(item_id);
      if (priorDup[item_id]) return { status: "fail", detail: priorDup[item_id] };
      if (l.possibleDuplicate) return { status: "warn", detail: `Possible duplicate (not identical): ${l.possibleDuplicate}` };
      return { status: "pass", detail: "No identical bill in this claim or in reimbursement history" };
    },
    check_policy: ({ item_id }) => {
      const l = need(item_id);
      const issues = [];
      if (l.vendor == null || l.date == null || l.amount == null) issues.push({ s: "fail", t: `Missing ${["vendor", "date", "amount"].filter((f) => l[f] == null).join(", ")}` });
      if (l.date) {
        const age = Math.round((today() - new Date(l.date)) / DAY);
        if (age < -1) issues.push({ s: "fail", t: "Bill is dated in the future" });
        else if (age > POLICY.submissionWindowDays) issues.push({ s: "fail", t: `${age} days old, outside the ${POLICY.submissionWindowDays}-day submission window` });
      }
      for (const a of l.adjustments || []) issues.push({ s: "warn", t: `${a.text}: −${fmt(a.amount)} (deducted automatically)` });
      const worst = issues.some((i) => i.s === "fail") ? "fail" : issues.length ? "warn" : "pass";
      return { status: worst, detail: issues.map((i) => i.t).join("; ") || `Within policy · eligible ${fmt(l.eligibleInr)}`, eligible_inr: l.eligibleInr };
    },
  };
}

const CHECK_LABEL = {
  verify_gstin: "GSTIN genuine", check_arithmetic: "Totals add up", check_metadata_tampering: "No digital tampering",
  check_claim_history: "Not claimed before", check_policy: "Within policy",
};
const CHECKS = Object.keys(CHECK_LABEL);

const itemParam = { type: "object", properties: { item_id: { type: "string", description: "Bill id from list_bills, e.g. it_3" } }, required: ["item_id"], additionalProperties: false };
const TOOL_DEFS = [
  { name: "list_bills", description: "List every bill in the claim with id, vendor, date, amount and category. Call this first.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_bill_details", description: "All fields the intake agent extracted from one bill, including every printed amount row and any visual concerns.", parameters: itemParam },
  { name: "verify_gstin", description: "Validate the supplier GSTIN checksum and look it up in the GST registry to confirm it belongs to the vendor.", parameters: itemParam },
  { name: "check_arithmetic", description: "Check that the printed line items, taxes and charges add up to the printed total. A mismatch suggests an edited amount.", parameters: itemParam },
  { name: "check_metadata_tampering", description: "Inspect the receipt file metadata (EXIF / PDF producer) for traces of photo or PDF editing software.", parameters: itemParam },
  { name: "check_claim_history", description: "Search the reimbursement system for the same bill in an earlier claim.", parameters: itemParam },
  { name: "check_policy", description: "Apply company expense policy: required fields, submission window, caps (hotel/meal/alcohol). Returns eligible amount.", parameters: itemParam },
  {
    name: "record_verdict",
    description: "Record your recommendation for one bill after investigating it. Every bill needs exactly one verdict.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        recommendation: { type: "string", enum: ["approve", "reject"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        reason: { type: "string", description: "One or two sentences for the human approver, citing the evidence" },
      },
      required: ["item_id", "recommendation", "risk", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish_review",
    description: "Call once every bill has a verdict. Summarise the claim for the human approver.",
    strict: true,
    parameters: { type: "object", properties: { summary: { type: "string", description: "2-3 sentence summary: what is safe to pay, what was flagged and why" } }, required: ["summary"], additionalProperties: false },
  },
];

const SYSTEM = `You are the Audit Agent in a corporate expense reimbursement system. An intake agent has already read the employee's receipts.
Your job: investigate every bill for authenticity and policy compliance, then recommend approve or reject for each one. A human finance approver makes the final decision, so explain your evidence clearly.

How to work:
- Start with list_bills. Then, in ONE turn, call every check you judge necessary for ALL bills at once (parallel function calls). Run every check on high-value bills and bills with anything unusual.
- Then, in ONE turn, call record_verdict for every bill, together with finish_review. Keep the number of turns small.
- Reject a bill when there is concrete evidence it is not genuine or not reimbursable: invalid or mismatched GSTIN, totals that do not add up, editing-software traces, already reimbursed, missing date/amount, or outside the submission window.
- Policy caps are not grounds for rejection; the over-cap part is deducted automatically. Approve and mention the deduction.
- A warning on its own (e.g. a GSTIN not in the registry, or a possible-but-not-identical duplicate) is not proof of fraud. Approve it with medium risk and say what the approver should glance at.
- Call record_verdict once per bill, then finish_review. Do not stop until every bill has a verdict.`;

// ---------------- AI agent loop (Gemini or Claude function calling) ----------------
async function runAIAgent(lines, tools, emit) {
  const verdicts = {};
  let summary = null;
  const convo = newConversation(`Audit this claim. Employee: ${lines[0]?.employeeName || "employee"}. ${lines.length} bills. Today is ${today().toISOString().slice(0, 10)}.`);

  for (let turn = 0; turn < 30; turn++) {
    const { text, calls } = await toolTurn(SYSTEM, convo, TOOL_DEFS);
    if (text) emit({ type: "thought", text });
    if (!calls.length) {
      if (Object.keys(verdicts).length >= lines.length) break;
      nudge(convo, `Bills still without a verdict: ${lines.filter((l) => !verdicts[l.itemId]).map((l) => l.itemId).join(", ")}. Investigate them and call record_verdict, then finish_review.`);
      continue;
    }
    const results = [];
    for (const call of calls) {
      const args = call.args || {};
      try {
        let output;
        if (call.name === "record_verdict") {
          if (!["approve", "reject"].includes(args.recommendation)) throw new Error("recommendation must be approve or reject");
          verdicts[args.item_id] = args;
          emit({ type: "verdict", ...args, vendor: lines.find((l) => l.itemId === args.item_id)?.vendor });
          output = { recorded: true, remaining: lines.filter((l) => !verdicts[l.itemId]).map((l) => l.itemId) };
        } else if (call.name === "finish_review") {
          summary = args.summary;
          output = { ok: true };
        } else if (tools[call.name]) {
          output = tools[call.name](args);
          emit({ type: "tool", tool: call.name, item_id: args.item_id, vendor: lines.find((l) => l.itemId === args.item_id)?.vendor, status: output.status, detail: output.detail ?? `${output.bills?.length ?? ""} bills` });
        } else throw new Error(`Unknown tool ${call.name}`);
        results.push({ call, output });
      } catch (e) {
        results.push({ call, output: e.message, isError: true });
      }
    }
    addToolResults(convo, results);
    if (summary && Object.keys(verdicts).length >= lines.length) break;
  }
  return { verdicts, summary, agent: "Audit Agent (Live AI)" };
}

// ---------------- offline rule-based agent (same tools, fixed plan) ----------------
async function runOfflineAgent(lines, tools, emit) {
  const pause = () => new Promise((r) => setTimeout(r, 120));
  emit({ type: "thought", text: `Offline mode: running the standard audit plan on ${lines.length} bills (add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env for the AI agent).` });
  tools.list_bills();
  emit({ type: "tool", tool: "list_bills", status: "pass", detail: `${lines.length} bills` });
  const verdicts = {};
  for (const l of lines) {
    const found = [];
    for (const name of CHECKS) {
      const r = tools[name]({ item_id: l.itemId });
      found.push({ name, ...r });
      emit({ type: "tool", tool: name, item_id: l.itemId, vendor: l.vendor, status: r.status, detail: r.detail });
      await pause();
    }
    const fails = found.filter((f) => f.status === "fail");
    const warns = found.filter((f) => f.status === "warn" && f.name !== "check_policy");
    const v = {
      item_id: l.itemId,
      recommendation: fails.length ? "reject" : "approve",
      risk: fails.length ? "high" : warns.length ? "medium" : "low",
      reason: fails.length ? fails.map((f) => `${CHECK_LABEL[f.name]}: ${f.detail}`).join(" ") : warns.length ? `Approve, but review: ${warns.map((w) => w.detail).join("; ")}` : "All checks passed.",
    };
    verdicts[l.itemId] = v;
    emit({ type: "verdict", ...v, vendor: l.vendor });
  }
  const rej = Object.values(verdicts).filter((v) => v.recommendation === "reject").length;
  return { verdicts, summary: `${lines.length - rej} bills verified, ${rej} flagged for rejection.`, agent: "Audit Agent (Offline AI)" };
}

// ---------------- entry point ----------------
export async function runAudit(submission, priorDup, emit = () => {}) {
  const lines = submission.lines.map((l) => ({ ...l, employeeName: submission.employee?.name }));
  const tools = makeTools(lines, priorDup);

  let run;
  if (status.claude !== "no_key" && aiUsable()) {
    try {
      emit({ type: "agent", text: "Audit Agent (Live AI) started" });
      run = await runAIAgent(lines, tools, emit);
    } catch (e) {
      console.warn(`AI audit agent failed: ${e.message}`);
      emit({ type: "thought", text: `Live AI unavailable (${e.message.slice(0, 120)}); switching to the offline audit agent.` });
    }
  }
  if (!run) {
    emit({ type: "agent", text: "Audit Agent (Offline AI) started" });
    run = await runOfflineAgent(lines, tools, emit);
  }

  // Evidence for the approver: every check, whether or not the agent chose to run it.
  const out = lines.map((l) => {
    const checks = CHECKS.map((name) => ({ name: CHECK_LABEL[name], ...tools[name]({ item_id: l.itemId }) }));
    const fails = checks.filter((c) => c.status === "fail").length;
    const v = run.verdicts[l.itemId] || { recommendation: fails ? "reject" : "approve", risk: fails ? "high" : "low", reason: "No verdict from agent; derived from checks." };
    const recommendation = v.recommendation;
    return {
      ...l, checks, recommendation, risk: v.risk, agentReason: v.reason,
      authenticityScore: Math.max(0, 100 - fails * 35 - checks.filter((c) => c.status === "warn" && c.name !== "Within policy").length * 10),
      recommendedInr: recommendation === "approve" ? l.eligibleInr || 0 : 0, verdict: null, approvedInr: 0,
    };
  });

  const ok = out.filter((l) => l.recommendation === "approve");
  const bad = out.filter((l) => l.recommendation === "reject");
  return {
    status: "pending_approval",
    agent: run.agent,
    agentSummary: run.summary,
    agentRecommendation: !ok.length ? "reject" : bad.length ? "partially_approve" : "approve",
    recommendedAmount: Math.round(ok.reduce((s, l) => s + l.recommendedInr, 0)),
    claimedAmount: Math.round(out.reduce((s, l) => s + (l.amountInr || 0), 0)),
    policyDeduction: Math.round(ok.reduce((s, l) => s + (l.amountInr - l.eligibleInr), 0)),
    flaggedAmount: Math.round(bad.reduce((s, l) => s + (l.amountInr || 0), 0)),
    flaggedCount: bad.length,
    approvalLevel: ok.reduce((s, l) => s + l.recommendedInr, 0) > POLICY.managerApprovalAbove ? "Finance + manager" : "Finance approver",
    lines: out,
    reviewedAt: new Date().toISOString(),
    approvedAmount: 0, approver: null, decidedAt: null, payout: null,
  };
}
