// Local AI extraction engine – runs fully offline, no API key needed.
// 1. Neural OCR (Tesseract LSTM) reads photos and scanned PDFs; digital PDFs use their text layer.
// 2. A receipt parser turns the raw text into the same structured record the Claude engine returns.
import { createScheduler, createWorker } from "tesseract.js";
import { getDocumentProxy, extractText, renderPageAsImage } from "unpdf";
import { createRequire } from "node:module";
import path from "node:path";
import { repairGstin } from "./forensics.js";

const require = createRequire(import.meta.url);
const langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng")), "4.0.0_best_int");
const cachePath = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))), ".ocr-cache");

// Cache the startup promise (not the scheduler) so parallel first uploads all wait for the workers.
let schedulerReady = null;
function getScheduler() {
  schedulerReady ??= (async () => {
    const s = createScheduler();
    const workers = await Promise.all([0, 1].map(() => createWorker("eng", 1, { langPath, gzip: true, cachePath })));
    workers.forEach((w) => s.addWorker(w));
    return s;
  })().catch((e) => { schedulerReady = null; throw e; });
  return schedulerReady;
}
export const warmUpOcr = () => getScheduler();

async function ocr(image) {
  const s = await getScheduler();
  const { data } = await s.addJob("recognize", image);
  return { text: data.text, confidence: (data.confidence || 0) / 100 };
}

async function readDocument(buf, mediaType) {
  if (mediaType !== "application/pdf") return ocr(buf);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  if (text.replace(/\s/g, "").length > 40) return { text, confidence: 0.99 }; // digital PDF
  const pages = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
    const png = await renderPageAsImage(pdf, p, { canvasImport: () => import("@napi-rs/canvas"), scale: 2 });
    pages.push(await ocr(Buffer.from(png)));
  }
  return { text: pages.map((p) => p.text).join("\n"), confidence: pages.reduce((s, p) => s + p.confidence, 0) / pages.length };
}

// ---------------- receipt parser ----------------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AMOUNT_AT_END = /(?:₹|rs\.?|inr|usd|\$|eur|€|gbp|£|aed|sgd)?\s*(-?\d{1,3}(?:,\d{2,3})+\.\d{2}|-?\d+\.\d{2})\s*$/i;
const toNum = (s) => Number(String(s).replace(/,/g, ""));

const CITIES = { mumbai: "Mumbai", bombay: "Mumbai", "new delhi": "Delhi", delhi: "Delhi", bengaluru: "Bengaluru", bangalore: "Bengaluru", chennai: "Chennai", hyderabad: "Hyderabad", kolkata: "Kolkata", pune: "Pune", gurugram: "Gurugram", gurgaon: "Gurugram", noida: "Noida", ahmedabad: "Ahmedabad", jaipur: "Jaipur", kochi: "Kochi", goa: "Goa", lucknow: "Lucknow", indore: "Indore", chandigarh: "Chandigarh", thane: "Mumbai", "navi mumbai": "Mumbai" };
const AIRPORTS = { BOM: "Mumbai", DEL: "Delhi", BLR: "Bengaluru", MAA: "Chennai", HYD: "Hyderabad", CCU: "Kolkata", PNQ: "Pune", AMD: "Ahmedabad", GOI: "Goa", COK: "Kochi", JAI: "Jaipur", LKO: "Lucknow", IXC: "Chandigarh" };

const CATEGORY_KEYWORDS = {
  travel_air: ["airways", "airline", "airlines", "flight", "e-ticket", "eticket", "pnr", "boarding", "aviation"],
  hotel: ["hotel", "residency", "resort", "folio", "check-in", "check-out", "checkout", "room", "suites", "lodge", "guest house", "stay"],
  taxi_rideshare: ["cab", "cabs", "taxi", "ride", "uber", "ola", "rapido", "trip invoice", "pickup", "drop"],
  travel_rail: ["irctc", "railway", "railways", "train", "coach", "berth", "bus"],
  fuel_mileage: ["fuel", "fuels", "petrol", "diesel", "litre", "pump", "indian oil", "bharat petroleum", "hpcl"],
  office_supplies: ["stationery", "paper", "notebook", "notebooks", "marker", "markers", "pen", "toner", "printer", "office"],
  software_subscriptions: ["subscription", "license", "licence", "saas", "software", "cloud", "plan renewal"],
  phone_internet: ["broadband", "mobile bill", "postpaid", "recharge", "internet", "wifi", "data pack"],
  training: ["course", "training", "conference", "certification", "seminar", "registration fee"],
  meals: ["restaurant", "cafe", "café", "coffee", "food", "dine", "kitchen", "bistro", "naan", "biryani", "cappuccino", "pizza", "burger", "table", "covers", "dal", "paneer", "lunch", "dinner", "breakfast", "bakery", "bread"],
};
const ALCOHOL = /\b(beer|wine|whisk(?:e)?y|vodka|rum|gin|lager|ipa|scotch|cocktail|sangria|champagne|pint|breezer|bira|kingfisher|tequila|bourbon)\b/i;

