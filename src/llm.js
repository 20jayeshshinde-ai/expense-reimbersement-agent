// AI provider layer. All agents call these three functions, so each one can run on
// Google Gemini or Anthropic Claude, whichever key is in .env:
//   extractJson(document, prompt, schema)  – vision/PDF → structured JSON (Intake Agent)
//   chatText(system, messages)             – plain-text reply (Chat Assistant)
//   toolTurn(system, history, tools)       – one turn of a function-calling loop (Audit Agent)
// Preference: AI_PROVIDER=gemini|claude if set, else Gemini when GEMINI_API_KEY exists, else Claude.
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const provider = (process.env.AI_PROVIDER || (GEMINI_KEY ? "gemini" : CLAUDE_KEY ? "claude" : "none")).toLowerCase();
let gemini = provider === "gemini" && GEMINI_KEY ? new GoogleGenAI({ apiKey: GEMINI_KEY }) : null;
let claude = provider === "claude" && CLAUDE_KEY ? new Anthropic() : null;

export let MODEL = gemini ? GEMINI_MODEL : CLAUDE_MODEL;
let label = gemini ? "Gemini" : "Claude";

// Live status, verified against the provider at startup (see checkAI).
export const status = gemini || claude
  ? { state: "checking", provider: label, model: MODEL, detail: `Verifying ${label} API key…` }
  : { state: "no_key", provider: null, model: null, detail: "No GEMINI_API_KEY or ANTHROPIC_API_KEY in .env" };
// state: ok | checking | error | no_key

// Test seam: swap in a fake Gemini/Claude client (same method shapes) to exercise the adapters offline.
export function useClientForTests({ gemini: g = null, claude: c = null } = {}) {
  gemini = g;
  claude = c;
  MODEL = g ? GEMINI_MODEL : CLAUDE_MODEL;
  label = g ? "Gemini" : "Claude";
  Object.assign(status, g || c ? { state: "ok", provider: label, model: MODEL, detail: "test client" } : { state: "no_key", provider: null, model: null, detail: "No key" });
  cooldownUntil.clear();
}

export const aiUsable = () => status.state === "ok" || status.state === "checking";
export const aiName = () => `${label} (${gemini ? lastModelUsed.name : MODEL})`;

export async function checkAI() {
  if (!gemini && !claude) return status;
  try {
    // A real (tiny) generation call: model listing can succeed for models a key can no longer use.
    if (gemini) await gemini.models.generateContent({ model: MODEL, contents: "ping", config: { maxOutputTokens: 1 } });
    else await claude.models.retrieve(MODEL);
    Object.assign(status, { state: "ok", detail: `Connected · ${MODEL}` });
  } catch (e) {
    const code = e?.status;
    // Busy or rate-limited means the key works; stay live and let per-request retries handle it.
    if ([429, 500, 503].includes(code)) {
      Object.assign(status, { state: "ok", detail: `Connected · ${MODEL} (busy at startup – requests will retry)` });
      return status;
    }
    const why = code === 401 || code === 403 || /api key/i.test(e.message) ? `${label} API key rejected – check .env`
      : code === 404 ? `Model ${MODEL} not available on this key`
      : /fetch failed|ENOTFOUND|ECONN|network/i.test(e.message) ? `Cannot reach the ${label} API (network / proxy)`
      : e.message.slice(0, 160);
    Object.assign(status, { state: "error", detail: why });
  }
  return status;
}

export function markKeyRejected(e) {
  if (e?.status === 401 || e?.status === 403) Object.assign(status, { state: "error", detail: `${label} API key rejected` });
}

