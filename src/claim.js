// Claim engine: turns extracted expenses into a complete claim with zero employee input.
// It groups expenses into trips, removes duplicates, applies policy, and infers the business
// purpose / attendees itself. Every automatic decision is recorded as an "AI note" for audit.
import { CATEGORIES, FX_TO_INR, POLICY, TRAVEL_ANCHORS, isMetro } from "./policy.js";
import { priorClaimItems } from "./mockFinance.js";
import { compareReceipts } from "./duplicates.js";

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
// Only exact copies are removed or blocked; near matches are kept and flagged for the approver.
function detectDuplicates(claim) {
  const prior = priorClaimItems().filter((p) => p.claimId !== claim.decision?.claimId);
  const seen = [];
  for (const a of claim.items) {
    a.duplicate = null;
    a.possibleDuplicate = null;
    for (const b of seen) {
      const m = compareReceipts(a, b, b.file);
      if (!m) continue;
      if (m.kind === "possible") { a.possibleDuplicate ??= { of: b.id, reason: m.reason }; continue; }
      a.duplicate = { of: b.id, kind: m.kind, reason: m.reason };
      break;
    }
    if (!a.duplicate) {
      for (const p of prior) {
        const m = compareReceipts(a, p, `claim ${p.claimId}`);
        if (!m) continue;
        if (m.kind === "possible") { a.possibleDuplicate ??= { of: p.claimId, reason: m.reason }; continue; }
        a.duplicate = {
          of: p.claimId, kind: "already_claimed",
          reason: p.status === "pending_approval" ? `Already submitted in claim ${p.claimId} (awaiting approval) – every detail matches`
            : `Already claimed in ${p.claimId} (${String(p.status).replace(/_/g, " ")}) – every detail matches`,
        };
        break;
      }
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
    // Exact duplicates (same upload or an earlier claim) never go to finance; the employee sees them.
    i.excluded = !!i.duplicate;
    if (i.excluded) i.aiNotes.push(`Not submitted – duplicate: ${i.duplicate.reason}`);
  }
  buildGroups(claim);
  for (const g of Object.values(claim.groups)) {
    const items = g.itemIds.map((id) => claim.items.find((i) => i.id === id)).filter((i) => !i.excluded);
    g.purpose = inferPurpose(g, items);
    for (const i of items) i.purpose = g.purpose;
  }
  for (const i of claim.items.filter((i) => !i.excluded)) {
    if (i.groupId !== "grp_local") i.aiNotes.push(`Grouped into ${claim.groups[i.groupId].title}`);
    if (i.possibleDuplicate) i.aiNotes.push(`Possible duplicate – kept: ${i.possibleDuplicate.reason}`);
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
      invoiceNumber: i.invoice_number, time: i.time || null, lineItems: i.line_items || [], fileHash: i.fileHash, possibleDuplicate: i.possibleDuplicate?.reason || null, paymentMethod: i.payment_method, purpose: i.purpose, attendees: i.attendees,
      adjustments: i.adjustments, amountLines: i.amount_lines || [], visualConcerns: i.visual_concerns || [],
      editingTraces: i.editingTraces, receiptFile: i.file, receiptSha256: i.fileHash, extractedBy: i.engine,
    })),
  };
}

// Employee-only view of duplicates: what was held back and the original it copies.
export function duplicateReport(claim) {
  const prior = priorClaimItems();
  return claim.items.filter((i) => i.excluded && i.duplicate).map((i) => {
    const d = i.duplicate;
    const orig = d.kind === "already_claimed" ? prior.find((p) => p.claimId === d.of) && { claimId: d.of, ...pickPrior(prior, d.of, i) } : claim.items.find((x) => x.id === d.of);
    return {
      file: i.file, vendor: i.vendor, date: i.date, time: i.time || null, invoice: i.invoice_number, total: i.total, currency: i.currency,
      itemCount: (i.line_items || []).length, amountInr: i.amountInr,
      kind: d.kind, reason: d.reason,
      original: orig ? {
        where: d.kind === "already_claimed" ? `Claim ${d.of} (${String(orig.status || "").replace(/_/g, " ")})` : `This upload · ${orig.file}`,
        file: orig.file || null, vendor: orig.vendor, date: orig.date, time: orig.time || null, invoice: orig.invoice_number, total: orig.total,
        itemCount: (orig.line_items || []).length,
      } : null,
    };
  });
}
const pickPrior = (prior, claimId, i) => prior.find((p) => p.claimId === claimId && compareReceipts(i, p, "") && compareReceipts(i, p, "").kind !== "possible") || {};
