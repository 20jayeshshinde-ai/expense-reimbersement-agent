// Employee portal: submit receipts (Web or Chat mode), watch the agents, see the decision.
// Employees never see finance controls; approval happens in the separate Finance portal.
import { $, api, sid, inr, esc, sleep, toast, agentLight, loadConfig, lineCard, duplicatesHtml, localPreviews, CONFIG, LABEL, ICON } from "./common.js";

let mode = localStorage.mode === "chat" ? "chat" : "web";
let busy = false;
let current = null; // latest decision for this session
let elapsed = 0, claimNotes = {}, pollTimer = null;
let duplicates = []; // employee-only: receipts held back as duplicates

// =====================================================================
// Shared pipeline – used by both Web and Chat modes.
// hooks: onRead(names), onReadDone(report, claim), onBuilt(claim), onAuditEvent(e), onDecision(d), onError(msg)
// =====================================================================
async function runPipeline(files, demo, hooks) {
  if (busy) return toast("Still working on the previous batch…");
  busy = true;
  ["intake", "build", "audit"].forEach((a) => agentLight(a, null));
  try {
    const started = performance.now();
    agentLight("intake", "busy");
    hooks.onRead(demo ? ["9 sample receipts"] : files.map((f) => f.name));
    let data;
    try {
      if (demo) data = await api("/api/demo", { method: "POST" });
      else {
        const fd = new FormData();
        files.forEach((f) => fd.append("files", f));
        data = await api("/api/upload", { method: "POST", body: fd });
      }
    } catch {
      return hooks.onError("Could not reach the server. Is it still running?");
    }
    agentLight("intake", "done");
    if (!data.claim) return hooks.onError("Something went wrong reading the files.");
    hooks.onReadDone(data.report, data.claim);
    const c = data.claim;
    if (!c.totals.items && !c.totals.removed) return hooks.onError("No expenses could be read from these files. Try clearer photos or PDFs.");

    agentLight("build", "busy");
    await sleep(500);
    agentLight("build", "done");
    hooks.onBuilt(c);
    await sleep(600);

    agentLight("audit", "busy");
    const res = await streamAudit(hooks.onAuditEvent);
    agentLight("audit", "done");
    duplicates = res.duplicates || [];
    if (res.onlyDuplicates) return hooks.onOnlyDuplicates(duplicates);
    if (!res.decision) return hooks.onError(res.error || "Audit failed.");
    elapsed = (performance.now() - started) / 1000;
    claimNotes = Object.fromEntries(c.items.map((i) => [i.id, i.aiNotes]));
    current = res.decision;
    await sleep(400);
    hooks.onDecision(res.decision);
    watchStatus();
  } finally {
    busy = false;
  }
}

function streamAudit(onEvent) {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/submit/stream?sid=${encodeURIComponent(sid)}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "done" || e.type === "error") { es.close(); resolve(e); }
      else onEvent(e);
    };
    es.onerror = () => { es.close(); resolve({ error: "Lost connection to the audit agent. Restart the server (Ctrl+C, then npm start) and reload." }); };
  });
}

// Wait for the finance approver (in the other portal); poll until the decision lands.
function watchStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { decision, duplicates: dups } = await api("/api/claim/status");
    if (dups) duplicates = dups;
    if (decision && decision.status !== "pending_approval") {
      clearInterval(pollTimer);
      current = decision;
      if (mode === "web") renderStatus(decision);
      chatDecision(decision);
      toast(`Claim ${decision.claimId}: ${LABEL[decision.status]} by ${decision.approver}`);
    }
  }, 2000);
}

const TOOL_LABEL = {
  list_bills: "Listed bills", get_bill_details: "Read bill details", verify_gstin: "Verified GSTIN", check_arithmetic: "Checked arithmetic",
  check_metadata_tampering: "Checked for tampering", check_claim_history: "Searched claim history", check_policy: "Applied policy",
};

