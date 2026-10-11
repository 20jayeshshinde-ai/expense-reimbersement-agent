const $ = (s) => document.querySelector(s);
const sid = sessionStorage.sid || (sessionStorage.sid = crypto.randomUUID());
const inr = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER_VERSION = 4;
let CONFIG = { categories: {}, status: {} };
let localPreviews = {}; // file name -> object URL, for receipt thumbnails
let mode = localStorage.mode === "chat" ? "chat" : "web";
let busy = false;
let current = null; // latest decision for this session
let elapsed = 0, claimNotes = {}, pollTimer = null;

async function api(path, opts = {}) {
  const headers = { "x-session": sid };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  return res.json();
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// Sidebar agent status lights.
function agent(id, state) {
  const el = $(`#ag-${id}`);
  if (!el) return;
  el.classList.toggle("busy", state === "busy");
  el.classList.toggle("done", state === "done");
}

// =====================================================================
// Shared pipeline – used by both Web and Chat modes.
// hooks: onRead(names), onReadDone(report, claim), onBuilt(claim), onAuditEvent(e), onDecision(d), onError(msg)
// =====================================================================
async function runPipeline(files, demo, hooks) {
  if (busy) return toast("Still working on the previous batch…");
  busy = true;
  ["intake", "build", "audit"].forEach((a) => agent(a, null));
  try {
    const started = performance.now();
    agent("intake", "busy");
    hooks.onRead(demo ? ["8 sample receipts"] : files.map((f) => f.name));
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
    agent("intake", "done");
    if (!data.claim) return hooks.onError("Something went wrong reading the files.");
    hooks.onReadDone(data.report, data.claim);
    const c = data.claim;
    if (!c.totals.items) return hooks.onError("No expenses could be read from these files. Try clearer photos or PDFs.");

    agent("build", "busy");
    await sleep(500);
    agent("build", "done");
    hooks.onBuilt(c);
    await sleep(600);

    agent("audit", "busy");
    const res = await streamAudit(hooks.onAuditEvent);
    agent("audit", "done");
    if (!res.decision) return hooks.onError(res.error || "Audit failed.");
    elapsed = (performance.now() - started) / 1000;
    claimNotes = Object.fromEntries(c.items.map((i) => [i.id, i.aiNotes]));
    current = res.decision;
    await sleep(400);
    hooks.onDecision(res.decision);
    refreshPendingBadge();
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

// The employee waits for the human approver; poll until the decision lands.
function watchStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { decision } = await api("/api/claim/status");
    if (decision && decision.status !== "pending_approval") {
      clearInterval(pollTimer);
      current = decision;
      refreshPendingBadge();
      if (!$("#mode-web").classList.contains("hidden") || mode === "web") renderEmployeeStatus(decision);
      chatDecision(decision);
      toast(`Claim ${decision.claimId}: ${LABEL[decision.status]} by ${decision.approver}`);
    }
  }, 2000);
}

const TOOL_LABEL = {
  list_bills: "Listed bills", get_bill_details: "Read bill details", verify_gstin: "Verified GSTIN", check_arithmetic: "Checked arithmetic",
  check_metadata_tampering: "Checked for tampering", check_claim_history: "Searched claim history", check_policy: "Applied policy",
};
const LABEL = { pending_approval: "Awaiting finance approval", approved: "Approved", partially_approved: "Approved (partially)", rejected: "Rejected" };
const ICON = { pending_approval: "⏳", approved: "✅", partially_approved: "✅", rejected: "⛔" };

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
    $("#procSub").textContent = CONFIG.live ? `Claude ${CONFIG.status.model} · vision + PDF understanding · tamper inspection` : "Local AI · neural OCR + receipt parser";
    $("#procFiles").innerHTML = names.map((n) => `<div class="pf"><span>⏳</span><span class="nm">${esc(n)}</span></div>`).join("");
  },
  onReadDone(report) {
    $("#procFiles").innerHTML = report.map((r) => `<div class="pf ${r.error ? "" : "done"}"><span>${r.error ? "⚠️" : "✅"}</span><span class="nm">${esc(r.file)}</span><span class="muted">${r.error ? "unreadable" : (r.ms / 1000).toFixed(1) + "s"}</span></div>`).join("");
  },
  onBuilt(c) {
    setStep("build");
    const trips = c.groups.filter((g) => g.kind === "trip").map((g) => g.title);
    $("#procTitle").textContent = "Claim built automatically";
    $("#procSub").textContent = `${c.totals.items} expenses · ${trips.length ? trips.join(", ") + " · " : ""}${c.totals.removed ? `${c.totals.removed} duplicate removed · ` : ""}purpose and categories filled in by AI`;
    setTimeout(() => {
      setStep("verify");
      $("#procTitle").textContent = "Audit Agent is investigating every bill…";
      $("#procSub").textContent = "It picks its own checks: GSTIN registry · arithmetic · tampering · claim history · policy";
      $("#procFiles").innerHTML = `<div class="agent-log" id="agentLog"></div>`;
    }, 550);
  },
  onAuditEvent(e) { const log = $("#agentLog"); if (log) appendEvent(log, e); },
  onDecision(d) { renderEmployeeStatus(d); },
  onError(msg) { webFail(msg); },
};

