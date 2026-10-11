// Shared test setup: force the offline engine (no network, no API key) and a fixed "today".
process.env.GEMINI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.AI_PROVIDER = "none";
process.env.DEMO_TODAY = "2026-10-11";
process.env.AUDIT_STEP_DELAY_MS = "0";

// A fully-specified receipt as the extractors produce it (synthetic data).
export function receipt(overrides = {}) {
  return {
    document_type: "receipt",
    vendor: "Spice Route",
    date: "2026-09-15",
    time: "21:04",
    currency: "INR",
    total: 3240,
    tax: 147,
    category: "client_entertainment",
    city: "Bengaluru",
    invoice_number: "4471",
    payment_method: "Card",
    nights: null,
    alcohol_amount: null,
    attendees: 3,
    gstin: "29ABMFS6631Q1Z6",
    description: "Dinner",
    line_items: [{ description: "Paneer Tikka x2", amount: 640 }, { description: "Dal Makhani", amount: 380 }],
    // Printed rows add up to the printed total (2,940 + 147 + 153 = 3,240).
    amount_lines: [
      { label: "Paneer Tikka x2", amount: 640, kind: "item" },
      { label: "Dal Makhani", amount: 380, kind: "item" },
      { label: "Sub Total", amount: 2940, kind: "subtotal" },
      { label: "CGST + SGST", amount: 147, kind: "tax" },
      { label: "Service charge", amount: 153, kind: "charge" },
    ],
    visual_concerns: [],
    confidence: 0.95,
    low_confidence_fields: [],
    ...overrides,
  };
}

// Wrap one receipt as an extraction result, as extractDocument() returns it.
export function extraction(r, hash = Math.random().toString(36).slice(2)) {
  return { expenses: [r], notes: null, engine: "test", hash, mediaType: "image/jpeg", editingTraces: [], ms: 1 };
}