function eventHtml(e) {
  if (e.type === "agent") return [`🤖 <b>${esc(e.text)}</b>`, "agent"];
  if (e.type === "thought") return [`💭 ${esc(e.text)}`, "thought"];
  if (e.type === "tool") return [`<span class="dot ${e.status}"></span><b>${esc(TOOL_LABEL[e.tool] || e.tool)}</b>${e.vendor ? ` · ${esc(e.vendor)}` : ""} <span class="muted">${esc(e.detail || "")}</span>`, "tool"];
  if (e.type === "verdict") return [`${e.recommendation === "approve" ? "✅" : "⛔"} <b>${esc(e.vendor)}</b>: ${e.recommendation} <span class="risk ${e.risk}">${e.risk} risk</span> <span class="muted">${esc(e.reason)}</span>`, "verdict"];
  return null;
}
function appendEvent(log, e) {
  const h = eventHtml(e);
  if (!h) return;
  const row = document.createElement("div");
  row.className = `ev ${h[1]}`;
  row.innerHTML = h[0];
  log.append(row);
  log.scrollTop = 1e9;
}

// =====================================================================
// WEB MODE
// =====================================================================
const STEPS = ["upload", "read", "build", "verify", "decision"];
function setStep(step) {
  const idx = STEPS.indexOf(step);
  document.querySelectorAll("#stepper li").forEach((li, i) => {
    li.classList.toggle("done", i < idx || (step === "decision" && i === idx));
    li.classList.toggle("active", i === idx && step !== "decision");
  });
}
function showStage(name) {
  ["upload", "process", "decision"].forEach((s) => $(`#stage-${s}`).classList.toggle("hidden", s !== name));
}

const webHooks = {
  onRead(names) {
    showStage("process");
    setStep("read");
    $("#procTitle").textContent = "Intake Agent is reading your receipts…";
    $("#procSub").textContent = "Live AI · vision + PDF understanding · tamper inspection";
    $("#procFiles").innerHTML = names.map((n) => `<div class="pf"><span>⏳</span><span class="nm">${esc(n)}</span></div>`).join("");
  },
  onReadDone(report) {
    $("#procFiles").innerHTML = report.map((r) => `<div class="pf ${r.error ? "" : "done"}"><span>${r.error ? "⚠️" : "✅"}</span><span class="nm">${esc(r.file)}</span><span class="muted">${r.error ? "unreadable" : (r.ms / 1000).toFixed(1) + "s"}</span></div>`).join("");
  },
  onBuilt(c) {
    setStep("build");
    const trips = c.groups.filter((g) => g.kind === "trip").map((g) => g.title);
    $("#procTitle").textContent = "Claim built automatically";
    $("#procSub").textContent = `${c.totals.items} expenses · ${trips.length ? trips.join(", ") + " · " : ""}${c.totals.removed ? `${c.totals.removed} duplicate${c.totals.removed > 1 ? "s" : ""} held back · ` : ""}purpose and categories filled in by AI`;
    setTimeout(() => {
      setStep("verify");
      $("#procTitle").textContent = "Audit Agent is checking every bill…";
      $("#procSub").textContent = "GSTIN registry · arithmetic · tampering · claim history · policy";
      $("#procFiles").innerHTML = `<div class="agent-log" id="agentLog"></div>`;
    }, 550);
  },
  onAuditEvent(e) { const log = $("#agentLog"); if (log) appendEvent(log, e); },
  onDecision(d) { renderStatus(d); },
  onError(msg) { webFail(msg); },
  onOnlyDuplicates(dups) { renderOnlyDuplicates(dups); },
};

function webFail(msg) {
  showStage("decision");
  $("#stage-decision").innerHTML = `<div class="hero rejected"><div class="badge">⚠️</div><div><div class="amount" style="font-size:22px">${esc(msg)}</div></div><div></div></div>
    <div class="actions-row"><button class="btn primary" id="againBtn">Try again</button></div>`;
  $("#againBtn").onclick = reset;
}

// Every receipt was a duplicate: nothing is submitted, the employee sees why.
function renderOnlyDuplicates(dups) {
  showStage("decision");
  setStep("verify");
  $("#stage-decision").innerHTML = `
    <div class="hero dupe">
      <div class="badge">🔁</div>
      <div><div class="status">Nothing new to claim</div><div class="amount">${dups.length} duplicate${dups.length > 1 ? "s" : ""}</div>
        <div class="sub">These receipts match bills you've already claimed, so nothing was sent to finance.</div></div>
      <div class="meta">0 sent to finance</div>
    </div>
    ${duplicatesHtml(dups)}
    <div class="actions-row"><button class="btn primary" id="againBtn">Upload other receipts</button></div>`;
  $("#againBtn").onclick = reset;
}

