// Mock corporate reimbursement system ("FinanceHub"). Stands in for SAP Concur / Oracle etc.
// In-memory only; seeded with a previously-paid claim so cross-claim duplicate detection can be demoed.
import crypto from "node:crypto";

const history = [
  {
    claimId: "EXP-2026-0412",
    status: "paid",
    submittedAt: "2026-09-08T10:00:00Z",
    items: [
      { vendor: "Brew Bros Cafe", date: "2026-09-03", total: 420, currency: "INR", invoice_number: "A-2231" },
      { vendor: "Metro Line One", date: "2026-09-04", total: 60, currency: "INR", invoice_number: null },
    ],
  },
];

export function priorClaimItems() {
  return history.flatMap((c) => c.items.map((i) => ({ ...i, claimId: c.claimId, status: c.status })));
}

export function submitClaim(payload) {
  const claimId = `EXP-2026-${String(1000 + history.length * 7 + Math.floor(Math.random() * 7)).padStart(4, "0")}`;
  const record = {
    claimId,
    status: payload.requiresManagerApproval ? "pending_manager_approval" : "pending_finance_review",
    submittedAt: new Date().toISOString(),
    receiptId: crypto.randomUUID(),
    ...payload,
    items: payload.lines.map((l) => ({ vendor: l.vendor, date: l.date, total: l.amount, currency: l.currency, invoice_number: l.invoiceNumber })),
  };
  history.push(record);
  return { claimId, status: record.status, submittedAt: record.submittedAt, expectedPayout: "next payroll cycle (mock)" };
}

export function listClaims() {
  return history.map(({ claimId, status, submittedAt, totals }) => ({ claimId, status, submittedAt, totals }));
}
