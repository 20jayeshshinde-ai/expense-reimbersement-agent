import "./helpers.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateGstin, repairGstin, reconcile, editingTraces } from "../src/forensics.js";

describe("validateGstin", () => {
  test("accepts a GSTIN with a correct mod-36 check digit", () => {
    assert.deepEqual(validateGstin("27AAQCQ4821K1ZW"), { present: true, valid: true });
  });
  test("rejects a wrong check digit and says what it should be", () => {
    const r = validateGstin("27AAQCQ4821K1ZX");
    assert.equal(r.valid, false);
    assert.match(r.reason, /check digit should be W/);
  });
  test("rejects malformed values", () => {
    assert.equal(validateGstin("1234").valid, false);
    assert.match(validateGstin("27AAQCQ4821K1AW").reason, /format/);
  });
  test("rejects non-existent state codes", () => {
    assert.match(validateGstin("99AAQCQ4821K1ZW").reason, /state code 99/);
  });
  test("reports missing GSTIN as not present", () => {
    assert.deepEqual(validateGstin(null), { present: false });
  });
});

describe("repairGstin", () => {
  test("fixes common OCR letter/digit confusions by position", () => {
    // O→0 in the state code, 0→O in the PAN letters, I→1 in the PAN digits, trailing 2→Z
    assert.equal(repairGstin("2OAAQCQ482IK12W"), "20AAQCQ4821K1ZW");
  });
  test("leaves values of the wrong length untouched", () => {
    assert.equal(repairGstin("ABC"), "ABC");
  });
});

describe("reconcile", () => {
  test("ok when items + tax + charges equal the printed total", () => {
    const r = reconcile([
      { kind: "item", amount: 612 }, { kind: "charge", amount: 120 }, { kind: "tax", amount: 36.6 }, { kind: "charge", amount: 11.4 },
    ], 780);
    assert.equal(r.status, "ok");
  });
  test("uses the printed subtotal instead of summing items when present", () => {
    const r = reconcile([
      { kind: "item", amount: 1000 }, { kind: "subtotal", amount: 2940 }, { kind: "tax", amount: 147 }, { kind: "charge", amount: 153 },
    ], 3240);
    assert.equal(r.status, "ok");
  });
  test("flags an edited total (the tampered fuel bill)", () => {
    const r = reconcile([{ kind: "item", amount: 3386.5 }], 5386.5);
    assert.equal(r.status, "mismatch");
    assert.equal(r.diff, 2000);
  });
  test("tolerates rounding differences up to 1%", () => {
    assert.equal(reconcile([{ kind: "item", amount: 1000 }], 1008).status, "ok");
  });
  test("discounts are subtracted", () => {
    assert.equal(reconcile([{ kind: "item", amount: 500 }, { kind: "discount", amount: 100 }], 400).status, "ok");
  });
  test("not applicable without components", () => {
    assert.equal(reconcile([], 100).status, "na");
    assert.equal(reconcile(null, null).status, "na");
  });
});

describe("editingTraces", () => {
  test("detects an image-editor name in PDF/XMP metadata", () => {
    const pdf = Buffer.from("%PDF-1.4\n<< /Producer (Adobe Photoshop 25.0) >>\n%%EOF");
    assert.equal(editingTraces(pdf, "application/pdf").length, 1);
  });
  test("returns nothing for a clean file", () => {
    assert.deepEqual(editingTraces(Buffer.from("%PDF-1.4\n<< /Producer (Scanner Pro) >>"), "application/pdf"), []);
  });
});
