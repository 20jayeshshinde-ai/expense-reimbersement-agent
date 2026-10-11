import { receipt } from "./helpers.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareReceipts } from "../src/duplicates.js";

const original = { ...receipt(), fileHash: "orig" };

describe("compareReceipts – strict duplicate rule", () => {
  test("same file is an exact duplicate", () => {
    assert.equal(compareReceipts({ ...receipt(), fileHash: "orig" }, original, "a.jpg").kind, "exact_file");
  });

  test("a re-photographed copy with every detail equal is identical", () => {
    const r = compareReceipts({ ...receipt(), fileHash: "photo2" }, original, "a.jpg");
    assert.equal(r.kind, "identical");
    assert.deepEqual(r.differs, []);
  });

  test("vendor name match ignores case and punctuation", () => {
    assert.equal(compareReceipts({ ...receipt({ vendor: "SPICE ROUTE." }), fileHash: "x" }, original, "a").kind, "identical");
  });

  test("line items are compared regardless of order", () => {
    const swapped = receipt({ line_items: [...receipt().line_items].reverse() });
    assert.equal(compareReceipts({ ...swapped, fileHash: "x" }, original, "a").kind, "identical");
  });

  for (const [field, change] of [
    ["time", { time: "13:22" }],
    ["bill / invoice no.", { invoice_number: "4398" }],
    ["items & costs", { line_items: [{ description: "Veg Thali x3", amount: 1020 }] }],
    ["tax", { tax: 150 }],
  ]) {
    test(`different ${field} → only a possible duplicate, never removed`, () => {
      const r = compareReceipts({ ...receipt(change), fileHash: "x" }, original, "a");
      assert.equal(r.kind, "possible");
      assert.ok(r.differs.includes(field), `differs should include ${field}`);
      assert.match(r.reason, /kept for review/);
    });
  }

  test("a single changed item cost is not identical", () => {
    const items = [{ description: "Paneer Tikka x2", amount: 650 }, { description: "Dal Makhani", amount: 370 }];
    assert.equal(compareReceipts({ ...receipt({ line_items: items }), fileHash: "x" }, original, "a").kind, "possible");
  });

  test("different total or vendor or date → not a duplicate at all", () => {
    assert.equal(compareReceipts({ ...receipt({ total: 3250 }), fileHash: "x" }, original, "a"), null);
    assert.equal(compareReceipts({ ...receipt({ vendor: "Brew Bros" }), fileHash: "x" }, original, "a"), null);
    assert.equal(compareReceipts({ ...receipt({ date: "2026-09-16" }), fileHash: "x" }, original, "a"), null);
  });

  test("missing vendor or total never counts as identical", () => {
    const blank = { ...receipt({ vendor: null }), fileHash: "x" };
    assert.notEqual(compareReceipts(blank, { ...blank, fileHash: "y" }, "a")?.kind, "identical");
  });

  test("accepts submission-line field names (invoiceNumber, lineItems, amount→total)", () => {
    const line = { vendor: "Spice Route", date: "2026-09-15", time: "21:04", invoiceNumber: "4471", currency: "INR", total: 3240, tax: 147, lineItems: receipt().line_items, fileHash: "z" };
    assert.equal(compareReceipts(line, original, "claim X").kind, "identical");
  });
});
