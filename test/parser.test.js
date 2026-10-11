import "./helpers.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseReceipt, findDates, pickDate, pickTime, pickVendor, classifyLine } from "../src/localAI.js";

// OCR text exactly as the offline engine produced it for the synthetic dinner receipt.
const DINNER = `SPICE ROUTE
Indiranagar, Bengaluru
sae LE
Bill No: 4471 Table 12 Covers: 3
15/09/2026 21:04
Paneer Tikka x2 640.00
Dal Makhani 380.00
Butter Naan x6 360.00
Veg Biryani x2 720.00
Craft Beer x3 600.00
Fresh Lime Soda x2 240.00
Sub Total 2,940.00
CGST 2.5% + SGST 2.5% 147.00
Service charge 153.00
GRAND TOTAL INR 3,240.00
Card **** 4421
GSTIN 29ABMFS6631Q126`;

const FLIGHT = `SkyJet Airways
E-Ticket & Tax Invoice
Invoice No: SJ-INV-2026-551902
Booking date: 02 Sep 2026
Flight SJ 517 BOM -> BLR
Travel date: 14 Sep 2026 08:40
Base fare INR 5,320.00
Airport charges INR 820.00
GST INR 310.00
TOTAL INR 6,450.00
Paid by Corporate Card **** 4421`;

const HOTEL = `Hotel Orchid Residency
MG Road, Bengaluru
Folio / Invoice: HOR/26/09/3381
Check-in: 14 Sep 2026 Check-out: 16 Sep 2026
Nights: 2 Room: Deluxe King
Room 2 x 6,270.00 INR 12,540.00
GST 18% on room INR 2,257.20
TOTAL INR 14,800.00`;

describe("parseReceipt – restaurant bill", () => {
  const r = parseReceipt(DINNER);
  test("vendor, date, time, bill no.", () => {
    assert.equal(r.vendor, "Spice Route");
    assert.equal(r.date, "2026-09-15");
    assert.equal(r.time, "21:04");
    assert.equal(r.invoice_number, "4471");
  });
  test("grand total, tax and payment method", () => {
    assert.equal(r.total, 3240);
    assert.equal(r.tax, 147);
    assert.equal(r.payment_method, "Card");
  });
  test("covers + alcohol → client entertainment with the beer amount isolated", () => {
    assert.equal(r.category, "client_entertainment");
    assert.equal(r.attendees, 3);
    assert.equal(r.alcohol_amount, 600);
  });
  test("menu lines become line items", () => {
    assert.equal(r.line_items.length, 6);
    assert.deepEqual(r.line_items[0], { description: "Paneer Tikka x2", amount: 640 });
  });
  test("GSTIN OCR errors are repaired (126 → 1Z6)", () => {
    assert.equal(r.gstin, "29ABMFS6631Q1Z6");
  });
  test("city detected", () => assert.equal(r.city, "Bengaluru"));
});

describe("parseReceipt – flight and hotel", () => {
  test("flight: travel date beats booking date, destination city from route", () => {
    const r = parseReceipt(FLIGHT);
    assert.equal(r.category, "travel_air");
    assert.equal(r.date, "2026-09-14");
    assert.equal(r.city, "Bengaluru");
    assert.equal(r.total, 6450);
    assert.equal(r.invoice_number, "SJ-INV-2026-551902");
  });
  test("hotel: check-out date, nights and total", () => {
    const r = parseReceipt(HOTEL);
    assert.equal(r.category, "hotel");
    assert.equal(r.date, "2026-09-16");
    assert.equal(r.nights, 2);
    assert.equal(r.total, 14800);
  });
});

describe("parseReceipt – missing data is reported, never invented", () => {
  test("blank date stays null and lowers confidence", () => {
    const r = parseReceipt("Stationery Mart\nCash Memo 00912\nDate:\nA4 Paper Ream x2 560.00\nTOTAL INR 560.00\nCash");
    assert.equal(r.date, null);
    assert.ok(r.low_confidence_fields.includes("date"));
    assert.ok(r.confidence < 0.9);
  });
  test("no printed total → derived from components", () => {
    const r = parseReceipt("Corner Shop\n12/09/2026\nPens 100.00\nGST 18.00");
    assert.equal(r.total, 118);
  });
});

describe("date / time / vendor helpers", () => {
  test("findDates handles DD/MM/YYYY, '14 Sep 2026', 'Sep 14, 2026' and ISO", () => {
    assert.equal(findDates("15/09/2026")[0].iso, "2026-09-15");
    assert.equal(findDates("14 Sep 2026")[0].iso, "2026-09-14");
    assert.equal(findDates("Sep 14, 2026")[0].iso, "2026-09-14");
    assert.equal(findDates("2026-09-03")[0].iso, "2026-09-03");
  });
  test("findDates swaps to MM/DD only when DD/MM is impossible", () => {
    assert.equal(findDates("09/25/2026")[0].iso, "2026-09-25");
  });
  test("pickDate prefers check-out over check-in", () => {
    assert.equal(pickDate(["Check-in: 14 Sep 2026 Check-out: 16 Sep 2026"]).date, "2026-09-16");
  });
  test("pickTime reads 24h and 12h clocks but not prices", () => {
    assert.equal(pickTime("15/09/2026 21:04"), "21:04");
    assert.equal(pickTime("Paid 9:15 PM"), "21:15");
    assert.equal(pickTime("12:05 am"), "00:05");
    assert.equal(pickTime("Total 640.00"), null);
  });
  test("pickVendor skips headers like 'Tax Invoice'", () => {
    assert.equal(pickVendor(["Tax Invoice", "BREW BROS CAFE", "BKC"]), "Brew Bros Cafe");
  });
  test("classifyLine distinguishes totals, subtotals, taxes, charges and items", () => {
    assert.equal(classifyLine("GRAND TOTAL INR 3,240.00"), "total");
    assert.equal(classifyLine("Sub Total 2,940.00"), "subtotal");
    assert.equal(classifyLine("CGST 2.5% 73.50"), "tax");
    assert.equal(classifyLine("Service charge 153.00"), "charge");
    assert.equal(classifyLine("Paneer Tikka x2 640.00"), "item");
    assert.equal(classifyLine("GSTIN 29ABMFS6631Q1Z6"), null);
  });
});
