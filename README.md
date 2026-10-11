# ClaimPilot – Expense & Reimbursement Agent

A multi-agent reimbursement system. The employee drops a pile of receipts (photos, scans, PDFs) and does nothing else:

- an **Intake Agent** reads every bill and builds the claim
- an **Audit Agent** (Claude with tools) investigates each bill for authenticity and policy
- a **human finance approver** makes the final call

> All data in this repo is **synthetic**. Vendors, people, invoice numbers and the policy are made up. No company or personal data is used.

## The problem

| Today (manual) | Pain |
|---|---|
| Employee collects, types and categorises every bill | 3–6 min per receipt, typos, wrong categories |
| Employee guesses what the policy allows | Claims bounce back and forth |
| Finance re-checks every line by hand | Slow, and edited or duplicate bills still slip through |

## How it works: three agents and one human

```
 Employee drops receipts
        │
        ▼
 ┌─────────────────────┐  Claude vision + native PDF (live) · neural OCR + parser (offline fallback)
 │ 1. Intake Agent     │  Reads every bill: vendor, date, total, tax, GSTIN, invoice no., line items,
 └─────────┬───────────┘  city, nights, alcohol, covers. Also flags visual tampering (Claude mode).
           ▼
 ┌─────────────────────┐  Groups bills into trips, removes re-photographed duplicates, fills in purpose,
 │ 2. Claim Builder    │  category and GL code, applies policy caps (hotel, meals, alcohol, supplies).
 └─────────┬───────────┘  Zero questions to the employee.
           ▼
 ┌─────────────────────┐  Autonomous Claude tool-use agent. It decides which checks to run on each bill:
 │ 3. Audit Agent      │  verify_gstin · check_arithmetic · check_metadata_tampering · check_claim_history
 │   (Claude + tools)  │  · check_policy · get_bill_details. Then it calls record_verdict per bill
 └─────────┬───────────┘  (approve/reject, risk, reason) and finish_review. Each step streams live to the UI.
           ▼
 ┌─────────────────────┐  The finance desk sees the agent's recommendation and evidence for every bill.
 │ 4. Human approver   │  The approver can override any bill, then approves or rejects. This is the only
 └─────────────────────┘  way money is approved. The employee's screen updates automatically.
```

**Real-time vs demo.**
- **Live mode:** with `ANTHROPIC_API_KEY` in `.env`, both the Intake Agent and the Audit Agent run on Claude, so any real receipt you upload is read and audited live.
- **Offline mode:** used when there's no key or Claude is unreachable. It runs neural OCR plus a rule-based audit agent with the same tools, so the demo always works.

The badge in the top bar shows which engine is active.

### Authenticity checks (Audit Agent tools)

| Tool | What it catches |
|---|---|
| `verify_gstin` | Bad GSTIN checksum or state code, or a GSTIN registered to a different business (checked against a mock GST registry) |
| `check_arithmetic` | Printed line items + tax + charges ≠ printed total, a classic edited-amount fraud |
| `check_metadata_tampering` | EXIF/PDF metadata from Photoshop, Canva, PDF editors, etc., plus visual anomalies from Claude vision |
| `check_claim_history` | The same bill already submitted or reimbursed in another claim |

**Duplicate rule.** A receipt is only removed or blocked as a duplicate when it is the same file, or **every** detail matches exactly: vendor, date, time, bill/invoice no., currency, total, tax, and every line item with its cost. Near matches (for example, same place, day and amount but a different menu or time) are kept and shown to the approver as a possible duplicate.
| `check_policy` | Missing date or amount, outside the 60-day window, future dates, policy caps |

### The demo set (9 synthetic receipts)

| File | What happens |
|---|---|
| `01_taxi_airport.jpg` | Tilted phone photo, read and attached to the Bengaluru trip ✅ |
| `02_flight_bom_blr.pdf` | Scanned PDF read by OCR; anchors "Trip to Bengaluru" ✅ |
| `03_hotel_bengaluru.pdf` | ₹7,400/night vs the ₹6,000 metro cap, so ₹2,800 is deducted ✅ |
| `04_client_dinner.jpg` | 3 covers read from the bill; ₹600 of beer deducted ✅ |
| `05_taxi_airport_again.jpg` | Re-photographed copy of receipt 01: every detail identical, so removed automatically 🔁 |
| `06_stationery_no_date.jpg` | Date missing, flagged ⛔ |
| `07_coffee_already_claimed.jpg` | Already reimbursed in EXP-2026-0412, flagged ⛔ |
| `08_fuel_edited.jpg` | **Tampered:** total edited from ₹3,386.50 to ₹5,386.50, broken GSTIN, Photoshop EXIF tag. Flagged ⛔ |
| `09_team_lunch_same_place.jpg` | Same restaurant, day and total as receipt 04, but a different time, bill no. and menu. **Kept** and flagged 🔍 for the approver, not removed ✅ |

