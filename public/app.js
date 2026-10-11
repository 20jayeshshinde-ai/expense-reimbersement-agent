const $ = (s) => document.querySelector(s);
const sid = sessionStorage.sid || (sessionStorage.sid = crypto.randomUUID());
const inr = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CONFIG = { categories: {} };
let localPreviews = {}; // file name -> object URL, for receipt thumbnails

async function api(path, opts = {}) {
  const headers = { "x-session": sid };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  return res.json();
}

// ---------------- stepper / stages ----------------
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

// ---------------- the automatic pipeline ----------------
async function runPipeline(files, demo = false) {
  showStage("process");
  setStep("read");
  const names = demo ? ["Loading 8 sample receipts…"] : files.map((f) => f.name);
  $("#procTitle").textContent = "AI is reading your receipts…";
  $("#procSub").textContent = CONFIG.live ? `Claude ${CONFIG.status.model} · vision + PDF understanding · tamper inspection` : "Local AI · neural OCR + receipt parser";
  $("#procFiles").innerHTML = names.map((n) => `<div class="pf"><span class="st">⏳</span><span class="nm">${esc(n)}</span></div>`).join("");

  const started = performance.now();
  let data;
  try {
    if (demo) data = await api("/api/demo", { method: "POST" });
    else {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      data = await api("/api/upload", { method: "POST", body: fd });
    }
  } catch {
    return fail("Could not reach the server.");
  }
  if (!data.claim) return fail("Something went wrong reading the files.");

  $("#procFiles").innerHTML = data.report.map((r) => `<div class="pf ${r.error ? "" : "done"}"><span class="st">${r.error ? "⚠️" : "✅"}</span><span class="nm">${esc(r.file)}</span><span class="muted">${r.error ? "unreadable" : (r.ms / 1000).toFixed(1) + "s"}</span></div>`).join("");
  const c = data.claim;
  if (!c.totals.items) return fail("No expenses could be read from these files. Try clearer photos or PDFs.");

  await sleep(600);
  setStep("build");
  const trips = c.groups.filter((g) => g.kind === "trip").map((g) => g.title);
  $("#procTitle").textContent = "Claim built automatically";
  $("#procSub").textContent = `${c.totals.items} expenses · ${trips.length ? trips.join(", ") + " · " : ""}${c.totals.removed ? `${c.totals.removed} duplicate removed · ` : ""}purpose and categories filled in by AI`;
  await sleep(900);

  setStep("verify");
  $("#procTitle").textContent = "Audit Agent is investigating every bill…";
  $("#procSub").textContent = "The agent picks its own checks: GSTIN registry · arithmetic · tampering · claim history · policy";
  $("#procFiles").innerHTML = `<div class="agent-log" id="agentLog"></div>`;
  const res = await streamAudit();
  if (!res.decision) return fail(res.error || "Finance verification failed.");
  await sleep(700);
  elapsed = (performance.now() - started) / 1000;
  claimNotes = Object.fromEntries(c.items.map((i) => [i.id, i.aiNotes]));
  renderEmployeeStatus(res.decision);
  watchStatus();
}

let elapsed = 0, claimNotes = {}, pollTimer = null;

