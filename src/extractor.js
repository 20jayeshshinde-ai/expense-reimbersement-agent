// Turns a raw document (photo / scan / PDF) into structured expense records using Claude vision.
// Falls back to an offline demo extractor (synthetic ground truth keyed by file hash) when no
// ANTHROPIC_API_KEY is configured, so the prototype can be demoed without network access.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES } from "./policy.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
export const LIVE = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const client = LIVE ? new Anthropic() : null;

const LineItem = z.object({ description: z.string(), amount: z.number() });

const Expense = z.object({
  document_type: z.enum(["receipt", "invoice", "e_ticket", "bank_statement_line", "not_an_expense"]),
  vendor: z.string().nullable().describe("Merchant / supplier name as printed"),
  date: z.string().nullable().describe("Date the expense was incurred, ISO YYYY-MM-DD. For hotels use check-out date. Null if not legible or absent."),
  currency: z.string().nullable().describe("ISO 4217 code, e.g. INR, USD"),
  total: z.number().nullable().describe("Final amount actually paid, including taxes and tips"),
  tax: z.number().nullable().describe("Total tax amount (GST/VAT) if shown"),
  category: z.enum(Object.keys(CATEGORIES)),
  city: z.string().nullable().describe("City where the expense was incurred (for flights: destination city)"),
  invoice_number: z.string().nullable(),
  payment_method: z.enum(["Card", "Cash", "UPI", "Bank transfer", "Wallet", "Unknown"]),
  nights: z.number().nullable().describe("Hotel nights, only for lodging"),
  alcohol_amount: z.number().nullable().describe("Sum of alcoholic line items if any, else null"),
  attendees: z.number().nullable().describe("Number of people / covers if printed, else null"),
  description: z.string().describe("Short human description, e.g. 'Cab from Andheri to airport'"),
  line_items: z.array(LineItem).describe("Main line items (max ~8)"),
  confidence: z.number().describe("0-1 overall confidence in the extraction"),
  low_confidence_fields: z.array(z.string()).describe("Field names that were hard to read or guessed"),
});

const Extraction = z.object({
  expenses: z.array(Expense).describe("One entry per distinct expense in the document (a PDF may hold several receipts)"),
  notes: z.string().nullable().describe("Anything the reviewer should know, e.g. 'image is blurry', 'page 2 is a duplicate copy'"),
});

const SYSTEM = `You are the document-understanding stage of a corporate expense reimbursement system.
Extract every distinct expense from the attached document exactly as printed. Rules:
- Never invent values. If a field is missing, torn, or illegible, return null and list it in low_confidence_fields.
- "total" is the amount actually paid (after tax, service charge, rounding, tips).
- Normalise dates to YYYY-MM-DD; Indian receipts usually use DD/MM/YYYY.
- Pick the single best category. Meals with clients or multiple covers that look like a business meal are client_entertainment; a solo coffee or lunch is meals.
- Report alcoholic line items in alcohol_amount (pre-tax line totals) so policy can exclude them.
- If the document is not an expense (e.g. a selfie, a blank page), return one entry with document_type "not_an_expense".`;

const mediaTypeFor = (file) => {
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
};

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function extractLive(buf, mediaType) {
  const data = buf.toString("base64");
  const docBlock = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data } };

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Extraction) },
    system: SYSTEM,
    messages: [{ role: "user", content: [docBlock, { type: "text", text: "Extract the expense data from this document." }] }],
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined to process this document.");
  if (response.stop_reason === "max_tokens") throw new Error("Extraction was cut off (document too long).");
  if (!response.parsed_output) throw new Error("Could not parse extraction output.");
  return { ...response.parsed_output, engine: MODEL, usage: response.usage };
}

let groundTruth = null;
function extractOffline(hash) {
  groundTruth ??= JSON.parse(fs.readFileSync(new URL("../samples/ground-truth.json", import.meta.url), "utf8"));
  const hit = groundTruth.find((g) => g.sha256 === hash);
  if (hit) {
    const { file, sha256: _, ...expense } = hit;
    return { expenses: [expense], notes: null, engine: "offline-demo" };
  }
  // Unknown file in demo mode: return an empty shell so the assistant asks the user for details.
  return {
    expenses: [{
      document_type: "receipt", vendor: null, date: null, currency: "INR", total: null, tax: null,
      category: "other", city: null, invoice_number: null, payment_method: "Unknown", nights: null,
      alcohol_amount: null, attendees: null, description: "Unrecognised document (demo mode – set ANTHROPIC_API_KEY for live AI extraction)",
      line_items: [], confidence: 0.1, low_confidence_fields: ["vendor", "date", "total"],
    }],
    notes: "Offline demo mode: only the bundled synthetic samples are recognised.",
    engine: "offline-demo",
  };
}

export async function extractDocument(file) {
  const buf = fs.readFileSync(file.path);
  const hash = sha256(buf);
  const mediaType = mediaTypeFor(file);
  const started = Date.now();
  const result = LIVE ? await extractLive(buf, mediaType) : extractOffline(hash);
  return { ...result, hash, mediaType, ms: Date.now() - started };
}

// ---- Conversational follow-up: map a free-text chat message onto the open questions ----

const ChatUpdate = z.object({
  updates: z.array(z.object({
    target_id: z.string().describe("Item id (e.g. 'it_3') or group id (e.g. 'grp_bengaluru') from the claim state"),
    field: z.enum(["purpose", "attendees", "attendee_names", "date", "total", "vendor", "category", "currency", "exclude", "confirm"]),
    value: z.string().describe("New value as a string; for exclude/confirm use 'true'"),
  })),
  reply: z.string().describe("One or two short, friendly sentences confirming what you understood, or asking a clarifying question"),
});

export async function interpretChat(message, claimSnapshot) {
  if (!LIVE) return null;
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ChatUpdate) },
    system: `You help an employee finish an expense claim over chat. Given the claim state (items, groups and open questions) and the employee's message, return field updates that answer open questions or fix items. Only use ids that exist in the state. Do not invent facts the employee did not say. Categories: ${Object.keys(CATEGORIES).join(", ")}.`,
    messages: [{ role: "user", content: `Claim state:\n${JSON.stringify(claimSnapshot)}\n\nEmployee message: ${message}` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return response.parsed_output;
}
