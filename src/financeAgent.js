// Human approval step. The Audit Agent (auditAgent.js) only recommends; this applies the
// finance approver's decision, which is the only way a claim gets approved and paid.

// Human decision. lineDecisions: { [itemId]: "approve" | "reject" }; missing lines follow the agent.
export function finalize(decision, approver, lineDecisions = {}, comment = "") {
  for (const l of decision.lines) {
    const choice = lineDecisions[l.itemId] || l.recommendation;
    l.verdict = choice === "approve" ? "approved" : "rejected";
    l.approvedInr = l.verdict === "approved" ? l.eligibleInr || 0 : 0;
    l.overridden = choice !== l.recommendation;
  }
  const approved = decision.lines.filter((l) => l.verdict === "approved");
  decision.status = !approved.length ? "rejected" : approved.length < decision.lines.length ? "partially_approved" : "approved";
  decision.approvedAmount = Math.round(approved.reduce((s, l) => s + l.approvedInr, 0));
  decision.rejectedAmount = Math.round(decision.lines.filter((l) => l.verdict === "rejected").reduce((s, l) => s + (l.amountInr || 0), 0));
  decision.approver = approver;
  decision.comment = comment || null;
  decision.overrides = decision.lines.filter((l) => l.overridden).length;
  decision.decidedAt = new Date().toISOString();
  decision.payout = decision.approvedAmount ? "Credited with next payroll cycle (mock)" : null;
  return decision;
}
