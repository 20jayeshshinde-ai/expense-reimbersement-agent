const $ = (s) => document.querySelector(s);
const sid = sessionStorage.sid || (sessionStorage.sid = crypto.randomUUID());
const inr = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let CONFIG = { categories: {} };
let state = null;
let prevQuestionIds = new Set();

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "x-session": sid, ...(opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...opts.headers } });
  const data = await res.json().catch(() => ({}));
  if (data.claim) render(data.claim);
  return data;
}

function say(text, who = "bot", extra = "") {
  const el = document.createElement("div");
  el.className = `msg ${who}`;
  el.innerHTML = esc(text) + extra;
  $("#messages").querySelector(".empty")?.remove();
  $("#messages").append(el);
  $("#messages").scrollTop = 1e9;
  return el;
}

function emptyState() {
  $("#messages").innerHTML = `<div class="empty">
    <div class="big-drop"><b>Drop your pile of receipts here</b>Photos, scans or PDFs – taxis, hotels, flights, meals. I'll read them, group them into trips, check policy, catch duplicates and only ask you what I genuinely can't work out.</div>
    <button id="demoBtn" class="primary">Try with 7 sample receipts</button>
    <p style="font-size:12px">Samples are synthetic – no real people or companies.</p></div>`;
  $("#demoBtn").onclick = runDemo;
}

// ---------- uploads ----------
async function uploadFiles(files) {
  files = [...files].filter((f) => /^(image\/|application\/pdf)/.test(f.type));
  if (!files.length) return;
  say(`Added ${files.length} file${files.length > 1 ? "s" : ""}`, "user", `<div class="thumbs">${files.map((f) => `<span>${esc(f.name)}</span>`).join("")}</div>`);
  const t = say(`Reading ${files.length} document${files.length > 1 ? "s" : ""}…`, "bot typing");
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const started = performance.now();
  const data = await api("/api/upload", { method: "POST", body: fd });
  t.remove();
  afterIngest(data, performance.now() - started);
}

async function runDemo() {
  say("Use the sample receipts", "user");
  const t = say("Reading 7 documents…", "bot typing");
  const started = performance.now();
  const data = await api("/api/demo", { method: "POST" });
  t.remove();
  afterIngest(data, performance.now() - started);
}

function afterIngest(data, ms) {
  const errs = (data.report || []).filter((r) => r.error);
  const added = (data.report || []).reduce((s, r) => s + (r.added || 0), 0);
  const c = data.claim;
  if (!c) return say("Upload failed – please try again.");
  const lines = [`Done in ${(ms / 1000).toFixed(1)}s. I found ${added} expense${added === 1 ? "" : "s"}.`];
  const trips = c.groups.filter((g) => g.kind === "trip");
  if (trips.length) lines.push(`🧳 Grouped into ${trips.map((g) => g.title.replace(/^Trip/, "trip")).join(", ")}${c.groups.some((g) => g.kind === "local") ? " + local expenses" : ""}.`);
  const dups = c.items.filter((i) => i.duplicate && !i.excluded);
  if (dups.length) lines.push(`🔁 ${dups.length} possible duplicate${dups.length > 1 ? "s" : ""}.`);
  const capped = c.items.filter((i) => i.issues?.some((x) => x.code === "over_cap" || x.code === "alcohol"));
  if (capped.length) lines.push(`📏 ${capped.length} item${capped.length > 1 ? "s" : ""} adjusted for policy limits.`);
  if (errs.length) lines.push(`⚠️ Couldn't read: ${errs.map((e) => `${e.file} (${e.error})`).join("; ")}`);
  lines.push(c.questions.length ? `I just need ${c.questions.length} answer${c.questions.length > 1 ? "s" : ""} from you – tap below, or type it all in one message.` : "Everything checks out – ready to submit ✅");
  say(lines.join("\n"));
}