function renderStatus(d) {
  showStage("decision");
  const pending = d.status === "pending_approval";
  setStep(pending ? "verify" : "decision");
  if (pending) document.querySelector('#stepper li[data-step="verify"]').classList.add("done");
  const ok = d.lines.filter((l) => (pending ? l.recommendation === "approve" : l.verdict === "approved"));
  const flagged = d.lines.filter((l) => (pending ? l.recommendation === "reject" : l.verdict === "rejected"));
  const amount = pending ? d.recommendedAmount : d.approvedAmount;
  const sub = pending
    ? `submitted · ${ok.length} of ${d.lines.length} bills verified by the Audit Agent · waiting for ${esc(d.approvalLevel.toLowerCase())}`
    : `decided by ${esc(d.approver)} · ${ok.length} of ${d.lines.length} bills approved${d.payout ? " · " + esc(d.payout) : ""}`;

  $("#stage-decision").innerHTML = `
    <div class="hero ${d.status}">
      <div class="badge">${ICON[d.status]}</div>
      <div>
        <div class="status">${LABEL[d.status]}</div>
        <div class="amount">${inr(amount)}</div>
        <div class="sub">${sub}</div>
        ${d.comment ? `<div class="sub">Approver note: ${esc(d.comment)}</div>` : ""}
      </div>
      <div class="meta"><b>${esc(d.claimId)}</b><br/>${elapsed ? `Receipts → submitted claim in ${elapsed.toFixed(1)}s<br/>` : ""}0 manual steps for you</div>
    </div>
    <div class="breakdown">
      <div class="kpi"><div class="l">Claimed</div><div class="v">${inr(d.claimedAmount)}</div></div>
      <div class="kpi ok"><div class="l">${pending ? "Expected payout" : "Approved"}</div><div class="v">${inr(amount)}</div></div>
      <div class="kpi warn"><div class="l">Policy deductions</div><div class="v">${inr(d.policyDeduction)}</div></div>
      <div class="kpi bad"><div class="l">${pending ? "Flagged bills" : "Rejected bills"}</div><div class="v">${inr(pending ? d.flaggedAmount : d.rejectedAmount)}</div></div>
    </div>
    ${pending ? `<div class="waiting"><div class="spinner"></div><div><b>With finance for approval.</b> You don't need to do anything. This page updates by itself when the approver decides.</div></div>` : ""}
    ${duplicatesHtml(duplicates)}
    ${flagged.length ? `<h3 class="sec">${pending ? "Flagged by Audit Agent" : "Rejected"} <small>${flagged.length} bill${flagged.length > 1 ? "s" : ""}</small></h3>${flagged.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}` : ""}
    <h3 class="sec">${pending ? "Verified by Audit Agent" : "Approved"} <small>${ok.length} bill${ok.length === 1 ? "" : "s"} · tap a bill for details</small></h3>
    ${ok.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}
    <div class="actions-row"><button class="btn primary" id="againBtn">Start a new claim</button><button class="btn" id="askChat">💬 Ask about this claim</button></div>`;
  $("#againBtn").onclick = reset;
  $("#askChat").onclick = () => setMode("chat");
}

// =====================================================================
// CHAT MODE
// =====================================================================
const chatHistory = [];
function bubble(role, html, cls = "") {
  const el = document.createElement("div");
  el.className = `msg ${role} ${cls}`;
  el.innerHTML = `<div class="av">${role === "user" ? "AV" : "🤖"}</div><div class="bubble">${html}</div>`;
  $("#chatMsgs").append(el);
  $("#chatMsgs").scrollTop = 1e9;
  return el;
}
function botSay(text, cls = "") {
  chatHistory.push({ role: "assistant", text });
  return bubble("bot", esc(text), cls);
}
function setChips(list) {
  $("#chatChips").innerHTML = list.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join("");
  $("#chatChips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => chipAction(b.textContent)));
}
function chipAction(text) {
  if (text.startsWith("✨")) return chatUpload([], true);
  if (text.startsWith("📎")) return $("#chatFile").click();
  if (text.startsWith("🖥️")) return setMode("web");
  sendChat(text);
}
function defaultChips() {
  if (!current) return setChips(["✨ Try 9 sample receipts", "📎 Attach receipts", "What's the policy?", "What can you do?"]);
  setChips(["What's my claim status?", "Why were bills flagged?", "Explain the deductions", "Show my duplicate tickets", "🖥️ Show full report"]);
}
function chatWelcome() {
  if ($("#chatMsgs").children.length) return;
  botSay("Hi Asha 👋 I'm ClaimPilot. Send me your receipts (photos or PDFs) with 📎 or drag them in. My agents read every bill, build your claim, check each one, and send it to finance. You don't need to type anything.");
  defaultChips();
}

async function chatUpload(files, demo = false) {
  let progress, log;
  await runPipeline(files, demo, {
    onRead(names) {
      bubble("user", demo ? "Use the 9 sample receipts" : `Sent ${names.length} receipt${names.length > 1 ? "s" : ""}<div class="files">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</div>`);
      progress = bubble("bot", "📥 Intake Agent is reading your receipts…", "typing");
      setChips([]);
    },
    onReadDone(report, c) {
      const errs = report.filter((r) => r.error);
      progress.classList.remove("typing");
      progress.querySelector(".bubble").innerHTML = `📥 Read <b>${c.totals.receipts}</b> receipt${c.totals.receipts === 1 ? "" : "s"}${errs.length ? ` (${errs.length} unreadable)` : ""}.`;
    },
    onBuilt(c) {
      const trips = c.groups.filter((g) => g.kind === "trip").map((g) => g.title);
      const removed = c.items.filter((i) => i.excluded);
      botSay(`🧩 Claim built: ${c.totals.items} expenses${trips.length ? ` · ${trips.join(", ")}` : ""}${removed.length ? ` · held back ${removed.length} duplicate${removed.length > 1 ? "s" : ""} (${removed.map((r) => r.vendor).join(", ")})` : ""}. Purpose, categories and GL codes filled in automatically.`);
      log = bubble("bot", `🛡️ <b>Audit Agent is checking every bill…</b><div class="mini-log"></div>`, "wide").querySelector(".mini-log");
    },
    onAuditEvent(e) { if (log) appendEvent(log, e); },
    onDecision(d) { chatDecision(d); },
    onError(msg) { if (progress) progress.classList.remove("typing"); botSay(`⚠️ ${msg}`); defaultChips(); },
    onOnlyDuplicates(dups) {
      bubble("bot", `<div class="result-card"><div class="rc-top"><div>🔁 <b>Nothing new to claim</b><div class="muted" style="font-size:12.5px">All ${dups.length} receipt${dups.length > 1 ? "s" : ""} match bills you already claimed. Nothing was sent to finance.</div></div></div>${chatDupList(dups)}</div>`, "wide");
      defaultChips();
    },
  });
}

function chatDecision(d) {
  if (!d) return;
  const pending = d.status === "pending_approval";
  const amount = pending ? d.recommendedAmount : d.approvedAmount;
  const rows = d.lines.map((l) => {
    const bad = pending ? l.recommendation === "reject" : l.verdict === "rejected";
    const why = bad ? (l.checks.find((c) => c.status === "fail")?.name || "flagged") : l.adjustments?.length ? `−${inr(l.adjustments.reduce((s, a) => s + a.amount, 0))} policy` : "";
    return `<li class="${bad ? "bad" : ""}"><span>${bad ? "⛔" : "✅"} ${esc(l.vendor)} <small>${esc(why)}</small></span><b>${inr(pending ? l.recommendedInr : l.approvedInr)}</b></li>`;
  }).join("");
  const head = pending
    ? `<div>⏳ <b>Submitted to finance</b><div class="muted" style="font-size:12.5px">Claim ${esc(d.claimId)} · a finance approver will decide. I'll tell you here when they do.</div></div>`
    : `<div>${ICON[d.status]} <b>${LABEL[d.status]} by ${esc(d.approver)}</b><div class="muted" style="font-size:12.5px">Claim ${esc(d.claimId)}${d.payout ? " · " + esc(d.payout) : ""}${d.comment ? ` · “${esc(d.comment)}”` : ""}</div></div>`;
  bubble("bot", `<div class="result-card">
      <div class="rc-top">${head}<div class="rc-amt">${inr(amount)}</div></div>
      <ul>${rows}</ul>
      ${chatDupList(duplicates)}
      <div class="rc-actions"><button class="btn" data-act="web">🖥️ Full report</button>${pending ? "" : `<button class="btn" data-act="new">➕ New claim</button>`}</div>
    </div>`, "wide").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (b.dataset.act === "web" ? setMode("web") : reset())));
  chatHistory.push({ role: "assistant", text: `Claim ${d.claimId} ${LABEL[d.status]}: ${inr(amount)}.` });
  defaultChips();
}

