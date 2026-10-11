// Mock corporate reimbursement system ("FinanceHub"). Stands in for SAP Concur / Oracle etc.
// In-memory only; seeded with a previously-paid claim so cross-claim duplicate detection can be demoed.

const history = [
  {
    claimId: "EXP-2026-0412",
    status: "paid",
    submittedAt: "2026-09-08T10:00:00Z",
    employee: { name: "Asha Verma (demo)" },
    approvedAmount: 480,
    items: [
      { vendor: "Brew Bros Cafe", date: "2026-09-03", total: 420, currency: "INR", invoice_number: "A-2231" },
      { vendor: "Metro Line One", date: "2026-09-04", total: 60, currency: "INR", invoice_number: null },
    ],
  },
];

export function priorClaimItems() {
  return history.flatMap((c) => c.items.map((i) => ({ ...i, claimId: c.claimId, status: c.status })));
}

let counter = 1040;
const lineItems = (d) => d.lines.filter((l) => l.verdict === "approved").map((l) => ({ vendor: l.vendor, date: l.date, total: l.amount, currency: l.currency, invoice_number: l.invoiceNumber }));

// Agent-reviewed claim enters the finance approval queue.
export function enqueue(employee, decision) {
  const claimId = `EXP-2026-${++counter}`;
  decision.claimId = claimId;
  decision.employee = employee;
  history.push({ claimId, status: decision.status, submittedAt: decision.reviewedAt, employee, decision, items: [] });
  return claimId;
}

export function getClaimRecord(claimId) {
  return history.find((c) => c.claimId === claimId) || null;
}

// Called after a human approver decides; approved lines now count as "already claimed".
export function markDecided(claimId) {
  const rec = getClaimRecord(claimId);
  rec.status = rec.decision.status;
  rec.items = lineItems(rec.decision);
  return rec;
}

export function listClaims() {
  return history.map(({ claimId, status, submittedAt, decidedAt, employee, approvedAmount, items, decision }) => ({
    claimId, status, submittedAt: submittedAt || decidedAt, employee: employee?.name,
    amount: decision ? (decision.status === "pending_approval" ? decision.recommendedAmount : decision.approvedAmount) : approvedAmount,
    lines: decision ? decision.lines.length : items.length, decision: decision || null,
  })).reverse();
}