// Live feed of the Audit Agent's tool calls and verdicts (server-sent events).
const TOOL_LABEL = {
  list_bills: "Listed bills", get_bill_details: "Read bill details", verify_gstin: "Verified GSTIN", check_arithmetic: "Checked arithmetic",
  check_metadata_tampering: "Checked for tampering", check_claim_history: "Searched claim history", check_policy: "Applied policy",
};
function streamAudit() {
  return new Promise((resolve) => {
    const log = $("#agentLog");
    const add = (html, cls = "") => {
      const row = document.createElement("div");
      row.className = `ev ${cls}`;
      row.innerHTML = html;
      log.append(row);
      log.scrollTop = 1e9;
    };
    const es = new EventSource(`/api/submit/stream?sid=${encodeURIComponent(sid)}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "agent") add(`🤖 <b>${esc(e.text)}</b>`, "agent");
      else if (e.type === "thought") add(`💭 ${esc(e.text)}`, "thought");
      else if (e.type === "tool") add(`<span class="dot ${e.status}"></span><b>${esc(TOOL_LABEL[e.tool] || e.tool)}</b>${e.vendor ? ` · ${esc(e.vendor)}` : ""} <span class="muted">${esc(e.detail || "")}</span>`, "tool");
      else if (e.type === "verdict") add(`${e.recommendation === "approve" ? "✅" : "⛔"} <b>${esc(e.vendor)}</b>: recommend ${e.recommendation} <span class="risk ${e.risk}">${e.risk} risk</span> <span class="muted">${esc(e.reason)}</span>`, `verdict ${e.recommendation}`);
      else if (e.type === "done" || e.type === "error") { es.close(); resolve(e); }
    };
    es.onerror = () => { es.close(); resolve({ error: "Lost connection to the audit agent. If you just updated the code, stop the server (Ctrl+C) and run npm start again." }); };
  });
}

// Employee waits for the human approver; poll until the decision lands.
function watchStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { decision } = await api("/api/claim/status");
    if (decision && decision.status !== "pending_approval") {
      clearInterval(pollTimer);
      renderEmployeeStatus(decision);
    }
  }, 2000);
}

const LABEL = { pending_approval: "Awaiting finance approval", approved: "Approved", partially_approved: "Approved (partially)", rejected: "Rejected" };
const ICON = { pending_approval: "⏳", approved: "✅", partially_approved: "✅", rejected: "⛔" };

function fail(msg) {
  showStage("decision");
  $("#stage-decision").innerHTML = `<div class="hero rejected"><div class="badge">⚠️</div><div><div class="amount" style="font-size:24px">${esc(msg)}</div></div><div></div></div>
    <div class="actions-row"><button class="primary" id="againBtn">Try again</button></div>`;
  $("#againBtn").onclick = reset;
}

// ---------------- employee status screen ----------------
function renderEmployeeStatus(d) {
  showStage("decision");
  const pending = d.status === "pending_approval";
  setStep(pending ? "verify" : "decision");
  if (pending) document.querySelector('#stepper li[data-step="verify"]').classList.add("done");
  const ok = d.lines.filter((l) => (pending ? l.recommendation === "approve" : l.verdict === "approved"));
  const flagged = d.lines.filter((l) => (pending ? l.recommendation === "reject" : l.verdict === "rejected"));
  const amount = pending ? d.recommendedAmount : d.approvedAmount;
  const sub = pending
    ? `recommended by the Audit Agent · ${ok.length} of ${d.lines.length} bills verified · waiting for a human approver (${esc(d.approvalLevel)})`
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
      <div class="meta"><b>${esc(d.claimId)}</b><br/>${esc(d.employee.name)}<br/>Receipts to verified claim in ${elapsed.toFixed(1)}s<br/>0 manual steps for you</div>
    </div>
    <div class="breakdown">
      <div class="kpi"><div class="l">Claimed</div><div class="v">${inr(d.claimedAmount)}</div></div>
      <div class="kpi ok"><div class="l">${pending ? "Recommended" : "Approved"}</div><div class="v">${inr(amount)}</div></div>
      <div class="kpi warn"><div class="l">Policy deductions</div><div class="v">${inr(d.policyDeduction)}</div></div>
      <div class="kpi bad"><div class="l">${pending ? "Flagged by AI" : "Rejected bills"}</div><div class="v">${inr(pending ? d.flaggedAmount : d.rejectedAmount)}</div></div>
    </div>
    ${d.agentSummary ? `<div class="agent-summary">🤖 <b>${esc(d.agent)}:</b> ${esc(d.agentSummary)}</div>` : ""}
    ${pending ? `<div class="waiting"><div class="spinner"></div><div>Your claim is in the finance approval queue. This page updates automatically once a finance approver decides.<br/><button class="link" id="toFinance">Open the Finance desk to approve (demo)</button></div></div>` : ""}
    ${flagged.length ? `<h3 class="sec">${pending ? "Flagged by Audit Agent" : "Rejected"} <small>${flagged.length} bill${flagged.length > 1 ? "s" : ""}</small></h3>${flagged.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}` : ""}
    <h3 class="sec">${pending ? "Verified by Audit Agent" : "Approved"} <small>${ok.length} bill${ok.length === 1 ? "" : "s"} · tap any bill to see the audit</small></h3>
    ${ok.map((l) => lineCard(l, claimNotes[l.itemId])).join("")}
    ${d.removed.length ? `<h3 class="sec">Removed automatically <small>not sent to finance</small></h3>${d.removed.map((r) => `<div class="removed">🔁 ${esc(r.vendor)} · ${esc(r.file)} – ${esc(r.reason)}</div>`).join("")}` : ""}
    <div class="actions-row"><button class="primary" id="againBtn">Start a new claim</button></div>`;
  $("#againBtn").onclick = reset;
  $("#toFinance")?.addEventListener("click", () => switchView("finance", d.claimId));
}

// Final verdict if a human decided, otherwise the agent's recommendation.
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
      <div class="fields"><b style="grid-column:1/3;font-size:13px">Read by AI · ${esc(l.extractedBy)}</b>
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

async function reset() {
  clearInterval(pollTimer);
  await api("/api/claim/reset", { method: "POST" });
  Object.values(localPreviews).forEach(URL.revokeObjectURL);
  localPreviews = {};
  setStep("upload");
  showStage("upload");
}

// ---------------- finance desk (human approver) ----------------
let finList = [];
async function renderFinance(focusId) {
  finList = await api("/api/finance/claims");
  const reviewed = finList.filter((c) => c.decision);
  const pending = reviewed.filter((c) => c.status === "pending_approval");
  const decided = reviewed.filter((c) => c.status !== "pending_approval");
  const sum = (arr, f) => arr.reduce((s, c) => s + f(c), 0);
  $("#finKpis").innerHTML = `
    <div class="kpi warn"><div class="l">Awaiting your approval</div><div class="v">${pending.length}</div></div>
    <div class="kpi"><div class="l">Pending value (AI-recommended)</div><div class="v">${inr(sum(pending, (c) => c.decision.recommendedAmount))}</div></div>
    <div class="kpi ok"><div class="l">Approved by finance</div><div class="v">${inr(sum(decided, (c) => c.decision.approvedAmount))}</div></div>
    <div class="kpi bad"><div class="l">Flagged by AI agent</div><div class="v">${inr(sum(reviewed, (c) => c.decision.flaggedAmount))}</div></div>`;
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
        <div><div class="label">Claim ${esc(c.claimId)} · ${esc(c.employee)}</div>
          <div class="ap-amt" id="apAmt">${inr(d.recommendedAmount)}</div>
          <div class="muted">${esc(d.agent)} recommends: <b>${esc(d.agentRecommendation.replace("_", " "))}</b> · ${d.lines.length - d.flaggedCount} verified, ${d.flaggedCount} flagged · requires ${esc(d.approvalLevel)}</div>
          ${d.agentSummary ? `<div class="agent-summary" style="margin-top:8px">🤖 ${esc(d.agentSummary)}</div>` : ""}</div>
        <div class="ap-form">
          <input id="apName" placeholder="Your name (approver)" value="${esc(localStorage.approver || "")}" />
          <input id="apComment" placeholder="Comment (optional)" />
          <div class="ap-btns"><button id="apReject" class="danger">Reject claim</button><button id="apApprove" class="primary">Approve</button></div>
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
    if (res.error) return alert(res.error);
    renderFinance(c.claimId);
  };
  $("#apApprove").onclick = () => send("custom");
  $("#apReject").onclick = () => send("reject_all");
}

function switchView(view, focusId) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#view-employee").classList.toggle("hidden", view !== "employee");
  $("#view-finance").classList.toggle("hidden", view !== "finance");
  if (view === "finance") renderFinance(focusId);
}

function showEngine() {
  const s = CONFIG.status;
  const el = $("#engine");
  el.className = `pill ${s.claude === "ok" ? "" : s.claude === "checking" ? "chk" : "off"}`;
  el.textContent = s.claude === "ok" ? `● Live AI: Claude (${s.model})` : s.claude === "checking" ? "Connecting to Claude…" : "AI engine: Local (offline)";
  el.title = s.claude === "ok" ? s.detail : `Claude not active – ${s.detail}. Receipts are read by the offline local AI engine.`;
}

// ---------------- wiring ----------------
function accept(fileList) {
  const files = [...fileList].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
  if (!files.length) return;
  files.forEach((f) => (localPreviews[f.name] = URL.createObjectURL(f)));
  runPipeline(files);
}
$("#fileInput").onchange = (e) => { accept(e.target.files); e.target.value = ""; };
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragging"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragging"); }));
dz.addEventListener("drop", (e) => accept(e.dataTransfer.files));
document.addEventListener("paste", (e) => e.clipboardData?.files?.length && accept(e.clipboardData.files));
$("#demoBtn").onclick = () => runPipeline([], true);
$("#policyBtn").onclick = () => $("#policyDlg").showModal();
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

(async () => {
  CONFIG = await (await fetch("/api/config")).json();
  if (CONFIG.version !== 3) {
    document.body.insertAdjacentHTML("afterbegin", `<div style="background:#b3261e;color:#fff;padding:12px 22px;font-weight:600">
      An older ClaimPilot server is running on this port. Stop it (Ctrl+C in its terminal), run <code>npm start</code> again, then reload this page.</div>`);
  }
  showEngine();
  // The server verifies the API key at startup; refresh once that check has finished.
  for (let i = 0; i < 10 && CONFIG.status.claude === "checking"; i++) {
    await sleep(1000);
    CONFIG = await (await fetch("/api/config")).json();
    showEngine();
  }
  $("#policyList").innerHTML = CONFIG.policy.map((p) => `<li>${esc(p)}</li>`).join("");
  setStep("upload");
})();