function webFail(msg) {
  showStage("decision");
  $("#stage-decision").innerHTML = `<div class="hero rejected"><div class="badge">⚠️</div><div><div class="amount" style="font-size:22px">${esc(msg)}</div></div><div></div></div>
    <div class="actions-row"><button class="btn primary" id="againBtn">Try again</button></div>`;
  $("#againBtn").onclick = reset;
}

function renderEmployeeStatus(d) {
  showStage("decision");
  const pending = d.status === "pending_approval";
  setStep(pending ? "verify" : "decision");
  if (pending) document.querySelector('#stepper li[data-step="verify"]').classList.add("done");
  const ok = d.lines.filter((l) => (pending ? l.recommendation === "approve" : l.verdict === "approved"));
  const flagged = d.lines.filter((l) => (pending ? l.recommendation === "reject" : l.verdict === "rejected"));
  const amount = pending ? d.recommendedAmount : d.approvedAmount;
  const sub = pending
    ? `recommended by the Audit Agent · ${ok.length} of ${d.lines.length} bills verified · waiting for ${esc(d.approvalLevel)}`
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
      <div class="meta"><b>${esc(d.claimId)}</b><br/>${esc(d.employee.name)}<br/>Receipts → verified claim in ${elapsed.toFixed(1)}s<br/>0 manual steps for you</div>
    </div>
    <div class="breakdown">
      <div class="kpi"><div class="l">Claimed</div><div class="v">${inr(d.claimedAmount)}</div></div>
      <div class="kpi ok"><div class="l">${pending ? "Recommended" : "Approved"}</div><div class="v">${inr(amount)}</div></div>
      <div class="kpi warn"><div class="l">Policy deductions</div><div class="v">${inr(d.policyDeduction)}</div></div>
      <div class="kpi bad"><div class="l">${pending ? "Flagged by AI" : "Rejected bills"}</div><div class="v">${inr(pending ? d.flaggedAmount : d.rejectedAmount)}</div></div>
    </div>
    ${d.agentSummary ? `<div class="agent-summary">🤖 <b>${esc(d.agent)}:</b> ${esc(d.agentSummary)}</div>` : ""}
    ${pending ? `<div class="waiting"><div class="spinner"></div><div>Your claim is in the finance approval queue. This page updates automatically when an approver decides.<br/><button class="link" id="toFinance">Open the Finance desk to approve (demo)</button></div></div>` : ""}
    ${flagged.length ? `<h3 class="sec">${pending ? "Flagged by Audit Agent" : "Rejected"} <small>${flagged.length} bill${flagged.length > 1 ? "s" : ""}</small></h3>${flagged.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}` : ""}
    <h3 class="sec">${pending ? "Verified by Audit Agent" : "Approved"} <small>${ok.length} bill${ok.length === 1 ? "" : "s"} · tap a bill to see the evidence</small></h3>
    ${ok.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}
    ${d.removed.length ? `<h3 class="sec">Removed automatically <small>not sent to finance</small></h3>${d.removed.map((r) => `<div class="removed">🔁 ${esc(r.vendor)} · ${esc(r.file)} – ${esc(r.reason)}</div>`).join("")}` : ""}
    <div class="actions-row"><button class="btn primary" id="againBtn">Start a new claim</button><button class="btn" id="askChat">💬 Ask about this claim</button></div>`;
  $("#againBtn").onclick = reset;
  $("#askChat").onclick = () => setMode("chat");
  $("#toFinance")?.addEventListener("click", () => switchView("finance", d.claimId));
}

function lineBadge(l) {
  if (l.verdict) return `<span class="verdict ${l.verdict}">${l.verdict === "approved" ? "APPROVED" : "REJECTED"}${l.overridden ? " · override" : ""}</span>`;
  return `<span class="verdict rec-${l.recommendation}">AI: ${l.recommendation === "approve" ? "VERIFIED" : "FLAGGED"}</span>`;
}

function lineCard(l, aiNotes = [], controls = "") {
  const cat = CONFIG.categories[l.category] || { icon: "🧾", label: l.categoryLabel };
  const fails = l.checks.filter((c) => c.status === "fail");
  const src = localPreviews[l.receiptFile] || (/^\d\d_/.test(l.receiptFile) ? `/samples/${encodeURIComponent(l.receiptFile)}` : null);
  const isPdf = /\.pdf$/i.test(l.receiptFile);
  const shown = l.verdict ? l.approvedInr : l.recommendedInr;
  const state = l.verdict || (l.recommendation === "approve" ? "approved" : "rejected");
  return `<details class="line ${state}">
    <summary>
      <div class="ic">${cat.icon}</div>
      <div><div class="v">${esc(l.vendor || "Unknown vendor")}</div><div class="m">${esc(l.date || "no date")} · ${esc(cat.label)} · ${esc(l.description)}</div></div>
      <div class="amt">${inr(shown)}${shown !== l.amountInr ? `<s>${inr(l.amountInr)}</s>` : ""}</div>
      ${controls || lineBadge(l)}
      ${fails.length ? `<div class="reason">⛔ ${fails.map((f) => `${esc(f.name)}: ${esc(f.detail)}`).join(" · ")}</div>` : ""}
      ${l.agentReason ? `<div class="why">🤖 ${esc(l.agentReason)}${l.risk ? ` <span class="risk ${l.risk}">${l.risk} risk</span>` : ""}</div>` : ""}
      ${!fails.length && l.adjustments.length ? `<div class="adj">📏 ${l.adjustments.map((a) => `${esc(a.text)} (−${inr(a.amount)})`).join(" · ")}</div>` : ""}
    </summary>
    <div class="audit">
      <div class="checks"><b style="font-size:13px">Audit Agent evidence · authenticity ${l.authenticityScore}/100</b>
        ${l.checks.map((c) => `<div class="chk ${c.status}"><span>${c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌"}</span><span class="n">${esc(c.name)}</span><span class="d">${esc(c.detail)}</span></div>`).join("")}
      </div>
      <div class="fields"><b style="grid-column:1/3;font-size:13px">Read by ${esc(l.extractedBy)}</b>
        <span>Vendor</span><span>${esc(l.vendor)}</span><span>Date</span><span>${esc(l.date || "—")}</span>
        <span>Amount</span><span>${esc(l.currency)} ${l.amount ?? "—"}</span><span>Tax</span><span>${l.tax ?? "—"}</span>
        <span>Invoice #</span><span>${esc(l.invoiceNumber || "—")}</span><span>GSTIN</span><span>${esc(l.gstin || "—")}</span>
        <span>Payment</span><span>${esc(l.paymentMethod)}</span><span>City</span><span>${esc(l.city || "—")}</span>
        <span>Purpose</span><span>${esc(l.purpose)} <i class="muted">(AI)</i></span>
        ${l.attendees ? `<span>Attendees</span><span>${l.attendees}</span>` : ""}
        <span>GL code</span><span>${esc(l.glCode)}</span>
        ${aiNotes.length ? `<span>AI notes</span><span>${aiNotes.map(esc).join("<br/>")}</span>` : ""}
        ${src && !isPdf ? `<img class="receipt-thumb" src="${src}" alt="receipt" loading="lazy"/>` : src ? `<a href="${src}" target="_blank" style="grid-column:1/3">Open receipt PDF</a>` : ""}
      </div>
    </div>
  </details>`;
}

// =====================================================================
// CHAT MODE
// =====================================================================
const chatHistory = []; // {role, text} for the assistant's context
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
  if (text.startsWith("🏦")) return switchView("finance", current?.claimId);
  if (text.startsWith("🖥️")) return setMode("web");
  sendChat(text);
}
function defaultChips() {
  if (!current) return setChips(["✨ Try 8 sample receipts", "📎 Attach receipts", "What's the policy?", "What can you do?"]);
  const chips = ["What's my claim status?", "Why were bills flagged?", "Explain the deductions", "Were any duplicates removed?"];
  if (current.status === "pending_approval") chips.push("🏦 Open finance desk");
  chips.push("🖥️ Show full report");
  setChips(chips);
}

function chatWelcome() {
  if ($("#chatMsgs").children.length) return;
  botSay("Hi Asha 👋 I'm ClaimPilot. Send me your receipts (photos or PDFs) with 📎 or drag them in. My agents will read every bill, build your claim, check each one for authenticity, and send it to finance for approval. You don't need to type anything.");
  defaultChips();
}

async function chatUpload(files, demo = false) {
  let progress, log;
  const hooks = {
    onRead(names) {
      bubble("user", demo ? "Use the 8 sample receipts" : `Sent ${names.length} receipt${names.length > 1 ? "s" : ""}<div class="files">${names.map((n) => `<span>${esc(n)}</span>`).join("")}</div>`);
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
      botSay(`🧩 Claim built: ${c.totals.items} expenses${trips.length ? ` · ${trips.join(", ")}` : ""}${removed.length ? ` · removed ${removed.length} duplicate (${removed.map((r) => r.vendor).join(", ")})` : ""}. Purpose, categories and GL codes filled in automatically.`);
      const wrap = bubble("bot", `🛡️ <b>Audit Agent is investigating every bill…</b><div class="mini-log" id="chatLog"></div>`, "wide");
      log = wrap.querySelector("#chatLog");
      log.id = "";
    },
    onAuditEvent(e) { if (log) appendEvent(log, e); },
    onDecision(d) { chatDecision(d); },
    onError(msg) { if (progress) progress.classList.remove("typing"); botSay(`⚠️ ${msg}`); defaultChips(); },
  };
  await runPipeline(files, demo, hooks);
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
    ? `<div>⏳ <b>Sent to finance for approval</b><div class="muted" style="font-size:12.5px">Claim ${esc(d.claimId)} · recommended by the Audit Agent · a human approver decides</div></div>`
    : `<div>${ICON[d.status]} <b>${LABEL[d.status]} by ${esc(d.approver)}</b><div class="muted" style="font-size:12.5px">Claim ${esc(d.claimId)}${d.payout ? " · " + esc(d.payout) : ""}${d.comment ? ` · “${esc(d.comment)}”` : ""}</div></div>`;
  bubble("bot", `<div class="result-card">
      <div class="rc-top">${head}<div class="rc-amt">${inr(amount)}</div></div>
      ${d.agentSummary && pending ? `<div class="agent-summary" style="margin:10px 0 4px;font-size:13px">🤖 ${esc(d.agentSummary)}</div>` : ""}
      <ul>${rows}</ul>
      <div class="rc-actions">
        <button class="btn" data-act="web">🖥️ Full report</button>
        ${pending ? `<button class="btn primary" data-act="fin">🏦 Approve in finance desk</button>` : `<button class="btn" data-act="new">➕ New claim</button>`}
      </div></div>`, "wide").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
    if (b.dataset.act === "web") setMode("web");
    else if (b.dataset.act === "fin") switchView("finance", d.claimId);
    else reset();
  }));
  chatHistory.push({ role: "assistant", text: `Claim ${d.claimId} ${LABEL[d.status]}: ${inr(amount)}.` });
  defaultChips();
}

async function sendChat(text) {
  bubble("user", esc(text));
  chatHistory.push({ role: "user", text });
  const t = bubble("bot", "Thinking…", "typing");
  agent("chat", "busy");
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text, history: chatHistory.slice(-10, -1) }) });
    t.remove();
    botSay(res.reply || res.error || "Sorry, I couldn't answer that.");
  } catch {
    t.remove();
    botSay("⚠️ I couldn't reach the server.");
  }
  agent("chat", "done");
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chatInput").value.trim();
  if (!text) return;
  $("#chatInput").value = "";
  sendChat(text);
});

// =====================================================================
// FINANCE DESK (human approver)
// =====================================================================
let finList = [];
async function refreshPendingBadge() {
  const list = await api("/api/finance/claims");
  const n = list.filter((c) => c.status === "pending_approval").length;
  $("#pendingBadge").textContent = n;
  $("#pendingBadge").classList.toggle("hidden", !n);
  return list;
}

async function renderFinance(focusId) {
  finList = await refreshPendingBadge();
  const reviewed = finList.filter((c) => c.decision);
  const pending = reviewed.filter((c) => c.status === "pending_approval");
  const decided = reviewed.filter((c) => c.status !== "pending_approval");
  const sum = (arr, f) => arr.reduce((s, c) => s + f(c), 0);
  $("#finKpis").innerHTML = `
    <div class="kpi warn"><div class="l">Awaiting your approval</div><div class="v">${pending.length}</div></div>
    <div class="kpi"><div class="l">Pending value (AI-recommended)</div><div class="v">${inr(sum(pending, (c) => c.decision.recommendedAmount))}</div></div>
    <div class="kpi ok"><div class="l">Approved by finance</div><div class="v">${inr(sum(decided, (c) => c.decision.approvedAmount))}</div></div>
    <div class="kpi bad"><div class="l">Flagged by Audit Agent</div><div class="v">${inr(sum(reviewed, (c) => c.decision.flaggedAmount))}</div></div>`;
  $("#finRows").innerHTML = finList.map((c) => `<tr class="${c.decision ? "clickable" : ""}" data-id="${esc(c.claimId)}">
    <td><b>${esc(c.claimId)}</b></td><td>${esc(c.employee)}</td><td>${new Date(c.submittedAt).toLocaleString()}</td>
    <td>${c.lines}${c.decision?.flaggedCount ? ` <span class="st-badge rejected">${c.decision.flaggedCount} flagged</span>` : ""}</td><td>${inr(c.amount)}</td>
    <td><span class="st-badge ${c.status}">${esc(c.status.replaceAll("_", " "))}</span></td></tr>`).join("");
  document.querySelectorAll("#finRows tr.clickable").forEach((tr) => (tr.onclick = () => showFinDetail(tr.dataset.id)));
  const focus = finList.find((c) => c.claimId === focusId && c.decision) || pending[0] || decided[0];
  if (focus) showFinDetail(focus.claimId); else $("#finDetail").innerHTML = "";
}

function showFinDetail(claimId) {
  const c = finList.find((x) => x.claimId === claimId);
  const d = c.decision;
  document.querySelectorAll("#finRows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === claimId));
  if (d.status !== "pending_approval") {
    $("#finDetail").innerHTML = `<h3 class="sec">${esc(c.claimId)} · ${esc(LABEL[d.status])} by ${esc(d.approver)} <small>${new Date(d.decidedAt).toLocaleString()}${d.overrides ? ` · ${d.overrides} AI recommendation${d.overrides > 1 ? "s" : ""} overridden` : ""}</small></h3>
      ${d.comment ? `<div class="removed">💬 ${esc(d.comment)}</div>` : ""}${d.lines.map((l) => lineCard(l)).join("")}`;
    return;
  }
  const toggle = (l) => `<span class="seg" data-item="${esc(l.itemId)}">
      <button type="button" data-v="approve" class="${l.recommendation === "approve" ? "on" : ""}">Approve</button>
      <button type="button" data-v="reject" class="${l.recommendation === "reject" ? "on" : ""}">Reject</button></span>`;
  $("#finDetail").innerHTML = `
    <div class="approval card">
      <div class="ap-head">
        <div style="flex:1;min-width:280px"><div class="label">Claim ${esc(c.claimId)} · ${esc(c.employee)}</div>
          <div class="ap-amt" id="apAmt">${inr(d.recommendedAmount)}</div>
          <div class="muted">${esc(d.agent)} recommends <b>${esc(d.agentRecommendation.replace("_", " "))}</b> · ${d.lines.length - d.flaggedCount} verified, ${d.flaggedCount} flagged · requires ${esc(d.approvalLevel)}</div>
          ${d.agentSummary ? `<div class="agent-summary" style="margin-top:10px">🤖 ${esc(d.agentSummary)}</div>` : ""}</div>
        <div class="ap-form">
          <input id="apName" placeholder="Your name (approver)" value="${esc(localStorage.approver || "")}" />
          <input id="apComment" placeholder="Comment (optional)" />
          <div class="ap-btns"><button id="apReject" class="btn danger">Reject claim</button><button id="apApprove" class="btn primary">Approve</button></div>
        </div>
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:8px">Each bill is pre-set to the AI recommendation. Change any bill before approving; open a bill to see the evidence.</div>
    </div>
    ${d.lines.map((l) => lineCard(l, [], toggle(l))).join("")}`;

  const choices = Object.fromEntries(d.lines.map((l) => [l.itemId, l.recommendation]));
  const recalc = () => { $("#apAmt").textContent = inr(d.lines.reduce((s, l) => s + (choices[l.itemId] === "approve" ? l.eligibleInr || 0 : 0), 0)); };
  document.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    choices[seg.dataset.item] = b.dataset.v;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    recalc();
  })));
  const send = async (action) => {
    const approver = $("#apName").value.trim();
    if (!approver) { $("#apName").classList.add("err"); $("#apName").focus(); return; }
    localStorage.approver = approver;
    const res = await api(`/api/finance/claims/${encodeURIComponent(c.claimId)}/decide`, { method: "POST", body: JSON.stringify({ approver, action, lines: choices, comment: $("#apComment").value }) });
    if (res.error) return toast(res.error);
    toast(`${c.claimId} ${LABEL[res.decision.status].toLowerCase()} · ${inr(res.decision.approvedAmount)}`);
    renderFinance(c.claimId);
  };
  $("#apApprove").onclick = () => send("custom");
  $("#apReject").onclick = () => send("reject_all");
}

// =====================================================================
// navigation, mode toggle, wiring
// =====================================================================
function switchView(view, focusId) {
  document.querySelectorAll(".nav-item").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#view-employee").classList.toggle("hidden", view !== "employee");
  $("#view-finance").classList.toggle("hidden", view !== "finance");
  $("#crumb").textContent = view === "finance" ? "Finance desk" : "My claim";
  $("#modeSwitch").classList.toggle("disabled", view === "finance");
  if (view === "finance") renderFinance(focusId);
}

function setMode(m) {
  mode = m;
  localStorage.mode = m;
  switchView("employee");
  document.querySelectorAll("#modeSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#mode-web").classList.toggle("hidden", m !== "web");
  $("#mode-chat").classList.toggle("hidden", m !== "chat");
  if (m === "chat") { chatWelcome(); $("#chatInput").focus(); }
  if (m === "web" && current && !busy) renderEmployeeStatus(current);
}

async function reset() {
  clearInterval(pollTimer);
  await api("/api/claim/reset", { method: "POST" });
  Object.values(localPreviews).forEach(URL.revokeObjectURL);
  localPreviews = {};
  current = null;
  ["intake", "build", "audit", "chat"].forEach((a) => agent(a, null));
  setStep("upload");
  showStage("upload");
  if (mode === "chat") { botSay("Starting a fresh claim. Send me your receipts whenever you're ready 📎"); defaultChips(); }
}

function showEngine() {
  const s = CONFIG.status || {};
  const el = $("#engine");
  el.className = `engine ${s.claude === "ok" ? "live" : s.claude === "checking" ? "chk" : "off"}`;
  el.innerHTML = s.claude === "ok" ? `● Live AI · Claude<br/><small>${esc(s.model)}</small>` : s.claude === "checking" ? "Connecting to Claude…" : `● Offline AI engine<br/><small>${esc(s.detail || "")}</small>`;
  el.title = s.claude === "ok" ? s.detail : `Claude not active – ${s.detail}. Receipts are read by the offline local AI engine.`;
}

function accept(fileList) {
  const files = [...fileList].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
  if (!files.length) return toast("Only images and PDFs are supported.");
  files.forEach((f) => (localPreviews[f.name] = URL.createObjectURL(f)));
  if (mode === "chat") chatUpload(files);
  else runPipeline(files, false, webHooks);
}

function dropTarget(el, cls) {
  ["dragenter", "dragover"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add(cls); }));
  ["dragleave", "drop"].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || !el.contains(e.relatedTarget)) el.classList.remove(cls); }));
  el.addEventListener("drop", (e) => accept(e.dataTransfer.files));
}

$("#fileInput").onchange = (e) => { accept(e.target.files); e.target.value = ""; };
$("#chatFile").onchange = (e) => { accept(e.target.files); e.target.value = ""; };
dropTarget($("#dropzone"), "dragging");
dropTarget($("#chatDrop"), "dragging");
document.addEventListener("paste", (e) => e.clipboardData?.files?.length && accept(e.clipboardData.files));
$("#demoBtn").onclick = () => runPipeline([], true, webHooks);
$("#policyBtn").onclick = () => $("#policyDlg").showModal();
document.querySelectorAll(".nav-item").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
document.querySelectorAll("#modeSwitch button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

(async () => {
  CONFIG = await (await fetch("/api/config")).json();
  if (CONFIG.version !== SERVER_VERSION) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="stale">An older ClaimPilot server is running on this port. Stop it (Ctrl+C in its terminal), run <code>npm start</code> again, then reload this page.</div>`);
  }
  showEngine();
  for (let i = 0; i < 10 && CONFIG.status?.claude === "checking"; i++) {
    await sleep(1000);
    CONFIG = await (await fetch("/api/config")).json();
    showEngine();
  }
  $("#policyList").innerHTML = (CONFIG.policy || []).map((p) => `<li>${esc(p)}</li>`).join("");
  setStep("upload");
  setMode(mode);
  refreshPendingBadge();
})();
