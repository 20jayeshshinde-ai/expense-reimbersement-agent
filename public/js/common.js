// Shared helpers for both portals (employee + finance).
export const $ = (s) => document.querySelector(s);
export const sid = sessionStorage.sid || (sessionStorage.sid = crypto.randomUUID());
export const inr = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SERVER_VERSION = 6;
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
  el.className = `engine ${s.state === "ok" ? "live" : s.state === "checking" ? "chk" : "off"}`;
  el.innerHTML = s.state === "ok" ? "● Live AI" : s.state === "checking" ? "Connecting…" : "● Offline AI";
  el.title = s.state === "ok" ? s.detail : `Live AI not active – ${s.detail}. Receipts are read by the offline local AI engine.`;
}

export async function loadConfig() {
  Object.assign(CONFIG, await (await fetch("/api/config")).json());
  if (CONFIG.version !== SERVER_VERSION) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="stale">An older ClaimPilot server is running on this port. Stop it (Ctrl+C in its terminal), run <code>npm start</code> again, then reload this page.</div>`);
  }
  showEngine();
  $("#policyList") && ($("#policyList").innerHTML = (CONFIG.policy || []).map((p) => `<li>${esc(p)}</li>`).join(""));
  $("#policyBtn") && ($("#policyBtn").onclick = () => $("#policyDlg").showModal());
  for (let i = 0; i < 10 && CONFIG.status?.state === "checking"; i++) {
    await sleep(1000);
    Object.assign(CONFIG, await (await fetch("/api/config")).json());
    showEngine();
  }
}

// ---------- duplicate tickets (employee only – these never reach finance) ----------
export function duplicatesHtml(dups) {
  if (!dups?.length) return "";
  const thumb = (file) => {
    if (!file) return "";
    const src = localPreviews[file] || (/^\d\d_/.test(file) ? `/samples/${encodeURIComponent(file)}` : null);
    return src && !/\.pdf$/i.test(file) ? `<img src="${src}" alt="" loading="lazy"/>` : "";
  };
  const row = (label, a, b) => `<tr><td>${label}</td><td>${esc(a ?? "—")}</td><td>${esc(b ?? "—")}</td><td>${a === b ? "✅" : "≠"}</td></tr>`;
  return `
    <h3 class="sec dup-head">🔁 Duplicate tickets · not sent to finance <small>${dups.length} receipt${dups.length > 1 ? "s" : ""} · every detail matches an existing bill</small></h3>
    ${dups.map((d) => `
      <div class="dup card">
        <div class="dup-top">
          <div class="dup-badge">${d.kind === "already_claimed" ? "ALREADY CLAIMED" : "DUPLICATE"}</div>
          <div><b>${esc(d.vendor)}</b> · ${esc(d.date || "no date")}${d.time ? " " + esc(d.time) : ""} · ${inr(d.amountInr ?? d.total)}
            <div class="muted">${esc(d.file)} · ${esc(d.reason)}</div></div>
          <div class="dup-amt">${inr(0)}<small>not claimed</small></div>
        </div>
        ${d.original ? `
        <div class="dup-body">
          <div class="dup-imgs"><figure>${thumb(d.file)}<figcaption>This upload</figcaption></figure><figure>${thumb(d.original.file)}<figcaption>${esc(d.original.where)}</figcaption></figure></div>
          <table class="dup-cmp">
            <thead><tr><th></th><th>This receipt</th><th>${esc(d.original.where)}</th><th></th></tr></thead>
            <tbody>
              ${row("Vendor", d.vendor, d.original.vendor)}
              ${row("Date", d.date, d.original.date)}
              ${row("Time", d.time, d.original.time)}
              ${row("Bill / invoice no.", d.invoice, d.original.invoice)}
              ${row("Items", `${d.itemCount} line${d.itemCount === 1 ? "" : "s"}`, `${d.original.itemCount} line${d.original.itemCount === 1 ? "" : "s"}`)}
              ${row("Total", d.total != null ? inr(d.total) : null, d.original.total != null ? inr(d.original.total) : null)}
            </tbody>
          </table>
        </div>` : ""}
        <div class="dup-foot">ℹ️ ${d.kind === "already_claimed" ? "You already claimed this bill, so it wasn't submitted again." : "You uploaded the same receipt twice. It's claimed once."} If this is a genuinely different expense, upload the correct receipt.</div>
      </div>`).join("")}`;
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
      <div class="fields"><b style="grid-column:1/3;font-size:13px">Read by ${/local/i.test(l.extractedBy) ? "Offline AI" : "Live AI"}</b>
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
