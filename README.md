# ClaimPilot – Expense & Reimbursement Agent

An AI-native reimbursement assistant you use through chat. Drop in a pile of receipts (phone photos, scans, PDFs) and it does the claim work: reads each document, groups expenses into trips, checks the policy, catches duplicates, asks **only** the questions it can't answer itself, and hands a submission-ready claim to a (mock) finance system.

> All data in this repo is **synthetic**. Vendors, people, invoice numbers and the policy are made up. No company or personal data is used.

## The problem

Filing a reimbursement claim is slow, error-prone admin work:

| Manual step | Typical pain |
|---|---|
| Collect and photograph bills | Receipts get lost, photographed twice, or are unreadable |
| Type in vendor, date, amount, tax | ~3–6 min per receipt, with typos |
| Pick a category / GL code | Inconsistent, so finance has to recategorise |
| Check what's allowed | Employees don't know the hotel cap or the alcohol rule, and claims bounce back |
| Explain purpose and attendees | Asked again for every line item |
| Finance review | Reviewers re-check the same rules and hunt for duplicates by hand |

## What ClaimPilot does

1. **Understands messy documents.** Claude reads each photo or PDF (vision plus native PDF input) and returns schema-validated JSON: vendor, date, currency, total, tax, invoice no., payment method, category, city, nights, alcohol line items, cover count, line items, and per-field confidence. If a field is missing or illegible it comes back as `null`; the model is told never to guess.
2. **Groups expenses.** Flights, rail and hotels anchor a **trip** (for example "Trip to Bengaluru, 14–16 Sep"). Nearby-dated taxis and meals are attached to that trip. Everything else goes under "Local & other".
3. **Checks policy with deterministic rules.** These are coded rules, not LLM judgement: the submission window, metro and non-metro hotel nightly caps, meal and office-supply caps, the per-head entertainment cap, alcohol exclusion, FX conversion and the manager-approval threshold. The reimbursable amount is recalculated after every change.
4. **Catches duplicates** at three levels:
   - the same file uploaded twice
   - the same receipt photographed twice (matching vendor + invoice no., or vendor + date + amount)
   - a receipt **already reimbursed** in a previous claim, checked against the mock finance system's history
5. **Asks only the questions it needs:**
   - one *purpose* question per trip, not one per receipt
   - attendee count and names only where policy requires them
   - a field value only when it really couldn't be read
   - a yes/no for each suspected duplicate

   Answer by tapping a suggestion, or type one free-text message like *"trip was for the Contoso workshop, 3 of us at dinner with R. Mehta"*. Claude maps that message onto the open questions.
6. **Tracks status.** Every item is ✅ ready, ⚠️ review (policy adjustment or probable duplicate) or ⛔ blocked (missing data, already claimed, too old). A progress ring and a "N to go" button show how close the claim is to submittable.
7. **Submits** a clean payload (GL codes, reimbursable amounts, policy notes, receipt hashes for audit) to **FinanceHub**, a mock corporate reimbursement API. You get back a claim ID and an approval route.

### The demo set (7 synthetic receipts)

| File | What it demonstrates |
|---|---|
| `01_taxi_airport.jpg` | Tilted phone photo; cab to the airport, attached to the trip |
| `02_flight_bom_blr.pdf` | PDF e-ticket; anchors "Trip to Bengaluru" |
| `03_hotel_bengaluru.pdf` | ₹6,270/night against the ₹6,000 metro cap, so ₹540 is deducted automatically |
| `04_client_dinner.jpg` | Client entertainment: asks for attendees, ₹600 of beer is excluded |
| `05_taxi_airport_again.jpg` | Second photo of receipt 01, flagged as a probable duplicate |
| `06_stationery_no_date.jpg` | Date torn off: asks for just that one field |
| `07_coffee_already_claimed.jpg` | Already paid in claim `EXP-2026-0412`, so it's blocked |

