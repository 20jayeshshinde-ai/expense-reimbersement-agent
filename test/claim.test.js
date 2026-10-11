import { receipt, extraction } from "./helpers.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClaim, addExtraction, evaluate, buildSubmission, duplicateReport } from "../src/claim.js";
import { resetFinance } from "../src/mockFinance.js";

beforeEach(() => resetFinance());

function claimWith(...receipts) {
  const c = createClaim();
  receipts.forEach((r, i) => addExtraction(c, r.file || `r${i}.jpg`, extraction(r, r.hash)));
  return c;
}

const flight = receipt({ vendor: "SkyJet Airways", category: "travel_air", city: "Bengaluru", date: "2026-09-14", time: "08:40", total: 6450, tax: 310, invoice_number: "SJ-1", attendees: null, line_items: [], amount_lines: [] });
const hotel = receipt({ vendor: "Hotel Orchid", category: "hotel", city: "Bengaluru", date: "2026-09-16", time: null, nights: 2, total: 14800, tax: 2257, invoice_number: "HOR-1", attendees: null, line_items: [], amount_lines: [] });
const cab = receipt({ vendor: "QuickRide Cabs", category: "taxi_rideshare", city: "Mumbai", date: "2026-09-14", time: "06:12", total: 780, tax: 36.6, invoice_number: "QR-1", attendees: null, line_items: [{ description: "Base fare", amount: 612 }] });

describe("adding extractions", () => {
  test("non-expense documents are skipped", () => {
    const c = createClaim();
    addExtraction(c, "selfie.jpg", extraction({ document_type: "not_an_expense" }));
    assert.equal(c.items.length, 0);
    assert.equal(c.docs.length, 1);
  });
  test("currency is normalised to upper case and defaults to INR", () => {
    const c = claimWith(receipt({ currency: "usd" }), receipt({ currency: null, invoice_number: "9" }));
    assert.deepEqual(c.items.map((i) => i.currency), ["USD", "INR"]);
  });
});

describe("trip grouping and purpose", () => {
  test("flight + hotel form a trip; a same-day airport cab at home joins it", () => {
    const s = evaluate(claimWith(flight, hotel, cab));
    const trip = s.groups.find((g) => g.kind === "trip");
    assert.equal(trip.title, "Trip to Bengaluru");
    assert.equal(trip.start, "2026-09-14");
    assert.equal(trip.end, "2026-09-16");
    assert.equal(s.items.filter((i) => i.groupId === trip.id).length, 3);
  });
  test("purpose is inferred automatically (client visit when there is entertainment)", () => {
    const s = evaluate(claimWith(flight, receipt()));
    assert.equal(s.items[0].purpose, "Client visit – Bengaluru");
  });
  test("expenses outside any trip land in local expenses", () => {
    const s = evaluate(claimWith(receipt({ vendor: "Stationery Mart", category: "office_supplies", date: "2026-10-01", city: "Mumbai", total: 500 })));
    assert.equal(s.groups[0].id, "grp_local");
  });
});

describe("policy", () => {
  test("hotel over the metro nightly cap is reduced to the cap", () => {
    const [i] = evaluate(claimWith(hotel)).items;
    assert.equal(i.reimbursable, 12000);
    assert.match(i.adjustments[0].text, /Hotel cap ₹6,000\/night/);
  });
  test("non-metro hotels use the lower cap", () => {
    const [i] = evaluate(claimWith({ ...hotel, city: "Nashik" })).items;
    assert.equal(i.reimbursable, 8000);
  });
  test("alcohol is deducted", () => {
    const [i] = evaluate(claimWith(receipt({ alcohol_amount: 600 }))).items;
    assert.equal(i.reimbursable, 2640);
  });
  test("meals are capped per receipt", () => {
    const [i] = evaluate(claimWith(receipt({ category: "meals", total: 1800, attendees: null }))).items;
    assert.equal(i.reimbursable, 1000);
  });
  test("entertainment is capped per head", () => {
    const [i] = evaluate(claimWith(receipt({ total: 6000, attendees: 2 }))).items;
    assert.equal(i.reimbursable, 3000);
  });
  test("foreign currency is converted to INR", () => {
    const [i] = evaluate(claimWith(receipt({ currency: "USD", total: 10, category: "other", attendees: null }))).items;
    assert.equal(i.amountInr, 832);
  });
});

describe("duplicates – removed only when every detail matches", () => {
  test("identical re-photographed receipt is held back and reported to the employee", () => {
    const c = claimWith({ ...cab, file: "a.jpg", hash: "h1" }, { ...cab, file: "b.jpg", hash: "h2" });
    const s = evaluate(c);
    assert.equal(s.totals.items, 1);
    assert.equal(s.totals.removed, 1);
    const [d] = duplicateReport(c);
    assert.equal(d.file, "b.jpg");
    assert.equal(d.kind, "identical");
    assert.equal(d.original.file, "a.jpg");
  });
  test("same file uploaded twice is held back", () => {
    const s = evaluate(claimWith({ ...cab, hash: "same" }, { ...cab, hash: "same" }));
    assert.equal(s.totals.removed, 1);
  });
  test("same place, day and amount but different menu/time/bill no. is KEPT and flagged", () => {
    const lunch = receipt({ time: "13:22", invoice_number: "4398", line_items: [{ description: "Veg Thali x3", amount: 1020 }] });
    const s = evaluate(claimWith(receipt(), lunch));
    assert.equal(s.totals.items, 2);
    assert.equal(s.totals.removed, 0);
    assert.match(s.items[1].possibleDuplicate.reason, /kept for review/);
  });
  test("a bill already paid in an earlier claim is held back as already claimed", () => {
    const coffee = receipt({ vendor: "Brew Bros Cafe", date: "2026-09-03", time: "16:45", invoice_number: "A-2231", total: 420, tax: null, category: "meals", attendees: null, line_items: [{ description: "Cappuccino x2", amount: 360 }, { description: "Banana Bread", amount: 60 }] });
    const c = claimWith(coffee);
    evaluate(c);
    const [d] = duplicateReport(c);
    assert.equal(d.kind, "already_claimed");
    assert.match(d.reason, /EXP-2026-0412/);
    assert.match(d.original.where, /EXP-2026-0412 \(paid\)/);
  });
});

describe("submission sent to finance", () => {
  test("contains only genuine bills – never duplicates", () => {
    const c = claimWith({ ...cab, hash: "h1" }, { ...cab, hash: "h2" }, flight);
    const sub = buildSubmission(c);
    assert.equal(sub.lines.length, 2);
    assert.equal(sub.removed, undefined);
  });
  test("each line carries GL code, purpose, eligible amount and evidence", () => {
    const [line] = buildSubmission(claimWith(hotel)).lines;
    assert.equal(line.glCode, "6120");
    assert.equal(line.eligibleInr, 12000);
    assert.ok(line.purpose);
    assert.ok(Array.isArray(line.adjustments));
  });
});
