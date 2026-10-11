// Intake Agent – document understanding. Two engines produce the same structured record:
//  - Gemini or Claude vision/PDF (see llm.js) – primary, real-time engine when a key is in .env.
//    Also inspects each image for visual tampering.
//  - Local AI (neural OCR + receipt parser) – offline fallback when there is no key or the API is unreachable.
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES } from "./policy.js";
import { extractLocal, LOCAL_ENGINE } from "./localAI.js";
import { editingTraces, repairGstin } from "./forensics.js";
import { aiName, aiUsable, checkAI, extractJson, markKeyRejected, MODEL, status } from "./llm.js";

export { MODEL, status };
export const checkClaude = checkAI; // kept for server.js
export const engineName = () => (aiUsable() ? aiName() : LOCAL_ENGINE);

const AmountLine = z.object({ label: z.string(), amount: z.number(), kind: z.enum(["item", "subtotal", "tax", "charge", "discount"]) });

const Expense = z.object({
  document_type: z.enum(["receipt", "invoice", "e_ticket", "not_an_expense"]),
  vendor: z.string().nullable().describe("Merchant / supplier name as printed"),
  date: z.string().nullable().describe("Date the expense was incurred, ISO YYYY-MM-DD. Hotels: check-out date. Flights: travel date. Null if not legible or absent."),
  time: z.string().nullable().describe("Time printed on the bill, 24h HH:MM, else null"),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. INR, USD"),
  total: z.number().nullable().describe("Final amount actually paid as printed"),
  tax: z.number().nullable().describe("Total tax amount (GST/VAT) if shown"),
  category: z.enum(Object.keys(CATEGORIES)),
  city: z.string().nullable().describe("City where the expense was incurred (flights: destination city)"),
  invoice_number: z.string().nullable(),
  payment_method: z.enum(["Card", "Cash", "UPI", "Bank transfer", "Wallet", "Unknown"]),
  nights: z.number().nullable().describe("Hotel nights, only for lodging"),
  alcohol_amount: z.number().nullable().describe("Sum of alcoholic line items if any, else null"),
  attendees: z.number().nullable().describe("Number of covers / people if printed, else null"),
  gstin: z.string().nullable().describe("Supplier GSTIN exactly as printed, else null"),
  description: z.string().describe("Short human description, e.g. 'Cab from Andheri to airport'"),
  amount_lines: z.array(AmountLine).describe("Every printed amount row above the total (items, subtotal, taxes, service charges, rounding, discounts)"),
  visual_concerns: z.array(z.string()).describe("Signs of tampering visible in the image: mismatched fonts or digits, overwritten/pasted numbers, inconsistent alignment, blurred or patched areas. Empty if none."),
  confidence: z.number().describe("0-1 overall confidence"),
  low_confidence_fields: z.array(z.string()),
});

const Extraction = z.object({
  expenses: z.array(Expense).describe("One entry per distinct expense in the document"),
  notes: z.string().nullable(),
});

const SYSTEM = `You are the document-understanding and fraud-screening stage of a corporate expense reimbursement system.
Extract every distinct expense from the attached document exactly as printed. Never invent values: if a field is missing or illegible return null.
"total" is the printed amount paid. Copy each printed amount row into amount_lines as printed - do not correct arithmetic.
Normalise dates to YYYY-MM-DD; Indian receipts usually use DD/MM/YYYY.
Meals with several covers or alcohol are client_entertainment; a solo coffee or lunch is meals.
Look closely for visual signs of tampering and list them in visual_concerns.
If the document is not an expense (selfie, blank page), return one entry with document_type "not_an_expense".`;

const mediaTypeFor = (file) => {
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  return { ".pdf": "application/pdf", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext] || "image/jpeg";
};

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const EXTRACTION_SCHEMA = z.toJSONSchema(Extraction, { target: "draft-7" });

async function extractAI(buf, mediaType) {
  const out = await extractJson({ data: buf, mediaType }, SYSTEM, "Extract and screen this document.", EXTRACTION_SCHEMA);
  if (!Array.isArray(out?.expenses)) throw new Error("Unexpected extraction output.");
  for (const e of out.expenses) {
    if (e.gstin) e.gstin = repairGstin(e.gstin.replace(/[^0-9A-Z]/gi, ""));
    // Menu / line items (description + cost) are used for exact duplicate matching.
    e.line_items = (e.amount_lines || []).filter((l) => l.kind === "item").map(({ label, amount }) => ({ description: label, amount }));
  }
  return out;
}

export async function extractDocument(file) {
  const buf = fs.readFileSync(file.path);
  const mediaType = mediaTypeFor(file);
  const started = Date.now();
  let result, engine;
  if (aiUsable() && status.claude !== "no_key") {
    try {
      result = await extractAI(buf, mediaType);
      engine = aiName();
    } catch (e) {
      console.warn(`AI extraction failed for ${file.originalname} (${e.message}); using local AI.`);
      markKeyRejected(e);
    }
  }
  if (!result) {
    result = await extractLocal(buf, mediaType);
    engine = LOCAL_ENGINE;
  }
  return { ...result, engine, hash: sha256(buf), mediaType, editingTraces: editingTraces(buf, mediaType), ms: Date.now() - started };
}
