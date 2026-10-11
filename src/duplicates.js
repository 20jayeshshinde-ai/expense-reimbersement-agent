// Strict duplicate matching. A receipt is only treated as a duplicate (removed, or blocked as
// already claimed) when it is the same file, or EVERY detail matches exactly: vendor name, date,
// time, invoice/bill number, currency, total, tax and every line item (description + cost).
// Anything less – e.g. same vendor and amount on the same day – is only a "possible duplicate"
// for the human approver to look at; it is never removed automatically.

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (n) => (n == null ? null : Math.round(Number(n) * 100));
const items = (r) => (r.line_items || r.lineItems || [])
  .map((li) => `${norm(li.description)}=${money(li.amount)}`)
  .sort();

// Each check returns [label, equal?]. A field must be present on both sides AND equal;
// both-missing counts as equal (e.g. no time printed on either copy).
function fieldChecks(a, b) {
  const same = (x, y) => (x == null || x === "" ? y == null || y === "" : x === y);
  const ia = items(a), ib = items(b);
  return [
    ["vendor", !!a.vendor && norm(a.vendor) === norm(b.vendor)],
    ["date", !!a.date && a.date === b.date],
    ["time", same(a.time || null, b.time || null)],
    ["bill / invoice no.", same(norm(a.invoice_number ?? a.invoiceNumber) || null, norm(b.invoice_number ?? b.invoiceNumber) || null)],
    ["currency", (a.currency || "INR") === (b.currency || "INR")],
    ["total", a.total != null && money(a.total) === money(b.total)],
    ["tax", same(money(a.tax), money(b.tax))],
    ["items & costs", ia.length === ib.length && ia.every((x, i) => x === ib[i])],
  ];
}

// Returns { kind: "exact_file" | "identical" | "possible", reason, matched, differs } or null.
export function compareReceipts(a, b, bLabel) {
  if (a.fileHash && b.fileHash && a.fileHash === b.fileHash) {
    return { kind: "exact_file", reason: `Same file as ${bLabel}`, matched: ["file"], differs: [] };
  }
  const checks = fieldChecks(a, b);
  const matched = checks.filter(([, ok]) => ok).map(([k]) => k);
  const differs = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (!differs.length) {
    return { kind: "identical", reason: `Every detail matches ${bLabel} (vendor, date, time, bill no., items, amounts)`, matched, differs };
  }
  // Same vendor + total + date but not everything: flag only.
  if (matched.includes("vendor") && matched.includes("total") && matched.includes("date")) {
    return { kind: "possible", reason: `Looks similar to ${bLabel}, but ${differs.join(", ")} differ${differs.length === 1 ? "s" : ""} – kept for review`, matched, differs };
  }
  return null;
}
