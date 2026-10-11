// Claim engine: the deterministic "source of truth" layer on top of AI extraction.
// It owns item state, grouping, duplicate detection, policy checks, the minimal question set,
// and the readiness verdict. The LLM never decides whether something is compliant – rules do.
import { CATEGORIES, FX_TO_INR, POLICY, TRAVEL_ANCHORS, isMetro } from "./policy.js";
import { priorClaimItems } from "./mockFinance.js";

const DAY = 86_400_000;
const today = () => new Date(process.env.DEMO_TODAY || Date.now());
const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / DAY);
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function createClaim(employee = { name: "Asha Verma (demo)", id: "E-10293", costCenter: "CC-4410 Product" }) {
  return { employee, items: [], groups: {}, answers: {}, docs: [], seq: 0, submitted: null, log: [] };
}

export function addExtraction(claim, fileName, extraction) {
  const doc = { name: fileName, hash: extraction.hash, engine: extraction.engine, ms: extraction.ms, notes: extraction.notes };
  claim.docs.push(doc);
  const added = [];
  for (const e of extraction.expenses) {
    if (e.document_type === "not_an_expense") {
      claim.log.push(`Skipped ${fileName}: not an expense document.`);
      continue;
    }
    const item = {
      id: `it_${++claim.seq}`,
      file: fileName,
      fileHash: extraction.hash,
      ...e,
      currency: (e.currency || "INR").toUpperCase(),
      excluded: false,
      userEdited: [],
    };
    claim.items.push(item);
    added.push(item);
  }
  return added;
}

// ---------------- grouping ----------------
// Trips are anchored on flights / rail / hotels; nearby-dated items are attached to the trip,
// everything else lands in "Local & other". This lets us ask "what was the trip for?" once.
function buildGroups(claim) {
  const items = claim.items.filter((i) => !i.excluded);
  const anchors = items.filter((i) => TRAVEL_ANCHORS.has(i.category) && i.date && i.city);
  const trips = [];
  for (const a of anchors.sort((x, y) => x.date.localeCompare(y.date))) {
    const city = a.city.replace(/bangalore/i, "Bengaluru");
    let trip = trips.find((t) => norm(t.city) === norm(city));
    if (!trip) trips.push((trip = { city, start: a.date, end: a.date }));
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
    groups[id] = { id, kind: "trip", title: `Trip to ${t.city}`, start: t.start, end: t.end, itemIds: [] };
  }
  groups.grp_local = { id: "grp_local", kind: "local", title: "Local & other expenses", itemIds: [] };

  for (const i of claim.items) {
    let gid = "grp_local";
    if (i.date) {
      const trip = Object.values(groups).find((g) => g.kind === "trip" &&
        new Date(i.date) >= new Date(new Date(g.start) - DAY) && new Date(i.date) <= new Date(+new Date(g.end) + DAY));
      if (trip) gid = trip.id;
    }
    i.groupId = gid;
    groups[gid].itemIds.push(i.id);
  }
  if (!groups.grp_local.itemIds.length) delete groups.grp_local;
  claim.groups = groups;
}

// ---------------- duplicates ----------------
function detectDuplicates(claim) {
  const prior = priorClaimItems().filter((p) => p.claimId !== claim.submitted?.claimId);
  const live = claim.items.filter((i) => !i.excluded);
  for (const i of claim.items) i.duplicate = null;
  for (const [idx, a] of live.entries()) {
    for (const b of live.slice(0, idx)) {
      if (a.fileHash === b.fileHash) {
        a.duplicate = { of: b.id, kind: "exact", reason: `Same file uploaded twice (${b.file}).` };
      } else if (a.invoice_number && b.invoice_number && norm(a.invoice_number) === norm(b.invoice_number) && norm(a.vendor) === norm(b.vendor)) {
        a.duplicate = { of: b.id, kind: "probable", reason: `Same vendor and invoice no. ${a.invoice_number} as ${b.file} – looks like a second photo of the same receipt.` };
      } else if (a.total && a.total === b.total && a.date && a.date === b.date && norm(a.vendor) === norm(b.vendor)) {
        a.duplicate = { of: b.id, kind: "probable", reason: `Same vendor, date and amount as ${b.file}.` };
      }
      if (a.duplicate?.kind === "probable" && a.dupOverride) a.duplicate = null;
      if (a.duplicate) break;
    }
    if (a.duplicate) continue;
    const p = prior.find((p) => norm(p.vendor) === norm(a.vendor) && p.total === a.total &&
      (p.date === a.date || (p.invoice_number && norm(p.invoice_number) === norm(a.invoice_number))));
    if (p) a.duplicate = { of: p.claimId, kind: "already_claimed", reason: `Already reimbursed in claim ${p.claimId} (${p.status}).` };
  }
}