function chatDupList(dups) {
  if (!dups?.length) return "";
  return `<div class="dup-mini"><b>🔁 Duplicate tickets (not sent to finance)</b><ul>${dups.map((d) =>
    `<li><span>${esc(d.vendor)} · ${esc(d.date || "")}${d.time ? " " + esc(d.time) : ""} <small>${esc(d.file)} – ${esc(d.kind === "already_claimed" ? "already claimed in " + (d.original?.where || "an earlier claim") : "same as " + (d.original?.file || "another upload"))}</small></span><b>${inr(0)}</b></li>`).join("")}</ul></div>`;
}

async function sendChat(text) {
  bubble("user", esc(text));
  chatHistory.push({ role: "user", text });
  const t = bubble("bot", "Thinking…", "typing");
  agentLight("chat", "busy");
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text, history: chatHistory.slice(-10, -1) }) });
    t.remove();
    botSay(res.reply || res.error || "Sorry, I couldn't answer that.");
  } catch {
    t.remove();
    botSay("⚠️ I couldn't reach the server.");
  }
  agentLight("chat", "done");
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chatInput").value.trim();
  if (!text) return;
  $("#chatInput").value = "";
  sendChat(text);
});

// =====================================================================
// mode toggle, wiring
// =====================================================================
function setMode(m) {
  mode = m;
  localStorage.mode = m;
  document.querySelectorAll("#modeSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#mode-web").classList.toggle("hidden", m !== "web");
  $("#mode-chat").classList.toggle("hidden", m !== "chat");
  if (m === "chat") { chatWelcome(); $("#chatInput").focus(); }
  if (m === "web" && current && !busy) renderStatus(current);
}