// ---------------- Gemini rate limiting ----------------
// Free-tier keys allow ~5 requests/minute *per model*, and models are sometimes overloaded (503).
// Requests go to the preferred model first; when it is rate-limited or busy, the next request is
// routed to another Flash model (each has its own quota) instead of waiting. Concurrency is capped.
const GEMINI_POOL = [...new Set([GEMINI_MODEL, ...(process.env.GEMINI_MODEL_POOL || "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean)])];
const cooldownUntil = new Map(); // model -> timestamp when it may be used again
const MAX_PARALLEL = Number(process.env.GEMINI_MAX_PARALLEL || 3);
let active = 0;
const queue = [];
async function limited(fn) {
  if (active >= MAX_PARALLEL) await new Promise((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryAfter = (e) => {
  const m = String(e?.message || "").match(/retry in ([\d.]+)s|"retryDelay":"(\d+)s"/);
  return m ? Number(m[1] || m[2]) * 1000 : null;
};
const pickModel = () => {
  const now = Date.now();
  return GEMINI_POOL.find((m) => (cooldownUntil.get(m) || 0) <= now)
    || GEMINI_POOL.reduce((a, b) => ((cooldownUntil.get(a) || 0) <= (cooldownUntil.get(b) || 0) ? a : b));
};
export const lastModelUsed = { name: GEMINI_MODEL };

async function geminiGenerate(params) {
  return limited(async () => {
    for (let attempt = 0; ; attempt++) {
      const model = pickModel();
      const wait = (cooldownUntil.get(model) || 0) - Date.now();
      if (wait > 0) await sleep(Math.min(wait, 20000)); // every model cooling down: wait for the soonest
      try {
        const r = await gemini.models.generateContent({ ...params, model });
        lastModelUsed.name = model;
        return r;
      } catch (e) {
        const code = e?.status;
        const network = !code && /fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(String(e?.message));
        if (network && attempt < 4) {
          console.warn(`Gemini network error (${e.message}); retrying`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (![429, 500, 503].includes(code) || attempt >= 8) throw e;
        const cool = code === 429 ? retryAfter(e) ?? 30000 : 8000;
        cooldownUntil.set(model, Date.now() + cool);
        console.warn(`Gemini ${code} on ${model}; cooling it for ${Math.round(cool / 1000)}s and trying another model`);
      }
    }
  });
}

// ---------------- 1. structured extraction from a document ----------------
export async function extractJson({ data, mediaType }, system, prompt, jsonSchema) {
  if (gemini) {
    const r = await geminiGenerate({
      model: MODEL,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mediaType, data: data.toString("base64") } }, { text: prompt }] }],
      config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: jsonSchema, temperature: 0 },
    });
    if (!r.text) throw new Error(`Gemini returned no output (${r.candidates?.[0]?.finishReason || "blocked"})`);
    return JSON.parse(r.text);
  }
  const b64 = data.toString("base64");
  const block = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
  const r = await claude.beta.messages.create({
    model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: jsonSchema } },
    system, messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }],
  });
  if (r.stop_reason === "refusal") throw new Error("The model declined to process this document.");
  if (r.stop_reason === "max_tokens") throw new Error("Extraction was cut off.");
  return JSON.parse(r.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

// ---------------- 2. plain chat ----------------
// messages: [{role: "user"|"assistant", content: string}], starting with user, alternating.
export async function chatText(system, messages) {
  if (gemini) {
    const r = await geminiGenerate({
      model: MODEL,
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      config: { systemInstruction: system, temperature: 0.3 },
    });
    return r.text?.trim() || null;
  }
  const r = await claude.beta.messages.create({
    model: MODEL, max_tokens: 2000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low" }, system, messages,
  });
  if (r.stop_reason === "refusal") return null;
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
}

// ---------------- 3. function-calling loop (one turn) ----------------
// tools: [{name, description, parameters (JSON schema)}]
// Returns { text, calls: [{id, name, args}] }. Feed results back with addToolResults().
export function newConversation(userText) {
  return gemini ? [{ role: "user", parts: [{ text: userText }] }] : [{ role: "user", content: userText }];
}

export async function toolTurn(system, convo, tools) {
  if (gemini) {
    const r = await geminiGenerate({
      model: MODEL,
      contents: convo,
      config: {
        systemInstruction: system,
        temperature: 0,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      },
    });
    const content = r.candidates?.[0]?.content;
    if (content) convo.push(content);
    const calls = (r.functionCalls || []).map((c, i) => ({ id: c.id || `${c.name}_${i}`, name: c.name, args: c.args || {} }));
    return { text: calls.length ? "" : r.text || "", calls };
  }
  const r = await claude.beta.messages.create({
    model: MODEL, max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "medium" }, system, messages: convo,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(t.strict ? { strict: true } : {}) })),
  });
  if (r.stop_reason === "refusal") throw new Error("The model declined the request.");
  convo.push({ role: "assistant", content: r.content });
  return {
    text: r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
    calls: r.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input })),
  };
}

// results: [{call, output (object), isError}]
export function addToolResults(convo, results) {
  if (gemini) {
    convo.push({
      role: "user",
      parts: results.map(({ call, output, isError }) => ({
        functionResponse: { id: call.id, name: call.name, response: isError ? { error: String(output) } : { output } },
      })),
    });
  } else {
    convo.push({
      role: "user",
      content: results.map(({ call, output, isError }) => ({
        type: "tool_result", tool_use_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output), ...(isError ? { is_error: true } : {}),
      })),
    });
  }
}

export function nudge(convo, text) {
  convo.push(gemini ? { role: "user", parts: [{ text }] } : { role: "user", content: text });
}
