// Shared helpers for both portals (employee + finance).
export const $ = (s) => document.querySelector(s);
export const sid = sessionStorage.sid || (sessionStorage.sid = crypto.randomUUID());
export const inr = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SERVER_VERSION = 5;
export const CONFIG = { categories: {}, status: {}, policy: [] };
export const localPreviews = {}; // file name -> object URL (employee's own uploads)

export const LABEL = { pending_approval: "Awaiting finance approval", approved: "Approved", partially_approved: "Approved (partially)", rejected: "Rejected" };
export const ICON = { pending_approval: "⏳", approved: "✅", partially_approved: "✅", rejected: "⛔" };

export async function api(path, opts = {}) {
  const headers = { "x-session": sid };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  return res.json();
}

export function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

export function agentLight(id, state) {
  const el = $(`#ag-${id}`);
  if (!el) return;
  el.classList.toggle("busy", state === "busy");
  el.classList.toggle("done", state === "done");
}

export function showEngine() {
  const s = CONFIG.status || {};
  const el = $("#engine");
  if (!el) return;
  el.className = `engine ${s.claude === "ok" ? "live" : s.claude === "checking" ? "chk" : "off"}`;
  el.innerHTML = s.claude === "ok" ? `● Live AI · ${esc(s.provider)}<br/><small>${esc(s.model)}</small>` : s.claude === "checking" ? `Connecting to ${esc(s.provider)}…` : `● Offline AI engine<br/><small>${esc(s.detail || "")}</small>`;
  el.title = s.claude === "ok" ? s.detail : `Live AI not active – ${s.detail}. Receipts are read by the offline local AI engine.`;
}

export async function loadConfig() {
  Object.assign(CONFIG, await (await fetch("/api/config")).json());
  if (CONFIG.version !== SERVER_VERSION) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="stale">An older ClaimPilot server is running on this port. Stop it (Ctrl+C in its terminal), run <code>npm start</code> again, then reload this page.</div>`);
  }
  showEngine();
  $("#policyList") && ($("#policyList").innerHTML = (CONFIG.policy || []).map((p) => `<li>${esc(p)}</li>`).join(""));
  $("#policyBtn") && ($("#policyBtn").onclick = () => $("#policyDlg").showModal());
  for (let i = 0; i < 10 && CONFIG.status?.claude === "checking"; i++) {
    await sleep(1000);
    Object.assign(CONFIG, await (await fetch("/api/config")).json());
    showEngine();
  }
}

// ---------- bill card (shared: employee status + finance review) ----------
function lineBadge(l) {
  if (l.verdict) return `<span class="verdict ${l.verdict}">${l.verdict === "approved" ? "APPROVED" : "REJECTED"}${l.overridden ? " · override" : ""}</span>`;
  return `<span class="verdict rec-${l.recommendation}">AI: ${l.recommendation === "approve" ? "VERIFIED" : "FLAGGED"}</span>`;
}

export function lineCard(l, aiNotes = [], controls = "") {
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
      ${l.possibleDuplicate ? `<div class="adj">🔍 ${esc(l.possibleDuplicate)}</div>` : ""}
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