function findDates(line) {
  const out = [];
  const push = (m, y, mo, d) => {
    y = Number(y.length === 2 ? "20" + y : y); mo = Number(mo); d = Number(d);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 2000 && y < 2100) out.push({ index: m.index, end: m.index + m[0].length, iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  };
  for (const m of line.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(m, m[1], m[2], m[3]);
  for (const m of line.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/g)) {
    // Indian receipts are DD/MM/YYYY; swap only if that is impossible.
    if (Number(m[2]) > 12 && Number(m[1]) <= 12) push(m, m[3], m[1], m[2]); else push(m, m[3], m[2], m[1]);
  }
  for (const m of line.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3})[a-z]*[\s,\-]+(\d{4})\b/g)) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()); if (mo >= 0) push(m, m[3], mo + 1, m[1]);
  }
  for (const m of line.matchAll(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo >= 0) push(m, m[3], mo + 1, m[2]);
  }
  return out.sort((a, b) => a.index - b.index);
}

function pickDate(lines) {
  const cands = [];
  lines.forEach((line, li) => {
    let prevEnd = 0;
    for (const d of findDates(line)) {
      const label = line.slice(prevEnd, d.index).toLowerCase();
      prevEnd = d.end;
      let rank = 4;
      if (/check[\s-]*out|departure date/.test(label)) rank = 1;
      else if (/travel|journey|flight date|date of travel/.test(label)) rank = 2;
      else if (/booking|issue|printed|check[\s-]*in|valid|due/.test(label)) rank = 6;
      else if (/date|dt/.test(label)) rank = 3;
      cands.push({ ...d, rank, li });
    }
  });
  cands.sort((a, b) => a.rank - b.rank || a.li - b.li);
  return { date: cands[0]?.iso ?? null, all: cands };
}

function titleCase(s) {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s;
}