// ---------------- per-item checks ----------------
function amountInr(i) {
  if (i.total == null) return null;
  const rate = FX_TO_INR[i.currency];
  return rate ? i.total * rate : null;
}

function checkItem(claim, i) {
  const issues = []; // {level: 'blocker'|'warning'|'info', code, text}
  i.reimbursable = null;
  if (i.excluded) return issues;
  const inr = amountInr(i);

  if (!i.vendor) issues.push({ level: "blocker", code: "missing_vendor", text: "Vendor name not readable." });
  if (!i.date) issues.push({ level: "blocker", code: "missing_date", text: "Expense date is missing or unreadable." });
  if (i.total == null) issues.push({ level: "blocker", code: "missing_total", text: "Total amount not readable." });
  if (i.total != null && inr == null) issues.push({ level: "blocker", code: "unknown_currency", text: `No FX rate for ${i.currency}.` });
  if (i.confidence < 0.6 && !i.userEdited.length) issues.push({ level: "warning", code: "low_confidence", text: "Low-confidence read – please glance at the values." });

  if (i.duplicate) {
    const level = i.duplicate.kind === "already_claimed" || i.duplicate.kind === "exact" ? "blocker" : "warning";
    issues.push({ level, code: `dup_${i.duplicate.kind}`, text: i.duplicate.reason });
  }

  if (i.date) {
    const age = daysBetween(today(), i.date);
    if (age > POLICY.submissionWindowDays) issues.push({ level: "blocker", code: "too_old", text: `Expense is ${age} days old; policy window is ${POLICY.submissionWindowDays} days.` });
    if (age < -1) issues.push({ level: "warning", code: "future_date", text: "Date is in the future – check the date." });
  }

  let reimbursable = inr;
  if (inr != null) {
    if (i.category === "hotel") {
      const nights = i.nights || 1;
      const cap = isMetro(i.city) ? POLICY.hotelNightlyCap.metro : POLICY.hotelNightlyCap.other;
      const perNight = inr / nights;
      if (perNight > cap) {
        reimbursable = Math.min(reimbursable, cap * nights);
        issues.push({ level: "warning", code: "over_cap", text: `${fmt(perNight)}/night exceeds the ${fmt(cap)}/night ${isMetro(i.city) ? "metro" : ""} cap – ${fmt(inr - cap * nights)} will not be reimbursed unless an exception is approved.` });
      }
    }
    if (i.alcohol_amount && !POLICY.alcoholReimbursable) {
      const alc = i.alcohol_amount * (FX_TO_INR[i.currency] || 1);
      reimbursable -= alc;
      issues.push({ level: "info", code: "alcohol", text: `Alcohol (${fmt(alc)}) is not reimbursable and has been deducted.` });
    }
    if (i.category === "meals" && reimbursable > POLICY.mealsPerReceiptCap) {
      issues.push({ level: "warning", code: "over_cap", text: `Meals are capped at ${fmt(POLICY.mealsPerReceiptCap)} per receipt.` });
      reimbursable = POLICY.mealsPerReceiptCap;
    }
    if (i.category === "office_supplies" && reimbursable > POLICY.officeSuppliesCap) {
      issues.push({ level: "warning", code: "over_cap", text: `Office supplies are capped at ${fmt(POLICY.officeSuppliesCap)} per receipt.` });
      reimbursable = POLICY.officeSuppliesCap;
    }
    if (i.category === "client_entertainment") {
      const heads = Number(claim.answers[`${i.id}.attendees`]) || null;
      if (heads) {
        const cap = POLICY.entertainmentPerHeadCap * heads;
        if (reimbursable > cap) {
          issues.push({ level: "warning", code: "over_cap", text: `Exceeds ${fmt(POLICY.entertainmentPerHeadCap)}/head for ${heads} people.` });
          reimbursable = cap;
        }
      }
    }
  }
  i.amountInr = inr;
  i.reimbursable = reimbursable == null ? null : Math.max(0, Math.round(reimbursable * 100) / 100);
  if (i.duplicate && (i.duplicate.kind === "already_claimed" || i.duplicate.kind === "exact")) i.reimbursable = 0;
  return issues;
}