// ---------- questions ----------
function renderQuestions(c) {
  const box = $("#questions");
  if (!c.questions.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="qhead">Needed to submit · ${c.questions.length}</div>` + c.questions.map((q) => `
    <div class="q" data-id="${esc(q.id)}" data-target="${esc(q.target)}" data-field="${esc(q.field)}">
      <div class="qt">${esc(q.text)}</div>
      <div class="row">
        ${q.kind === "choice" ? "" : `<input type="${q.kind === "date" ? "date" : q.kind === "number" ? "number" : "text"}" placeholder="Your answer" />`}
        ${q.suggestions.map((s) => `<button type="button" class="sugg">${esc(s)}</button>`).join("")}
        ${q.kind === "choice" ? "" : `<button type="button" class="ok primary">OK</button>`}
      </div>
    </div>`).join("");
  box.querySelectorAll(".q").forEach((el) => {
    const send = (value) => {
      if (!String(value).trim()) return;
      let field = el.dataset.field;
      if (field === "exclude") value = "true";
      api("/api/answer", { method: "POST", body: JSON.stringify({ target: el.dataset.target, field, value }) });
    };
    const input = el.querySelector("input");
    el.querySelectorAll(".sugg").forEach((b) => (b.onclick = () => send(b.textContent)));
    el.querySelector(".ok")?.addEventListener("click", () => send(input.value));
    input?.addEventListener("keydown", (e) => e.key === "Enter" && send(input.value));
  });
}

// ---------- board ----------
function render(c) {
  state = c;
  const t = c.totals, r = c.readiness;
  const pct = c.submitted ? 100 : r.ready ? 100 : r.progress;
  $("#ringFg").style.strokeDasharray = `${pct} 100`;
  $("#ringTxt").textContent = `${pct}%`;
  $("#sumReimb").textContent = inr(t.reimbursable);
  $("#sumSub").textContent = t.items
    ? `${t.items} item${t.items > 1 ? "s" : ""} · claimed ${inr(t.claimed)}${t.deducted > 0 ? ` · ${inr(t.deducted)} not reimbursable` : ""}${r.requiresManagerApproval ? " · needs manager approval" : ""}`
    : "No receipts yet";
  const btn = $("#submitBtn");
  btn.disabled = !r.ready || !!c.submitted;
  btn.textContent = c.submitted ? `Submitted · ${c.submitted.claimId}` : r.ready ? "Submit claim" : `${r.openQuestions} to go`;

  const live = c.items.filter((i) => !i.excluded);
  const n = (s) => live.filter((i) => i.status === s).length;
  $("#chips").innerHTML = t.items ? [
    `<span class="chip ok">✓ ${n("ready")} ready</span>`,
    n("review") ? `<span class="chip warn">⚠ ${n("review")} check</span>` : "",
    n("blocked") ? `<span class="chip bad">⛔ ${n("blocked")} blocked</span>` : "",
    c.items.length - live.length ? `<span class="chip">${c.items.length - live.length} removed</span>` : "",
    `<span class="chip info">⏱ ~${c.minutesSaved} min saved</span>`,
  ].join("") : "";

  $("#groups").innerHTML = c.groups.map((g) => {
    const items = g.itemIds.map((id) => c.items.find((i) => i.id === id));
    const sum = items.filter((i) => !i.excluded && i.status !== "blocked").reduce((s, i) => s + (i.reimbursable || 0), 0);
    const purpose = items.find((i) => i.purpose)?.purpose;
    return `<div class="group">
      <h4>${g.kind === "trip" ? "🧳" : "📍"} ${esc(g.title)} <small>${g.start ? `${g.start} → ${g.end} · ` : ""}${inr(sum)}</small></h4>
      ${purpose ? `<div class="purpose">Purpose: ${esc(purpose)}</div>` : ""}
      ${items.map(itemCard).join("")}</div>`;
  }).join("");
  bindItemEditors();

  // Announce newly-resolved state in chat.
  const qids = new Set(c.questions.map((q) => q.id));
  if (prevQuestionIds.size && !qids.size && r.ready && !c.submitted) say(`All set ✅ ${inr(t.reimbursable)} across ${t.items} items is ready to submit.`);
  prevQuestionIds = qids;
  renderQuestions(c);
}

function itemCard(i) {
  const cat = CONFIG.categories[i.category] || { icon: "🧾", label: i.category };
  const low = new Set(i.low_confidence_fields || []);
  const foreign = i.currency !== "INR" && i.total != null ? ` · ${i.currency} ${i.total}` : "";
  const deducted = i.amountInr != null && i.reimbursable != null && i.reimbursable < i.amountInr;
  const opts = Object.entries(CONFIG.categories).map(([k, v]) => `<option value="${k}" ${k === i.category ? "selected" : ""}>${v.label}</option>`).join("");
  return `<div class="item card ${i.status}" data-id="${i.id}">
    <div class="ic">${cat.icon}</div>
    <div><div class="v">${esc(i.vendor || "Unknown vendor")}</div>
      <div class="meta">${esc(i.date || "no date")} · ${esc(cat.label)}${foreign} · ${esc(i.file)}</div>
      <div class="meta">${esc(i.description)}</div></div>
    <div class="amt">${i.amountInr == null ? "—" : inr(i.excluded ? i.amountInr : i.reimbursable)}${deducted && !i.excluded ? `<s>${inr(i.amountInr)}</s>` : ""}</div>
    ${i.issues?.length && !i.excluded ? `<div class="issues">${i.issues.map((x) => `<div class="issue ${x.level}">${esc(x.text)}</div>`).join("")}</div>` : ""}
    <details><summary>${i.excluded ? "Removed from claim" : `Details & edit · AI confidence ${Math.round((i.confidence || 0) * 100)}%`}</summary>
      <div class="edit">
        <label>Vendor<input data-f="vendor" value="${esc(i.vendor)}" class="${low.has("vendor") ? "lowconf" : ""}"/></label>
        <label>Date<input data-f="date" type="date" value="${esc(i.date)}" class="${low.has("date") ? "lowconf" : ""}"/></label>
        <label>Total (${esc(i.currency)})<input data-f="total" type="number" step="0.01" value="${i.total ?? ""}" class="${low.has("total") ? "lowconf" : ""}"/></label>
        <label>Category<select data-f="category">${opts}</select></label>
        <label>Invoice #<input disabled value="${esc(i.invoice_number)}"/></label>
        <label>Tax<input disabled value="${i.tax ?? ""}"/></label>
      </div>
      <div class="actions"><button data-act="${i.excluded ? "include" : "exclude"}">${i.excluded ? "Restore" : "Remove from claim"}</button></div>
    </details></div>`;
}

function bindItemEditors() {
  document.querySelectorAll(".item").forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll("[data-f]").forEach((inp) => inp.addEventListener("change", () =>
      api("/api/answer", { method: "POST", body: JSON.stringify({ target: id, field: inp.dataset.f, value: inp.value }) })));
    card.querySelector("[data-act]")?.addEventListener("click", (e) =>
      api("/api/answer", { method: "POST", body: JSON.stringify({ target: id, field: "exclude", value: e.target.dataset.act === "exclude" ? "true" : "false" }) }));
  });
}

// ---------- chat ----------
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#chatInput").value.trim();
  if (!text) return;
  $("#chatInput").value = "";
  say(text, "user");
  if (!state?.items.length) return say("Drop some receipts first (or try the samples) and I'll take it from there.");
  const t = say("Thinking…", "bot typing");
  const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
  t.remove();
  say(data.reply || "Okay.");
});

// ---------- submit ----------
$("#submitBtn").onclick = async () => {
  const data = await api("/api/submit", { method: "POST" });
  if (!data.submitted) return say(data.error || "Couldn't submit.");
  const s = data.submitted;
  say(`Submitted to FinanceHub (mock) as ${s.claimId} – status: ${s.status.replaceAll("_", " ")}. Expected payout: ${s.expectedPayout}.`);
  $("#submitBody").innerHTML = `<div class="success">✅</div><h3 style="text-align:center">Claim ${esc(s.claimId)} submitted</h3>
    <p style="text-align:center">${inr(s.payload.totals.reimbursable)} · ${s.payload.lines.length} lines · ${esc(s.status.replaceAll("_", " "))}</p>
    <p>Payload sent to the (mock) finance system:</p><pre class="json">${esc(JSON.stringify(s.payload, null, 2))}</pre>`;
  $("#submitDlg").showModal();
};

// ---------- misc ----------
$("#resetBtn").onclick = async () => { await api("/api/claim/reset", { method: "POST" }); prevQuestionIds = new Set(); emptyState(); };
$("#policyBtn").onclick = () => $("#policyDlg").showModal();
$("#fileInput").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragging"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === dz.querySelector(".drop-overlay")) dz.classList.remove("dragging"); }));
dz.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));
document.addEventListener("paste", (e) => e.clipboardData?.files?.length && uploadFiles(e.clipboardData.files));

(async () => {
  CONFIG = await (await fetch("/api/config")).json();
  $("#engine").textContent = CONFIG.live ? `AI: ${CONFIG.model}` : "Offline demo mode";
  $("#engine").classList.toggle("off", !CONFIG.live);
  $("#policyList").innerHTML = CONFIG.policy.map((p) => `<li>${esc(p)}</li>`).join("");
  emptyState();
  const c = await api("/api/claim");
  if (c.items?.length) say(`Welcome back – your claim has ${c.totals.items} items.`);
})();