Result: **7 receipts → 7 one-tap questions → ₹23,020 ready to submit** (₹3,400 correctly not reimbursed).

## Business impact (estimates to validate in a pilot)

- **Employee time:** about 5–6 min per receipt drops to under 1 min. For 15 receipts a month across 1,000 travelling employees, that is roughly **1,250 hours saved a month**. The UI shows a running "min saved" counter.
- **First-time-right claims:** policy is applied *before* submission, so fewer claims bounce back from finance.
- **Leakage prevention:** cross-claim duplicate detection and automatic cap and alcohol deductions stop over-payment before it happens.
- **Finance review effort:** every line arrives categorised with a GL code, a purpose, attendees, policy notes and a receipt hash, so reviewers handle exceptions instead of re-checking every line.
- **KPIs to track:** time from first upload to submit, questions per claim, extraction field accuracy (`npm run eval`), bounce-back rate, duplicate and over-cap value caught.

## Architecture

```
Browser (chat + live claim board)          public/
   │  drag-drop / paste / pick files
   ▼
Express API                                src/server.js
   ├─ Extractor (Claude vision + PDF)      src/extractor.js   → schema-validated JSON (Zod structured outputs)
   ├─ Chat interpreter (Claude)            src/extractor.js   → free text → field updates on open questions
   ├─ Claim engine (deterministic)         src/claim.js       → grouping, duplicates, policy, questions, readiness
   ├─ Policy as data                       src/policy.js      → caps, categories, GL codes, FX (mock)
   └─ FinanceHub mock                      src/mockFinance.js → claim history + submit endpoint
```

**Design principle: the AI reads, the rules decide.** The LLM does perception: turning pixels into fields and free text into answers. Compliance, amounts and readiness are computed by plain, auditable code. That keeps decisions explainable and lets finance change the policy without touching prompts.

Model: `claude-opus-5-5` by default (override with `CLAUDE_MODEL`). Extraction uses structured outputs (`output_config.format`) at low effort for speed, with server-side refusal fallback turned on.

## Run it

Requires Node 20+.

```bash
npm install
npm start
```

Open http://localhost:3000 and click **Try with 7 sample receipts**, or drop your own files.

- **Offline demo mode (default, no key):** the bundled samples are recognised from their SHA-256 hash against `samples/ground-truth.json`. This mode doesn't call the AI, so the full flow can be demoed with no network or key. Any other file comes back as an empty item, and the assistant asks you for the details.
- **Live AI mode:** set `ANTHROPIC_API_KEY` (see `.env.example`). Any receipt you upload is then read by Claude, and free-text chat answers are understood.

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Other scripts:

```bash
npm run samples   # regenerate the synthetic receipts (needs Python + Pillow)
npm run eval      # live extraction accuracy vs ground truth (needs API key)
```

Set `DEMO_TODAY=2026-10-11` to pin "today" so the 60-day submission-window check gives reproducible results with the sample dates.

## API (for integration)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | multipart `files[]`: extract and add to the claim |
| `POST` | `/api/demo` | load the bundled synthetic samples |
| `GET` | `/api/claim` | full evaluated claim state (items, groups, questions, totals, readiness) |
| `POST` | `/api/answer` | `{target, field, value}`: answer a question or edit a field |
| `POST` | `/api/chat` | `{message}`: free-text answer, interpreted by Claude |
| `POST` | `/api/submit` | submit to the mock FinanceHub (only when ready) |
| `GET` | `/api/finance/claims` | mock finance system's claim list |

Each browser tab sends an `x-session` header, so its claim is isolated. State is in memory: this is a prototype.

## Next steps

- Corporate-card feed matching (auto-attach card transactions, flag missing receipts)
- WhatsApp / Teams bot front-end on the same API
- Per-grade policy, multi-currency per diems, mileage from maps
- Persistent store, SSO, manager approval UI, and a real ERP connector in place of FinanceHub