// ---------------- questions ----------------
// Ask the minimum: one purpose question per trip/group, attendee details only where policy needs
// them, and a value only when we truly could not read it. Duplicates get a yes/no.
function buildQuestions(claim) {
  const qs = [];
  const a = claim.answers;
  for (const g of Object.values(claim.groups)) {
    const items = g.itemIds.map((id) => claim.items.find((i) => i.id === id)).filter((i) => !i.excluded);
    const needsPurpose = items.some((i) => POLICY.purposeRequired.has(i.category));
    if (needsPurpose && !a[`${g.id}.purpose`]) {
      qs.push({
        id: `${g.id}.purpose`, target: g.id, field: "purpose", kind: "text",
        text: g.kind === "trip"
          ? `What was the business purpose of your ${g.title.replace(/^Trip/, "trip")} (${g.start} → ${g.end})?`
          : `What was the business purpose of these local expenses (${items.filter((i) => POLICY.purposeRequired.has(i.category)).map((i) => i.vendor || "item").join(", ")})?`,
        suggestions: g.kind === "trip" ? ["Client meeting", "Internal offsite", "Conference / training", "Project delivery"] : ["Team supplies", "Client workshop materials"],
      });
    }
  }
  for (const i of claim.items.filter((i) => !i.excluded)) {
    const label = `${CATEGORIES[i.category]?.icon || ""} ${i.vendor || i.file}`;
    if (i.duplicate?.kind === "probable" && !a[`${i.id}.dup`]) {
      qs.push({ id: `${i.id}.dup`, target: i.id, field: "duplicate", kind: "choice", text: `${label} looks like a duplicate: ${i.duplicate.reason} Remove it?`, suggestions: ["Yes, remove it", "No, it's a separate expense"] });
    }
    const hardBlock = i.issues.find((x) => ["dup_already_claimed", "dup_exact", "too_old"].includes(x.code));
    if (hardBlock && !a[`${i.id}.remove`]) {
      qs.push({ id: `${i.id}.remove`, target: i.id, field: "exclude", kind: "choice", text: `${label}: ${hardBlock.text} It can't be reimbursed – remove it from this claim?`, suggestions: ["Yes, remove it"] });
      continue;
    }
    if (POLICY.attendeesRequired.has(i.category)) {
      if (!a[`${i.id}.attendees`]) {
        const hint = i.attendees ? ` The bill shows ${i.attendees} covers.` : "";
        qs.push({ id: `${i.id}.attendees`, target: i.id, field: "attendees", kind: "number", text: `${label} (${fmt(i.amountInr || 0)}): how many people attended, including you?${hint}`, suggestions: i.attendees ? [String(i.attendees)] : [] });
      }
      if (!a[`${i.id}.attendee_names`]) {
        qs.push({ id: `${i.id}.attendee_names`, target: i.id, field: "attendee_names", kind: "text", text: `${label}: who did you host? (names and company – e.g. "R. Mehta, Contoso Ltd")`, suggestions: [] });
      }
    }
    if (!i.date) qs.push({ id: `${i.id}.date`, target: i.id, field: "date", kind: "date", text: `${label}: I couldn't read the date. When was this purchase?`, suggestions: [] });
    if (i.total == null) qs.push({ id: `${i.id}.total`, target: i.id, field: "total", kind: "number", text: `${label}: what was the total paid?`, suggestions: [] });
    if (!i.vendor) qs.push({ id: `${i.id}.vendor`, target: i.id, field: "vendor", kind: "text", text: `${i.file}: what's the vendor / merchant name?`, suggestions: [] });
  }
  return qs;
}

