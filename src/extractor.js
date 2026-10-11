// Document understanding. Two engines produce the same structured record:
//  - Claude (vision + native PDF) – primary, real-time engine when ANTHROPIC_API_KEY is set (.env).
//    Also inspects each image for visual tampering.
//  - Local AI (neural OCR + receipt parser) – offline fallback when there is no key or Claude is unreachable.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES } from "./policy.js";
import { extractLocal, LOCAL_ENGINE } from "./localAI.js";
import { editingTraces, repairGstin } from "./forensics.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const HAS_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = HAS_KEY ? new Anthropic() : null;

// Live engine status, verified against the API at startup (see checkClaude).
export const status = { claude: HAS_KEY ? "checking" : "no_key", detail: HAS_KEY ? "Verifying API key…" : "No ANTHROPIC_API_KEY in .env", model: MODEL };
const claudeUsable = () => status.claude === "ok" || status.claude === "checking";
export const engineName = () => (claudeUsable() ? `Claude (${MODEL})` : LOCAL_ENGINE);

export async function checkClaude() {
  if (!client) return status;
  try {
    await client.models.retrieve(MODEL);
    Object.assign(status, { claude: "ok", detail: `Connected · ${MODEL}` });
  } catch (e) {
    const why = e instanceof Anthropic.AuthenticationError ? "API key rejected (401) – check ANTHROPIC_API_KEY"
      : e instanceof Anthropic.NotFoundError ? `Model ${MODEL} not available on this key`
      : e instanceof Anthropic.APIConnectionError ? "Cannot reach api.anthropic.com (network / proxy)"
      : e.message;
    Object.assign(status, { claude: "error", detail: why });
  }
  return status;
}

const AmountLine = z.object({ label: z.string(), amount: z.number(), kind: z.enum(["item", "subtotal", "tax", "charge", "discount"]) });

const Expense = z.object({
  document_type: z.enum(["receipt", "invoice", "e_ticket", "not_an_expense"]),
  vendor: z.string().nullable().describe("Merchant / supplier name as printed"),
  date: z.string().nullable().describe("Date the expense was incurred, ISO YYYY-MM-DD. Hotels: check-out date. Flights: travel date. Null if not legible or absent."),
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

async function extractClaude(buf, mediaType) {
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
    messages: [{ role: "user", content: [docBlock, { type: "text", text: "Extract and screen this document." }] }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to process this document.");
  if (response.stop_reason === "max_tokens") throw new Error("Extraction was cut off (document too long).");
  if (!response.parsed_output) throw new Error("Could not parse extraction output.");
  const out = response.parsed_output;
  for (const e of out.expenses) if (e.gstin) e.gstin = repairGstin(e.gstin.replace(/[^0-9A-Z]/gi, ""));
  return out;
}

export async function extractDocument(file) {
  const buf = fs.readFileSync(file.path);
  const mediaType = mediaTypeFor(file);
  const started = Date.now();
  let result, engine;
  if (client && claudeUsable()) {
    try {
      result = await extractClaude(buf, mediaType);
      engine = `Claude (${MODEL})`;
    } catch (e) {
      console.warn(`Claude extraction failed for ${file.originalname} (${e.message}); using local AI.`);
      if (e instanceof Anthropic.AuthenticationError) Object.assign(status, { claude: "error", detail: "API key rejected (401)" });
    }
  }
  if (!result) {
    result = await extractLocal(buf, mediaType);
    engine = LOCAL_ENGINE;
  }
  return { ...result, engine, hash: sha256(buf), mediaType, editingTraces: editingTraces(buf, mediaType), ms: Date.now() - started };
}