async function reset() {
  clearInterval(pollTimer);
  await api("/api/claim/reset", { method: "POST" });
  Object.values(localPreviews).forEach(URL.revokeObjectURL);
  for (const k of Object.keys(localPreviews)) delete localPreviews[k];
  current = null;
  duplicates = [];
  ["intake", "build", "audit", "chat"].forEach((a) => agentLight(a, null));
  setStep("upload");
  showStage("upload");
  if (mode === "chat") { botSay("Starting a fresh claim. Send me your receipts whenever you're ready 📎"); defaultChips(); }
}

function accept(fileList) {
  const files = [...fileList].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
  if (!files.length) return toast("Only images and PDFs are supported.");
  files.forEach((f) => (localPreviews[f.name] = URL.createObjectURL(f)));
  if (mode === "chat") chatUpload(files);
  else runPipeline(files, false, webHooks);
}

function dropTarget(el) {
  ["dragenter", "dragover"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || !el.contains(e.relatedTarget)) el.classList.remove("dragging"); }));
  el.addEventListener("drop", (e) => accept(e.dataTransfer.files));
}

$("#fileInput").onchange = (e) => { accept(e.target.files); e.target.value = ""; };
$("#chatFile").onchange = (e) => { accept(e.target.files); e.target.value = ""; };
dropTarget($("#dropzone"));
dropTarget($("#chatDrop"));
document.addEventListener("paste", (e) => e.clipboardData?.files?.length && accept(e.clipboardData.files));
$("#demoBtn").onclick = () => runPipeline([], true, webHooks);
document.querySelectorAll("#modeSwitch button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

(async () => {
  await loadConfig();
  setStep("upload");
  setMode(mode);
  // Resume a claim already submitted in this tab (e.g. after a page reload).
  const { decision, duplicates: dups } = await api("/api/claim/status");
  duplicates = dups || [];
  if (decision) {
    current = decision;
    if (mode === "web") renderStatus(decision); else chatDecision(decision);
    if (decision.status === "pending_approval") watchStatus();
  }
})();