// ---------------- recompute everything ----------------
export function evaluate(claim) {
  buildGroups(claim);
  detectDuplicates(claim);
  for (const i of claim.items) {
    i.issues = checkItem(claim, i);
    const purpose = claim.answers[`${i.groupId}.purpose`];
    i.purpose = purpose || null;
    i.attendeesConfirmed = claim.answers[`${i.id}.attendees`] || null;
    i.attendeeNames = claim.answers[`${i.id}.attendee_names`] || null;
    const blockers = i.issues.filter((x) => x.level === "blocker").length;
    const warnings = i.issues.filter((x) => x.level === "warning").length;
    i.status = i.excluded ? "excluded" : blockers ? "blocked" : warnings ? "review" : "ready";
  }
  const questions = buildQuestions(claim);
  const live = claim.items.filter((i) => !i.excluded);
  const claimed = live.reduce((s, i) => s + (i.amountInr || 0), 0);
  const reimbursable = live.filter((i) => i.status !== "blocked").reduce((s, i) => s + (i.reimbursable || 0), 0);
  const byCategory = {};
  for (const i of live.filter((i) => i.status !== "blocked")) {
    byCategory[i.category] = (byCategory[i.category] || 0) + (i.reimbursable || 0);
  }
  const blocked = live.filter((i) => i.status === "blocked");
  const review = live.filter((i) => i.status === "review");
  const ready = live.length > 0 && questions.length === 0 && blocked.length === 0;
  const totals = {
    items: live.length,
    claimed: Math.round(claimed),
    reimbursable: Math.round(reimbursable),
    deducted: Math.round(claimed - reimbursable),
    byCategory,
  };
  // Rough "time saved" estimate: ~6 min manual handling per receipt vs. ~1 min with the assistant.
  const minutesSaved = live.length * 5;
  return {
    employee: claim.employee,
    items: claim.items,
    groups: Object.values(claim.groups),
    questions,
    totals,
    readiness: {
      ready,
      requiresManagerApproval: reimbursable > POLICY.managerApprovalAbove,
      blockedCount: blocked.length,
      reviewCount: review.length,
      openQuestions: questions.length,
      progress: live.length ? Math.round((live.filter((i) => i.status === "ready" || i.status === "review").length / live.length) * 100 * (questions.length ? 0.85 : 1)) : 0,
    },
    minutesSaved,
    docs: claim.docs,
    submitted: claim.submitted,
  };
}

// ---------------- applying answers / edits ----------------
const toDate = (v) => {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = s.toLowerCase().match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s*(\d{4})?/);
  if (m && months.includes(m[2])) return `${m[3] || today().getFullYear()}-${String(months.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const toNumber = (v) => {
  const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export function applyUpdate(claim, target, field, value) {
  const item = claim.items.find((i) => i.id === target);
  switch (field) {
    case "purpose":
      claim.answers[`${target.startsWith("grp_") ? target : item?.groupId}.purpose`] = String(value).trim();
      return true;
    case "attendees": {
      const n = toNumber(value);
      if (!item || !n) return false;
      claim.answers[`${item.id}.attendees`] = n;
      return true;
    }
    case "attendee_names":
      if (!item) return false;
      claim.answers[`${item.id}.attendee_names`] = String(value).trim();
      return true;
    case "duplicate":
      if (!item) return false;
      claim.answers[`${item.id}.dup`] = String(value);
      if (/^(y|yes|true|remove)/i.test(String(value))) item.excluded = true;
      else item.dupOverride = true; // user confirmed it's a separate expense
      return true;
    case "exclude":
      if (!item) return false;
      item.excluded = /^(true|yes|1)$/i.test(String(value));
      return true;
    case "date": {
      const d = toDate(value);
      if (!item || !d) return false;
      item.date = d;
      item.userEdited.push("date");
      return true;
    }
    case "total": {
      const n = toNumber(value);
      if (!item || n == null) return false;
      item.total = n;
      item.userEdited.push("total");
      return true;
    }
    case "vendor":
    case "currency":
      if (!item) return false;
      item[field] = field === "currency" ? String(value).toUpperCase() : String(value);
      item.userEdited.push(field);
      return true;
    case "category":
      if (!item || !CATEGORIES[value]) return false;
      item.category = value;
      item.userEdited.push("category");
      return true;
    default:
      return false;
  }
}

// Offline (no-LLM) chat fallback: answer the first open question with the message.
export function answerTopQuestion(claim, message) {
  const { questions } = evaluate(claim);
  const q = questions[0];
  if (!q) return { ok: false, reply: "Nothing is pending – your claim is ready to submit." };
  const ok = applyUpdate(claim, q.target, q.field, message);
  return { ok, reply: ok ? "Got it 👍" : `Sorry, I couldn't use that for: "${q.text}"` };
}

export function buildSubmission(claim) {
  const s = evaluate(claim);
  return {
    employee: claim.employee,
    policy: POLICY.name,
    requiresManagerApproval: s.readiness.requiresManagerApproval,
    totals: s.totals,
    lines: s.items.filter((i) => !i.excluded && i.status !== "blocked").map((i) => ({
      date: i.date, vendor: i.vendor, category: CATEGORIES[i.category].label, glCode: CATEGORIES[i.category].glCode,
      description: i.description, currency: i.currency, amount: i.total, amountInr: i.amountInr,
      reimbursableInr: i.reimbursable, tax: i.tax, invoiceNumber: i.invoice_number, paymentMethod: i.payment_method,
      purpose: i.purpose, attendees: i.attendeesConfirmed, attendeeNames: i.attendeeNames,
      policyNotes: i.issues.map((x) => x.text), receiptFile: i.file, receiptSha256: i.fileHash,
    })),
  };
}