function pickVendor(lines) {
  for (const raw of lines.slice(0, 6)) {
    const l = raw.replace(/[^A-Za-z0-9&'.\- ]/g, "").trim();
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    if (letters < 4 || letters / l.length < 0.7) continue;
    if (/^(tax\s*)?(invoice|receipt|bill|cash memo|e-?ticket|welcome|gstin|date|thank)/i.test(l)) continue;
    if (!/[aeiou]/i.test(l) || /^(.)\1+$/i.test(l.replace(/\s/g, ""))) continue;
    return titleCase(l);
  }
  return null;
}

function classifyLine(l) {
  const s = l.toLowerCase();
  if (/sub[\s-]*total/.test(s)) return "subtotal";
  if (/\b(grand\s*total|total|net\s*(amount|payable)|amount\s*(paid|due|payable)|balance\s*due)\b/.test(s)) return "total";
  if (/gstin|tax invoice/.test(s)) return null;
  if (/\b(c?gst|sgst|igst|utgst|vat|cess|tax)\b/.test(s)) return "tax";
  if (/discount|coupon|less\b|promo/.test(s)) return "discount";
  if (/service|fee|charge|round|tip|surcharge|convenience/.test(s)) return "charge";
  return "item";
}

export function parseReceipt(text, ocrConfidence = 0.9) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lower = text.toLowerCase();

  const amountLines = [];
  const totals = [];
  for (const l of lines) {
    const kind = classifyLine(l);
    if (!kind) continue;
    // Totals are often printed without paise ("Grand Total 689"), so accept whole numbers there.
    const m = l.match(AMOUNT_AT_END) || (kind === "total" ? l.match(/(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d{2,7})(?:\.\d{1,2})?\s*\/?-?\s*$/i) : null);
    if (!m) continue;
    const amount = toNum(m[1]);
    const label = l.slice(0, m.index).replace(/(₹|rs\.?|inr)\s*$/i, "").trim();
    if (kind === "total") totals.push({ label, amount, strong: /grand|paid|net|payable/i.test(l) });
    else amountLines.push({ label, amount, kind });
  }
  const strongTotal = totals.filter((t) => t.strong).pop();
  let total = (strongTotal || totals[totals.length - 1])?.amount ?? null;
  if (total == null && amountLines.length) {
    // No total line readable: derive it from subtotal (or items) + taxes + charges − discounts.
    const sum = (k) => amountLines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
    const sub = amountLines.find((l) => l.kind === "subtotal")?.amount ?? sum("item");
    total = Math.round((sub + sum("tax") + sum("charge") - sum("discount")) * 100) / 100 || null;
  }

  const { date } = pickDate(lines);
  const vendor = pickVendor(lines);

  let currency = "INR";
  if (/\busd\b|\$/.test(text)) currency = "USD";
  else if (/\beur\b|€/.test(text)) currency = "EUR";
  else if (/\bgbp\b|£/.test(text)) currency = "GBP";
  else if (/\baed\b|dirham/i.test(text)) currency = "AED";
  else if (/\bsgd\b/i.test(text)) currency = "SGD";

  const taxLines = amountLines.filter((l) => l.kind === "tax");
  const tax = taxLines.length ? Math.round(taxLines.reduce((s, l) => s + l.amount, 0) * 100) / 100 : null;

  // Labels and values must sit on the same line ([ \t] not \s), otherwise "Tax Invoice\nInvoice No" swallows the real label.
  const INV = /(?:invoice[ \t]*(?:no|number|#)?|bill[ \t]*(?:no|number|#)|receipt[ \t]*(?:no|number|#)|order[ \t]*(?:no|id|#)|folio(?:[ \t]*\/[ \t]*invoice)?|cash[ \t]*memo|txn[ \t]*id|booking[ \t]*id|pnr)[ \t]*[:#.]?[ \t]*#?[ \t]*([A-Z0-9][A-Z0-9/\-]{2,})/gi;
  const invoice_number = [...text.matchAll(INV)].map((m) => m[1]).find((v) => /\d/.test(v)) ?? null;

  let payment_method = "Unknown";
  if (/\bupi\b|gpay|google pay|phonepe|paytm|bhim/i.test(text)) payment_method = "UPI";
  else if (/card|visa|master\s*card|amex|rupay|\*{3,}\s*\d{4}/i.test(text)) payment_method = "Card";
  else if (/\bcash\b/i.test(text)) payment_method = "Cash";
  else if (/neft|imps|rtgs|bank transfer/i.test(text)) payment_method = "Bank transfer";

  const gm = text.match(/GSTIN\s*(?:no\.?)?\s*[:\-]?\s*([0-9A-Z.\s]{15,20})/i) || text.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/);
  const gstin = gm ? repairGstin(gm[1].replace(/[^0-9A-Z]/gi, "").slice(0, 15)) : null;

  // category by keyword votes
  let category = "other", best = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((s, w) => s + (new RegExp(`(^|[^a-z])${w.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(lower) ? 1 : 0), 0);
    if (score > best) { best = score; category = cat; }
  }
  const covers = Number(text.match(/(?:covers?|pax|guests?|persons?)\s*[:\-]?\s*(\d{1,2})\b/i)?.[1]) || null;
  const alcoholLines = amountLines.filter((l) => l.kind === "item" && ALCOHOL.test(l.label));
  const alcohol_amount = alcoholLines.length ? alcoholLines.reduce((s, l) => s + l.amount, 0) : null;
  if (category === "meals" && ((covers && covers >= 2) || alcohol_amount)) category = "client_entertainment";

  // city: flight destination, else first city mentioned
  let city = null;
  const route = text.match(/\b([A-Z]{3})\s*(?:->|→|–>|-|to|—)\s*>?\s*([A-Z]{3})\b/);
  if (category === "travel_air" && route && AIRPORTS[route[2]]) city = AIRPORTS[route[2]];
  if (!city) {
    let first = Infinity;
    for (const [k, v] of Object.entries(CITIES)) {
      const i = lower.search(new RegExp(`\\b${k}\\b`));
      if (i >= 0 && i < first) { first = i; city = v; }
    }
  }

  let nights = Number(text.match(/nights?\s*[:\-]?\s*(\d{1,2})\b/i)?.[1]) || null;
  if (category === "hotel" && !nights) {
    const { all } = pickDate(lines);
    const inD = all.find((d) => d.rank === 6), outD = all.find((d) => d.rank === 1);
    if (inD && outD) nights = Math.max(1, Math.round((new Date(outD.iso) - new Date(inD.iso)) / 86_400_000));
  }
  if (category !== "hotel") nights = null;

  const items = amountLines.filter((l) => l.kind === "item");
  let description;
  if (category === "travel_air" && route) description = `Flight ${route[1]} → ${route[2]}`;
  else if (category === "hotel") description = `${nights || 1} night${nights > 1 ? "s" : ""} stay${city ? ` in ${city}` : ""}`;
  else description = items.slice(0, 3).map((l) => l.label.replace(/\s+x?\d+$/, "")).join(", ") || vendor || "Expense";

  const missing = ["vendor", "date", "total"].filter((f) => ({ vendor, date, total })[f] == null);
  return {
    document_type: "receipt",
    vendor, date, currency, total, tax, category, city, invoice_number, payment_method, nights,
    alcohol_amount, attendees: covers, description,
    line_items: items.slice(0, 8).map(({ label, amount }) => ({ description: label, amount })),
    amount_lines: amountLines,
    gstin,
    confidence: Math.round(Math.max(0.1, ocrConfidence * (1 - missing.length * 0.25)) * 100) / 100,
    low_confidence_fields: missing,
    visual_concerns: [],
  };
}

export async function extractLocal(buf, mediaType) {
  const { text, confidence } = await readDocument(buf, mediaType);
  if (text.replace(/\s/g, "").length < 15) {
    return { expenses: [{ document_type: "not_an_expense" }], notes: "No readable text found in this document.", rawText: text };
  }
  return { expenses: [parseReceipt(text, confidence)], notes: null, rawText: text };
}

export const LOCAL_ENGINE = "Local AI (neural OCR + receipt parser)";
