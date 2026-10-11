// Claim engine: turns extracted expenses into a complete claim with zero employee input.
// It groups expenses into trips, removes duplicates, applies policy, and infers the business
// purpose / attendees itself. Every automatic decision is recorded as an "AI note" for audit.
import { CATEGORIES, FX_TO_INR, POLICY, TRAVEL_ANCHORS, isMetro } from "./policy.js";
import { priorClaimItems } from "./mockFinance.js";

const DAY = 86_400_000;
export const today = () => new Date(process.env.DEMO_TODAY || Date.now());
export const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function createClaim(employee = { name: "Asha Verma (demo)", id: "E-10293", costCenter: "CC-4410 Product", manager: "R. Iyer (demo)" }) {
  return { employee, items: [], groups: {}, docs: [], seq: 0, decision: null };
}

export function addExtraction(claim, fileName, ex) {
  claim.docs.push({ name: fileName, hash: ex.hash, engine: ex.engine, ms: ex.ms, notes: ex.notes });
  const added = [];
  for (const e of ex.expenses) {
    if (e.document_type === "not_an_expense") continue;
    const item = {
      id: `it_${++claim.seq}`, file: fileName, fileHash: ex.hash, mediaType: ex.mediaType, engine: ex.engine,
      editingTraces: ex.editingTraces || [], ...e,
      currency: (e.currency || "INR").toUpperCase(), excluded: false, aiNotes: [],
    };
    claim.items.push(item);
    added.push(item);
  }
  return added;
}

// ---------------- grouping into trips ----------------
function buildGroups(claim) {
  const live = claim.items.filter((i) => !i.excluded);
  const trips = [];
  for (const a of live.filter((i) => TRAVEL_ANCHORS.has(i.category) && i.date && i.city).sort((x, y) => x.date.localeCompare(y.date))) {
    let trip = trips.find((t) => norm(t.city) === norm(a.city));
    if (!trip) trips.push((trip = { city: a.city, start: a.date, end: a.date }));
    if (a.date < trip.start) trip.start = a.date;
    if (a.date > trip.end) trip.end = a.date;
    if (a.category === "hotel" && a.nights) {
      const checkIn = new Date(new Date(a.date) - a.nights * DAY).toISOString().slice(0, 10);
      if (checkIn < trip.start) trip.start = checkIn;
    }
  }
  const groups = {};
  for (const t of trips) {
    const id = `grp_${norm(t.city)}`;
    groups[id] = { id, kind: "trip", city: t.city, title: `Trip to ${t.city}`, start: t.start, end: t.end, itemIds: [] };
  }
  groups.grp_local = { id: "grp_local", kind: "local", title: "Local & other expenses", itemIds: [] };
  for (const i of claim.items) {
    let gid = "grp_local";
    if (i.date) {
      // Inside the trip dates → part of the trip (e.g. airport cab at home). A day either side → only if same city.
      const t = Object.values(groups).find((g) => g.kind === "trip" && (
        (i.date >= g.start && i.date <= g.end) ||
        (norm(i.city) === norm(g.city) && new Date(i.date) >= new Date(+new Date(g.start) - DAY) && new Date(i.date) <= new Date(+new Date(g.end) + DAY))));
      if (t) gid = t.id;
    }
    i.groupId = gid;
    groups[gid].itemIds.push(i.id);
  }
  if (!groups.grp_local.itemIds.length) delete groups.grp_local;
  claim.groups = groups;
}

// ---------------- duplicates ----------------
function detectDuplicates(claim) {
  const prior = priorClaimItems().filter((p) => p.claimId !== claim.decision?.claimId);
  const seen = [];
  for (const a of claim.items) {
    a.duplicate = null;
    for (const b of seen) {
      if (a.fileHash === b.fileHash) a.duplicate = { of: b.id, kind: "exact", reason: `Same file as ${b.file}` };
      else if (a.invoice_number && b.invoice_number && norm(a.invoice_number) === norm(b.invoice_number) && norm(a.vendor) === norm(b.vendor))
        a.duplicate = { of: b.id, kind: "same_receipt", reason: `Same vendor & invoice no. ${a.invoice_number} as ${b.file} (re-photographed)` };
      else if (a.total && a.total === b.total && a.date && a.date === b.date && norm(a.vendor) === norm(b.vendor))
        a.duplicate = { of: b.id, kind: "same_receipt", reason: `Same vendor, date and amount as ${b.file}` };
      if (a.duplicate) break;
    }
    if (!a.duplicate) {
      const p = prior.find((p) => norm(p.vendor) === norm(a.vendor) && p.total === a.total &&
        (p.date === a.date || (p.invoice_number && norm(p.invoice_number) === norm(a.invoice_number))));
      if (p) a.duplicate = { of: p.claimId, kind: "already_claimed", reason: p.status === "pending_approval" ? `Already submitted in claim ${p.claimId} (awaiting approval)` : `Already claimed in ${p.claimId} (${String(p.status).replace(/_/g, " ")})` };
    }
    seen.push(a);
  }
}