Result: **9 receipts → ₹25,110 recommended and ₹6,957 flagged → finance (and, above ₹25,000, the manager) signs off.** The employee does nothing manually.

## Business impact (estimates to validate in a pilot)

- **Employee time:** about 5 min per receipt drops to 0. For 15 receipts a month across 1,000 employees, that's roughly 1,250 hours saved a month.
- **Finance time:** the approver reviews a pre-investigated claim with evidence attached, instead of re-checking every line.
- **Fraud and leakage:** edited amounts, fake or mismatched GSTINs, double claims and over-cap spend are caught before payout.
- **Control:** the AI never pays anyone. Every approval has a named human and a complete audit trail, including AI overrides.
- **KPIs:** time from receipt to decision, flagged value, approver override rate, extraction accuracy (`npm run eval`).

## Architecture

```
public/                     Employee view (drop → live agent log → status) + Finance desk (approve/override)
src/server.js               Express API; SSE stream of Audit Agent events
src/extractor.js            Intake Agent: Claude vision/PDF structured extraction, local fallback, key check
src/localAI.js              Offline engine: Tesseract neural OCR (bundled model) + receipt parser
src/claim.js                Claim builder: trips, duplicates, purpose, policy caps
src/auditAgent.js           Audit Agent: Claude tool-use loop + offline rule-based agent, same tools
src/forensics.js            GSTIN checksum, OCR repair, EXIF/PDF editor traces, arithmetic reconciliation
src/financeAgent.js         Human approval step (final decision, overrides, audit trail)
src/mockFinance.js          Mock "FinanceHub" reimbursement system (claim history, approval queue)
src/policy.js               Policy as data: caps, categories, GL codes, FX
src/data/gst-registry.json  Mock GST registry for the synthetic vendors
```

**Design principle: agents investigate, rules compute, humans decide.** Claude reads the documents and runs the investigation. Money is calculated by plain, auditable code. Only a person can approve a payout.

## Run it

Requires Node 20+.

```bash
npm install
copy .env.example .env
npm start
```

Before `npm start`, open `.env` and paste a key: `GEMINI_API_KEY=...` or `ANTHROPIC_API_KEY=sk-ant-...`. The `.env` file is git-ignored, so the key is never committed.

Open the URL the terminal prints. If port 3000 is busy, it moves to 3001 automatically. The terminal and the top-bar badge show the engine:

- `● Live AI · Gemini` (or Claude): real-time mode. Upload any receipt.
- `AI engine: Local (offline)`: there's no key, or the key was rejected. Everything still works on the offline engine.

The app opens on a sign-in page with two separate portals (demo accounts, no password):

| Portal | URL | Who | What they see |
|---|---|---|---|
| Employee | `/employee` | Asha Verma | Drop receipts (Web or Chat mode), live agent activity, claim status |
| Finance | `/finance` | Priya Nair | Approval queue, Audit Agent evidence per bill, approve / override / reject, history |

To try it:

1. Open `/employee` in one window and `/finance` in another, side by side.
2. In the employee portal, drop your own receipts or click **Try 8 sample receipts**. Watch the agents work.
3. The claim appears in the finance queue automatically. Approve it there, and the employee portal updates on its own.

Other scripts:

```bash
npm run samples   # regenerate the synthetic receipts (Python + Pillow)
npm run eval      # live Claude extraction accuracy vs ground truth (needs API key)
```

Add `DEMO_TODAY=2026-10-11` to `.env` so the sample dates stay inside the 60-day submission window.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | multipart `files[]`: the Intake Agent reads them and the claim is built |
| `POST` | `/api/demo` | same, using the bundled synthetic samples |
| `GET` | `/api/submit/stream?sid=` | runs the Audit Agent; server-sent events: `agent`, `thought`, `tool`, `verdict`, `done` |
| `GET` | `/api/claim/status` | employee's claim status (pending approval / decided) |
| `GET` | `/api/finance/claims` | finance queue with agent recommendations and evidence |
| `POST` | `/api/finance/claims/:id/decide` | `{approver, action, lines, comment}`: the human decision (the only approval path) |
| `GET` | `/api/config` | active AI engine and Claude connection status |

State is held in memory; this is a prototype.

## Next steps

- Corporate-card feed matching (auto-attach transactions, flag missing receipts)
- WhatsApp / Teams intake on the same API
- Real GST portal lookup in place of the mock registry
- Persistent store, SSO, multi-level approval chains, and an ERP connector in place of FinanceHub
