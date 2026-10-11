// Mock corporate expense policy (fictional "Acme Corp" India policy). All amounts in INR.
// Kept as data so finance teams could edit it without touching engine code.

export const BASE_CURRENCY = "INR";

// Mock FX rates to INR, used when a receipt is in a foreign currency.
export const FX_TO_INR = { INR: 1, USD: 83.2, EUR: 90.1, GBP: 105.4, AED: 22.65, SGD: 61.9 };

export const CATEGORIES = {
  travel_air: { label: "Airfare", icon: "✈️", glCode: "6110" },
  travel_rail: { label: "Rail / Bus", icon: "🚆", glCode: "6111" },
  taxi_rideshare: { label: "Taxi / Rideshare", icon: "🚕", glCode: "6112" },
  fuel_mileage: { label: "Fuel / Mileage", icon: "⛽", glCode: "6113" },
  hotel: { label: "Hotel / Lodging", icon: "🏨", glCode: "6120" },
  meals: { label: "Meals (self)", icon: "🍽️", glCode: "6130" },
  client_entertainment: { label: "Client entertainment", icon: "🥂", glCode: "6140" },
  office_supplies: { label: "Office supplies", icon: "📎", glCode: "6210" },
  software_subscriptions: { label: "Software / Subscriptions", icon: "💻", glCode: "6220" },
  phone_internet: { label: "Phone / Internet", icon: "📶", glCode: "6230" },
  training: { label: "Training / Conferences", icon: "🎓", glCode: "6310" },
  other: { label: "Other", icon: "🧾", glCode: "6999" },
};

export const TRAVEL_ANCHORS = new Set(["travel_air", "travel_rail", "hotel"]);

export const POLICY = {
  name: "Acme Corp Travel & Expense Policy v3.2 (mock)",
  submissionWindowDays: 60,
  hotelNightlyCap: { metro: 6000, other: 4000 },
  metroCities: ["mumbai", "delhi", "new delhi", "bengaluru", "bangalore", "chennai", "hyderabad", "kolkata", "pune", "gurugram", "noida"],
  mealsPerReceiptCap: 1000,
  entertainmentPerHeadCap: 1500,
  officeSuppliesCap: 2000,
  alcoholReimbursable: false,
  // Categories where the employee must state a business purpose (asked once per trip / group).
  purposeRequired: new Set(["client_entertainment", "office_supplies", "software_subscriptions", "training", "other", "travel_air", "hotel"]),
  attendeesRequired: new Set(["client_entertainment"]),
  managerApprovalAbove: 25000,
};

export const POLICY_SUMMARY = [
  `Submit within ${POLICY.submissionWindowDays} days of the expense date.`,
  `Hotels: up to ₹${POLICY.hotelNightlyCap.metro.toLocaleString("en-IN")}/night in metro cities, ₹${POLICY.hotelNightlyCap.other.toLocaleString("en-IN")}/night elsewhere.`,
  `Meals (self): up to ₹${POLICY.mealsPerReceiptCap.toLocaleString("en-IN")} per receipt.`,
  `Client entertainment: up to ₹${POLICY.entertainmentPerHeadCap.toLocaleString("en-IN")} per head; attendees and purpose required; alcohol not reimbursable.`,
  `Office supplies: up to ₹${POLICY.officeSuppliesCap.toLocaleString("en-IN")} per receipt with a business purpose.`,
  `Claims above ₹${POLICY.managerApprovalAbove.toLocaleString("en-IN")} route to manager approval.`,
];

export function isMetro(city) {
  return !!city && POLICY.metroCities.some((m) => city.toLowerCase().includes(m));
}
