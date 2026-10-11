# Demo video script (≈ 4–5 minutes)

**Before recording**
- Run `npm start` and check that the terminal shows `AI engine: Gemini ✔`.
- Wait 1 minute after any earlier run (free-tier quota).
- Open two browser windows side by side:
  - left: `http://localhost:3000/employee` (or the port printed in the terminal)
  - right: `http://localhost:3000/finance`
- Zoom the browser to about 90% so cards fit.
- Use a screen recorder such as OBS or Xbox Game Bar (Win + G), then upload to YouTube as **Unlisted** or **Public**.

---

### 0:00 – 0:30 · The problem
*Show the sign-in page.*

> "Every month employees spend hours collecting bills, typing in vendors and amounts, picking categories and guessing the policy. Then finance re-checks every line, and edited bills and double claims still slip through. ClaimPilot fixes both sides with AI agents and a human in control."

Click **Continue as employee**.

### 0:30 – 1:45 · Employee drops a pile of receipts (Web mode)
- Point at the sidebar: *"Four AI agents work for the employee: Intake, Claim Builder, Audit and Chat. The badge shows Live AI."*
- Click **✨ Try 9 sample receipts**, or drag the files from `samples/`. Mention that they're synthetic.
- While it runs:
  - *"The Intake Agent reads photos and scanned PDFs with vision AI: vendor, date, time, GST number, every line item."*
  - *"The Claim Builder groups them into a Bengaluru trip, fills in purpose and GL codes, and applies the policy. No questions for the employee."*
  - *"Now the Audit Agent investigates every bill. It picks its own checks: GST registry, arithmetic, tampering, claim history, policy. You can watch every tool call live."*
- On the result screen:
  - *"Submitted in about 40 seconds with zero typing."*
  - Scroll to **Duplicate tickets**: *"The taxi receipt was photographed twice. Every detail matches, so it's held back. The coffee bill was already paid in an earlier claim. The employee sees exactly why, side by side, and these never reach finance."*
  - Open the **Highway Fuels** bill: *"Tampered: the line items add up to ₹3,387 but the total says ₹5,387, the GSTIN check digit is wrong, and the file was saved in Photoshop. Three independent signals."*
  - Open the **second Spice Route** bill: *"Same restaurant, same day, same amount, but a different time, bill number and menu. That's a real second meal, so it's kept and only flagged for review. We never remove a receipt unless everything matches."*
  - Point at the hotel: *"Hotel over the ₹6,000 metro cap: the extra ₹2,800 is deducted automatically. Beer at the client dinner is deducted too."*

### 1:45 – 2:30 · Chat mode
- Toggle **💬 Chat**.
- Ask: **"why was my fuel bill rejected?"** → the AI answers with the evidence.
- Ask: **"how much will I get?"**
- *"Same agents, same claim, a familiar chat interface. Employees can also attach receipts right here."*

### 2:30 – 3:45 · Finance approver
*Switch to the right window (Finance portal; the claim has already appeared in the queue).*
- *"Finance gets a separate portal. The claim arrived automatically, pre-investigated."*
- Show the KPI cards and the Audit Agent summary.
- Open a flagged bill: *"Every bill has evidence: authenticity score, each check, and the receipt image."*
- Toggle one bill (e.g. approve the undated stationery bill): *"The approver can override any AI recommendation. The total updates live."*
- Type a comment, then click **Approve**: *"Only a human can approve money. Every decision is signed and recorded."*
- Open **History**.

### 3:45 – 4:15 · Employee sees the decision
*Back to the left window.* It has already updated to **Approved (partially) by Priya Nair**, with the comment.

### 4:15 – 4:45 · Under the hood
Show `docs/TECHNICAL_DESIGN.md` (architecture diagram) and run `npm test` in a terminal:

> "Gemini vision with JSON-schema outputs, a function-calling audit agent, deterministic forensics and policy, and an offline fallback with neural OCR. If the AI is unavailable, it still works. 92 automated tests, all passing."

### 4:45 – 5:00 · Impact
> "From a pile of receipts to an approval-ready claim in under a minute. Zero typing for employees, pre-investigated claims for finance, and fraud caught before payout. That's ClaimPilot."
