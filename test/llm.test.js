// Provider-layer tests with a fake Gemini / Claude client – no network, no API key.
import { receipt } from "./helpers.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as llm from "../src/llm.js";
import { makeTools, runAudit } from "../src/auditAgent.js";
import { createClaim, addExtraction, evaluate, buildSubmission } from "../src/claim.js";
import { chat } from "../src/chatAgent.js";
import { resetFinance } from "../src/mockFinance.js";
import { extraction } from "./helpers.js";

afterEach(() => { llm.useClientForTests(); resetFinance(); });

// Fake Gemini client: returns scripted responses, records every request.
function fakeGemini(responses) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(req) : next;
      },
    },
  };
}
const geminiError = (status, message = "err") => Object.assign(new Error(message), { status });

describe("extractJson (Gemini)", () => {
  test("sends the document inline with the JSON schema and parses the reply", async () => {
    const g = fakeGemini([{ text: JSON.stringify({ expenses: [{ vendor: "X" }] }) }]);
    llm.useClientForTests({ gemini: g });
    const out = await llm.extractJson({ data: Buffer.from("img"), mediaType: "image/png" }, "sys", "extract", { type: "object" });
    assert.deepEqual(out, { expenses: [{ vendor: "X" }] });
    const req = g.calls[0];
    assert.equal(req.config.responseMimeType, "application/json");
    assert.equal(req.contents[0].parts[0].inlineData.mimeType, "image/png");
  });

  test("on a rate limit (429) it switches to another model in the pool", async () => {
    const g = fakeGemini([geminiError(429, "quota, retry in 30s"), { text: '{"ok":true}' }]);
    llm.useClientForTests({ gemini: g });
    const out = await llm.extractJson({ data: Buffer.from("x"), mediaType: "image/jpeg" }, "s", "p", {});
    assert.deepEqual(out, { ok: true });
    assert.notEqual(g.calls[0].model, g.calls[1].model);
    assert.equal(llm.lastModelUsed.name, g.calls[1].model);
  });

  test("non-retryable errors are thrown to the caller", async () => {
    llm.useClientForTests({ gemini: fakeGemini([geminiError(400, "bad request")]) });
    await assert.rejects(llm.extractJson({ data: Buffer.from("x"), mediaType: "image/jpeg" }, "s", "p", {}), /bad request/);
  });

  test("an empty / blocked reply is an error", async () => {
    llm.useClientForTests({ gemini: fakeGemini([{ text: "", candidates: [{ finishReason: "SAFETY" }] }]) });
    await assert.rejects(llm.extractJson({ data: Buffer.from("x"), mediaType: "image/jpeg" }, "s", "p", {}), /SAFETY/);
  });
});

describe("checkAI", () => {
  test("a busy model at startup still counts as connected", async () => {
    llm.useClientForTests({ gemini: fakeGemini([geminiError(503, "high demand")]) });
    llm.status.state = "checking";
    assert.equal((await llm.checkAI()).state, "ok");
  });
  test("a rejected key is reported as an error", async () => {
    llm.useClientForTests({ gemini: fakeGemini([geminiError(403, "API key not valid")]) });
    const s = await llm.checkAI();
    assert.equal(s.state, "error");
    assert.match(s.detail, /key rejected/);
  });
});

describe("function-calling loop helpers (Gemini format)", () => {
  test("toolTurn returns calls; addToolResults appends functionResponse parts", async () => {
    const g = fakeGemini([{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "list_bills", args: {} } }] } }], functionCalls: [{ name: "list_bills", args: {} }] }]);
    llm.useClientForTests({ gemini: g });
    const convo = llm.newConversation("audit");
    const turn = await llm.toolTurn("sys", convo, [{ name: "list_bills", description: "d", parameters: { type: "object", properties: {} } }]);
    assert.equal(turn.calls[0].name, "list_bills");
    assert.equal(g.calls[0].config.tools[0].functionDeclarations[0].name, "list_bills");
    llm.addToolResults(convo, [{ call: turn.calls[0], output: { bills: [] } }]);
    assert.equal(convo.at(-1).parts[0].functionResponse.name, "list_bills");
    llm.nudge(convo, "continue");
    assert.equal(convo.at(-1).parts[0].text, "continue");
  });
});

describe("Audit Agent with a scripted AI model", () => {
  test("runs tools the model asks for, records its verdict and summary", async () => {
    const c = createClaim();
    addExtraction(c, "a.jpg", extraction(receipt(), "h"));
    evaluate(c);
    const sub = buildSubmission(c);
    const id = sub.lines[0].itemId;
    const call = (name, args) => ({ functionCall: { name, args } });
    const reply = (parts) => ({ candidates: [{ content: { role: "model", parts } }], functionCalls: parts.map((p) => p.functionCall) });
    llm.useClientForTests({
      gemini: fakeGemini([
        reply([call("list_bills", {})]),
        reply([call("verify_gstin", { item_id: id }), call("check_arithmetic", { item_id: id })]),
        reply([call("record_verdict", { item_id: id, recommendation: "approve", risk: "low", reason: "All good" }), call("finish_review", { summary: "1 bill verified." })]),
      ]),
    });
    const events = [];
    const d = await runAudit(sub, {}, (e) => events.push(e));
    assert.equal(d.agent, "Audit Agent (Live AI)");
    assert.equal(d.agentSummary, "1 bill verified.");
    assert.equal(d.lines[0].agentReason, "All good");
    assert.deepEqual(events.filter((e) => e.type === "tool").map((e) => e.tool), ["list_bills", "verify_gstin", "check_arithmetic"]);
  });

  test("falls back to the offline agent if the AI call fails", async () => {
    const c = createClaim();
    addExtraction(c, "a.jpg", extraction(receipt(), "h"));
    evaluate(c);
    llm.useClientForTests({ gemini: fakeGemini([geminiError(400, "boom")]) });
    const d = await runAudit(buildSubmission(c), {});
    assert.equal(d.agent, "Audit Agent (Offline AI)");
    assert.equal(d.lines[0].recommendation, "approve");
  });

  test("tools expose evidence the model can reason about", () => {
    const c = createClaim();
    addExtraction(c, "a.jpg", extraction(receipt(), "h"));
    evaluate(c);
    const tools = makeTools(buildSubmission(c).lines, {});
    const id = Object.keys(tools.list_bills().bills.reduce((m, b) => ({ ...m, [b.item_id]: 1 }), {}))[0];
    assert.equal(tools.get_bill_details({ item_id: id }).vendor, "Spice Route");
  });
});

describe("Chat assistant with a scripted AI model", () => {
  test("passes the claim data and returns the model's answer", async () => {
    const g = fakeGemini([{ text: "Your claim is with finance." }]);
    llm.useClientForTests({ gemini: g });
    const r = await chat("status?", [{ role: "assistant", text: "Hi" }], evaluate(createClaim()));
    assert.equal(r.reply, "Your claim is with finance.");
    assert.equal(r.engine, "Gemini");
    assert.equal(g.calls[0].contents.at(-1).role, "user");
    assert.match(g.calls[0].contents.at(-1).parts[0].text, /Current claim data/);
  });
  test("falls back to offline answers if the model errors", async () => {
    llm.useClientForTests({ gemini: fakeGemini([geminiError(400, "bad request")]) });
    const r = await chat("what can you do?", [], evaluate(createClaim()));
    assert.equal(r.engine, "offline");
  });
});
