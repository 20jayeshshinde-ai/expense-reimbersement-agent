// Chat assistant for the employee: answers questions about their claim in plain language.
// Gemini or Claude answers free-form when a key works; otherwise a small intent matcher answers
// the common questions (status, flagged bills, deductions, policy, totals) from the same data.
import { CATEGORIES, POLICY_SUMMARY } from "./policy.js";
import { fmt } from "./claim.js";
import { chatText, status } from "./llm.js";

const STATUS_TEXT = { pending_approval: "waiting for a finance approver", approved: "approved", partially_approved: "partially approved", rejected: "rejected" };

// Compact, model-friendly view of the claim (no file hashes or raw OCR).
function snapshot(state) {
  const d = state.decision;
  const lines = d ? d.lines : [];
  return {
    employee: state.employee?.name,
    receipts_uploaded: state.totals.receipts,
    trips: state.groups.filter((g) => g.kind === "trip").map((g) => ({ title: g.title, from: g.start, to: g.end, purpose: g.purpose })),
    removed_automatically: state.items.filter((i) => i.excluded).map((i) => ({ vendor: i.vendor, file: i.file, reason: i.aiNotes?.[0] })),
    claim: d && {
      id: d.claimId, status: d.status, agent: d.agent, agent_summary: d.agentSummary,
      claimed_inr: d.claimedAmount, recommended_inr: d.recommendedAmount, approved_inr: d.approvedAmount,
      approval_needed_from: d.approvalLevel, policy_deductions_inr: d.policyDeduction, flagged_inr: d.flaggedAmount, approver: d.approver, approver_comment: d.comment,
      payout: d.payout,
    },
    bills: lines.map((l) => ({
      vendor: l.vendor, date: l.date, category: CATEGORIES[l.category]?.label, amount_inr: l.amountInr,
      ai_recommendation: l.recommendation, risk: l.risk, ai_reason: l.agentReason, final_decision: l.verdict,
      payable_inr: l.verdict ? l.approvedInr : l.recommendedInr,
      deductions: (l.adjustments || []).map((a) => `${a.text}: -${fmt(a.amount)}`),
      failed_checks: l.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`),
    })),
  };
}

const SYSTEM = `You are ClaimPilot, the employee-facing expense assistant in a chat window. You can see the employee's current claim (JSON below).
Answer briefly and concretely in 1-4 short sentences or a short bullet list, citing vendors and rupee amounts from the data.
Never invent bills, amounts, decisions or approval routes; use approval_needed_from for who must approve. Only a human finance approver can approve money; you cannot change a decision.
If they want to add receipts, tell them to attach files with the 📎 button. Company policy:
${POLICY_SUMMARY.map((p) => "- " + p).join("\n")}`;

async function askAI(message, history, snap) {
  const messages = [
    ...history.slice(-8).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
    { role: "user", content: `Current claim data:\n${JSON.stringify(snap)}\n\nEmployee: ${message}` },
  ];
  // Drop leading assistant turns and merge consecutive same-role turns so the history is valid.
  while (messages.length && messages[0].role !== "user") messages.shift();
  const merged = [];
  for (const m of messages) {
    if (merged.length && merged.at(-1).role === m.role) merged.at(-1).content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return chatText(SYSTEM, merged);
}

// ---------------- offline intent answers ----------------
function answerOffline(message, snap) {
  const q = message.toLowerCase();
  const c = snap.claim;
  const bills = snap.bills;
  const named = bills.find((b) => b.vendor && q.includes(b.vendor.toLowerCase().split(" ")[0]))
    || bills.find((b) => b.category && q.includes(b.category.toLowerCase().split(" ")[0]));

  if (/^(hi|hello|hey|namaste)\b/.test(q)) return "Hi! Attach your receipts with 📎 (photos or PDFs) and I'll take care of the rest. You can also ask me about your claim status, flagged bills or the policy.";
  if (/help|what can you/.test(q)) return "I can:\n• read receipts you attach (📎) and build your claim\n• tell you your claim status\n• explain why a bill was flagged or reduced\n• explain the expense policy\nTry “why was the fuel bill rejected?”";
  if (/policy|rule|limit|cap|allowed/.test(q) && !named) return "Key policy rules:\n" + POLICY_SUMMARY.map((p) => "• " + p).join("\n");
  if (!c) return snap.receipts_uploaded ? "Your receipts are still being processed. One moment…" : "You don't have a claim yet. Attach your receipts with 📎 or tap “Try 8 sample receipts”.";

  if (named) {
    const why = named.failed_checks.length ? `Issues: ${named.failed_checks.join("; ")}.`
      : named.deductions.length ? `Deductions: ${named.deductions.join("; ")}.` : "All authenticity and policy checks passed.";
    const decision = named.final_decision ? `Final decision: ${named.final_decision}.` : `Audit Agent recommends: ${named.ai_recommendation} (${named.risk} risk).`;
    return `${named.vendor} · ${named.date || "no date"} · ${fmt(named.amount_inr || 0)}\n${decision} ${why}\nPayable: ${fmt(named.payable_inr || 0)}.`;
  }
  if (/flag|reject|why|problem|issue|wrong|fraud|fake/.test(q)) {
    const bad = bills.filter((b) => (b.final_decision || (b.ai_recommendation === "reject" ? "rejected" : "")) === "rejected");
    if (!bad.length) return "None of your bills were flagged 🎉";
    return `${bad.length} bill${bad.length > 1 ? "s were" : " was"} flagged:\n` + bad.map((b) => `• ${b.vendor} (${fmt(b.amount_inr || 0)}): ${b.failed_checks[0] || b.ai_reason}`).join("\n");
  }
  if (/deduct|cut|less|reduc|hotel|alcohol|beer/.test(q)) {
    const ded = bills.filter((b) => b.deductions.length);
    if (!ded.length) return "No policy deductions on your claim.";
    return `Policy deductions total ${fmt(c.policy_deductions_inr)}:\n` + ded.map((b) => `• ${b.vendor}: ${b.deductions.join("; ")}`).join("\n");
  }
  if (/duplicate|twice|removed/.test(q)) {
    return snap.removed_automatically.length
      ? "Removed automatically:\n" + snap.removed_automatically.map((r) => `• ${r.vendor} (${r.file}): ${r.reason}`).join("\n")
      : "No duplicates were found.";
  }
  if (/status|approv|when|pay|money|reimburs|total|how much|amount/.test(q)) {
    const amt = c.status === "pending_approval" ? `${fmt(c.recommended_inr)} recommended by the Audit Agent` : `${fmt(c.approved_inr)} approved by ${c.approver}`;
    return `Claim ${c.id} is ${STATUS_TEXT[c.status]}. ${amt} out of ${fmt(c.claimed_inr)} claimed.${c.payout ? " " + c.payout + "." : ""}`;
  }
  if (/trip|purpose/.test(q) && snap.trips.length) return snap.trips.map((t) => `• ${t.title} (${t.from} → ${t.to}): ${t.purpose}`).join("\n");
  return "I can tell you your claim status, why a bill was flagged, deductions, duplicates or the policy. (Add a Gemini or Anthropic API key in .env for free-form answers.)";
}

export async function chat(message, history, state) {
  const snap = snapshot(state);
  if (status.claude === "ok") {
    try {
      const text = await askAI(message, history, snap);
      if (text) return { reply: text, engine: status.provider };
    } catch (e) {
      console.warn(`Chat via ${status.provider} failed (${e.message}); answering offline.`);
    }
  }
  return { reply: answerOffline(message, snap), engine: "offline" };
}
