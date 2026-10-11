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
      { vendor: "Brew Bros Cafe", date: "2026-09-03", time: "16:45", total: 420, tax: null, currency: "INR", invoice_number: "A-2231",
        line_items: [{ description: "Cappuccino x2", amount: 360 }, { description: "Banana Bread", amount: 60 }] },
      { vendor: "Metro Line One", date: "2026-09-04", total: 60, currency: "INR", invoice_number: null },
    ],
  },
];

const toItem = (l) => ({ vendor: l.vendor, date: l.date, time: l.time, total: l.amount, tax: l.tax, currency: l.currency, invoice_number: l.invoiceNumber, line_items: l.lineItems, fileHash: l.fileHash });
const lineItems = (d) => d.lines.filter((l) => l.verdict === "approved").map(toItem);

// Every bill that is already claimed: paid/approved lines, plus lines sitting in claims that are
// still awaiting approval (otherwise the same bill could be submitted again while the first is pending).
export function priorClaimItems() {
  return history.flatMap((c) => {
    const items = c.decision?.status === "pending_approval"
      ? c.decision.lines.filter((l) => l.recommendation === "approve").map(toItem)
      : c.items;
    return items.map((i) => ({ ...i, claimId: c.claimId, status: c.decision?.status || c.status }));
  });
}

let counter = 1040;

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