// ---------------- policy ----------------
function applyPolicy(i) {
  const adjustments = [];
  const rate = FX_TO_INR[i.currency];
  i.amountInr = i.total != null && rate ? Math.round(i.total * rate * 100) / 100 : null;
  let r = i.amountInr;
  if (r != null) {
    if (i.category === "hotel") {
      const nights = i.nights || 1;
      const cap = isMetro(i.city) ? POLICY.hotelNightlyCap.metro : POLICY.hotelNightlyCap.other;
      if (r / nights > cap) {
        adjustments.push({ amount: r - cap * nights, text: `Hotel cap ${fmt(cap)}/night (${isMetro(i.city) ? "metro" : "non-metro"}); billed ${fmt(r / nights)}/night` });
        r = cap * nights;
      }
    }
    if (i.alcohol_amount && !POLICY.alcoholReimbursable) {
      const alc = i.alcohol_amount * (rate || 1);
      adjustments.push({ amount: alc, text: `Alcohol not reimbursable (${fmt(alc)})` });
      r -= alc;
    }
    if (i.category === "meals" && r > POLICY.mealsPerReceiptCap) {
      adjustments.push({ amount: r - POLICY.mealsPerReceiptCap, text: `Meal cap ${fmt(POLICY.mealsPerReceiptCap)} per receipt` });
      r = POLICY.mealsPerReceiptCap;
    }
    if (i.category === "office_supplies" && r > POLICY.officeSuppliesCap) {
      adjustments.push({ amount: r - POLICY.officeSuppliesCap, text: `Office supplies cap ${fmt(POLICY.officeSuppliesCap)} per receipt` });
      r = POLICY.officeSuppliesCap;
    }
    if (i.category === "client_entertainment" && i.attendees) {
      const cap = POLICY.entertainmentPerHeadCap * i.attendees;
      if (r > cap) {
        adjustments.push({ amount: r - cap, text: `Entertainment cap ${fmt(POLICY.entertainmentPerHeadCap)}/head × ${i.attendees}` });
        r = cap;
      }
    }
  }
  i.adjustments = adjustments;
  i.reimbursable = r == null ? null : Math.max(0, Math.round(r * 100) / 100);
}

// ---------------- automatic resolution (no questions to the employee) ----------------
function inferPurpose(group, items) {
  const cats = new Set(items.map((i) => i.category));
  if (group.kind === "trip") {
    if (cats.has("client_entertainment")) return `Client visit – ${group.city}`;
    if (cats.has("training")) return `Conference / training – ${group.city}`;
    return `Business travel – ${group.city}`;
  }
  const labels = [...cats].map((c) => CATEGORIES[c]?.label.toLowerCase()).filter(Boolean);
  return labels.length ? `Local business expenses (${labels.join(", ")})` : "Local business expenses";
}

function autoResolve(claim) {
  for (const i of claim.items) {
    i.aiNotes = [];
    i.excluded = !!(i.duplicate && i.duplicate.kind !== "already_claimed");
    if (i.excluded) i.aiNotes.push(`Removed automatically – ${i.duplicate.reason}`);
  }
  buildGroups(claim);
  for (const g of Object.values(claim.groups)) {
    const items = g.itemIds.map((id) => claim.items.find((i) => i.id === id)).filter((i) => !i.excluded);
    g.purpose = inferPurpose(g, items);
    for (const i of items) i.purpose = g.purpose;
  }
  for (const i of claim.items.filter((i) => !i.excluded)) {
    if (i.groupId !== "grp_local") i.aiNotes.push(`Grouped into ${claim.groups[i.groupId].title}`);
    if (i.category === "client_entertainment" && i.attendees) i.aiNotes.push(`Attendees: ${i.attendees} (covers printed on bill)`);
  }
}

export function evaluate(claim) {
  detectDuplicates(claim);
  autoResolve(claim);
  for (const i of claim.items) applyPolicy(i);
  const live = claim.items.filter((i) => !i.excluded);
  const claimed = live.reduce((s, i) => s + (i.amountInr || 0), 0);
  const eligible = live.reduce((s, i) => s + (i.reimbursable || 0), 0);
  return {
    employee: claim.employee,
    items: claim.items,
    groups: Object.values(claim.groups),
    totals: { receipts: claim.docs.length, items: live.length, removed: claim.items.length - live.length, claimed: Math.round(claimed), eligible: Math.round(eligible) },
    docs: claim.docs,
    decision: claim.decision,
  };
}

export function buildSubmission(claim) {
  const s = evaluate(claim);
  return {
    employee: claim.employee,
    policy: POLICY.name,
    totals: s.totals,
    lines: s.items.filter((i) => !i.excluded).map((i) => ({
      itemId: i.id, date: i.date, vendor: i.vendor, category: i.category, categoryLabel: CATEGORIES[i.category]?.label,
      glCode: CATEGORIES[i.category]?.glCode, description: i.description, city: i.city, currency: i.currency,
      amount: i.total, amountInr: i.amountInr, eligibleInr: i.reimbursable, tax: i.tax, gstin: i.gstin || null,
      invoiceNumber: i.invoice_number, paymentMethod: i.payment_method, purpose: i.purpose, attendees: i.attendees,
      adjustments: i.adjustments, amountLines: i.amount_lines || [], visualConcerns: i.visual_concerns || [],
      editingTraces: i.editingTraces, receiptFile: i.file, receiptSha256: i.fileHash, extractedBy: i.engine,
    })),
    removed: s.items.filter((i) => i.excluded).map((i) => ({ vendor: i.vendor, file: i.file, reason: i.aiNotes[0] })),
  };
}
