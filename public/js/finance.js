// Finance portal: the human approver reviews claims the Audit Agent has investigated and decides.
// This is the only place money can be approved.
import { $, api, inr, esc, toast, loadConfig, lineCard, LABEL } from "./common.js";

const APPROVER = sessionStorage.approver || "Priya Nair";
let tab = "queue";
let list = [];
let selected = null;
let lastPendingIds = "";

async function load() {
  list = await api("/api/finance/claims");
  const reviewed = list.filter((c) => c.decision);
  const pending = reviewed.filter((c) => c.status === "pending_approval");
  const decided = reviewed.filter((c) => c.status !== "pending_approval");
  const sum = (arr, f) => arr.reduce((s, c) => s + f(c), 0);

  $("#queueCount").textContent = pending.length;
  $("#queueCount").classList.toggle("hidden", !pending.length);
  $("#finKpis").innerHTML = `
    <div class="kpi warn"><div class="l">Awaiting your approval</div><div class="v">${pending.length}</div></div>
    <div class="kpi"><div class="l">Pending value (AI-recommended)</div><div class="v">${inr(sum(pending, (c) => c.decision.recommendedAmount))}</div></div>
    <div class="kpi ok"><div class="l">Approved so far</div><div class="v">${inr(sum(decided, (c) => c.decision.approvedAmount))}</div></div>
    <div class="kpi bad"><div class="l">Blocked by Audit Agent</div><div class="v">${inr(sum(reviewed, (c) => c.decision.flaggedAmount))}</div></div>`;

  const rows = tab === "queue" ? pending : list.filter((c) => c.status !== "pending_approval");
  $("#listTitle").textContent = tab === "queue" ? "Approval queue" : "Decided claims";
  $("#finRows").innerHTML = rows.length
    ? rows.map((c) => `<tr class="${c.decision ? "clickable" : ""}" data-id="${esc(c.claimId)}">
        <td><b>${esc(c.claimId)}</b></td><td>${esc(c.employee)}</td><td>${new Date(c.submittedAt).toLocaleString()}</td>
        <td>${c.lines}${c.decision?.flaggedCount ? ` <span class="st-badge rejected">${c.decision.flaggedCount} flagged</span>` : ""}</td><td>${inr(c.amount)}</td>
        <td><span class="st-badge ${c.status}">${esc(c.status.replaceAll("_", " "))}</span></td></tr>`).join("")
    : `<tr><td colspan="6" class="empty-row">${tab === "queue" ? "🎉 Nothing waiting for approval. New claims appear here automatically." : "No decided claims yet."}</td></tr>`;
  document.querySelectorAll("#finRows tr.clickable").forEach((tr) => (tr.onclick = () => show(tr.dataset.id)));

  if (!rows.some((c) => c.claimId === selected)) selected = rows.find((c) => c.decision)?.claimId || null;
  if (selected) show(selected); else $("#finDetail").innerHTML = "";

  // New claim arrived while the page was open.
  const ids = pending.map((c) => c.claimId).join(",");
  if (lastPendingIds && ids !== lastPendingIds && pending.some((c) => !lastPendingIds.includes(c.claimId))) toast("📥 New claim received for approval");
  lastPendingIds = ids;
}

function show(claimId) {
  selected = claimId;
  const c = list.find((x) => x.claimId === claimId);
  if (!c?.decision) return;
  const d = c.decision;
  document.querySelectorAll("#finRows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === claimId));

  if (d.status !== "pending_approval") {
    $("#finDetail").innerHTML = `<h3 class="sec">${esc(c.claimId)} · ${esc(LABEL[d.status])} by ${esc(d.approver)} <small>${new Date(d.decidedAt).toLocaleString()}${d.overrides ? ` · ${d.overrides} AI recommendation${d.overrides > 1 ? "s" : ""} overridden` : ""}</small></h3>
      ${d.comment ? `<div class="removed">💬 ${esc(d.comment)}</div>` : ""}${d.lines.map((l) => lineCard(l)).join("")}`;
    return;
  }
  // Don't wipe an approver's in-progress edits on auto-refresh.
  if ($("#finDetail").dataset.claim === claimId && $("#apApprove")) return;

  const toggle = (l) => `<span class="seg" data-item="${esc(l.itemId)}">
      <button type="button" data-v="approve" class="${l.recommendation === "approve" ? "on" : ""}">Approve</button>
      <button type="button" data-v="reject" class="${l.recommendation === "reject" ? "on" : ""}">Reject</button></span>`;
  $("#finDetail").dataset.claim = claimId;
  $("#finDetail").innerHTML = `
    <div class="approval card">
      <div class="ap-head">
        <div style="flex:1;min-width:280px"><div class="label">Claim ${esc(c.claimId)} · ${esc(c.employee)} · ${esc(d.employee?.costCenter || "")}</div>
          <div class="ap-amt" id="apAmt">${inr(d.recommendedAmount)}</div>
          <div class="muted">${esc(d.agent)} recommends <b>${esc(d.agentRecommendation.replace("_", " "))}</b> · ${d.lines.length - d.flaggedCount} verified, ${d.flaggedCount} flagged · requires ${esc(d.approvalLevel)}</div>
          ${d.agentSummary ? `<div class="agent-summary" style="margin-top:10px">🤖 ${esc(d.agentSummary)}</div>` : ""}</div>
        <div class="ap-form">
          <div class="signed">Signing as <b>${esc(APPROVER)}</b></div>
          <input id="apComment" placeholder="Comment to employee (optional)" />
          <div class="ap-btns"><button id="apReject" class="btn danger">Reject claim</button><button id="apApprove" class="btn primary">Approve</button></div>
        </div>
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:8px">Each bill is pre-set to the AI recommendation. Change any bill before approving; open a bill to see the evidence and the receipt.</div>
    </div>
    ${d.removed.length ? `<div class="removed">🔁 ${d.removed.length} duplicate${d.removed.length > 1 ? "s" : ""} removed automatically before submission: ${d.removed.map((r) => esc(r.vendor)).join(", ")}</div>` : ""}
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
    const res = await api(`/api/finance/claims/${encodeURIComponent(c.claimId)}/decide`, { method: "POST", body: JSON.stringify({ approver: APPROVER, action, lines: choices, comment: $("#apComment").value }) });
    if (res.error) return toast(res.error);
    toast(`${c.claimId} ${LABEL[res.decision.status].toLowerCase()} · ${inr(res.decision.approvedAmount)}`);
    $("#finDetail").dataset.claim = "";
    await load();
  };
  $("#apApprove").onclick = () => send("custom");
  $("#apReject").onclick = () => send("reject_all");
}

function setTab(t) {
  tab = t;
  document.querySelectorAll(".nav-item[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $("#crumb").textContent = t === "queue" ? "Approval queue" : "History";
  selected = null;
  $("#finDetail").dataset.claim = "";
  load();
}

document.querySelectorAll(".nav-item[data-tab]").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$("#whoName").textContent = APPROVER;
$("#avatar").textContent = APPROVER.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

(async () => {
  await loadConfig();
  await load();
  setInterval(load, 4000); // new claims from employees appear automatically
})();
