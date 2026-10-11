"""Generate SYNTHETIC sample receipts (fictional vendors, dummy data) for demos.

Writes PNG/PDF receipts into samples/ plus samples/ground-truth.json, which the
offline demo extractor uses (keyed by SHA-256) when no ANTHROPIC_API_KEY is set.

    python scripts/make_samples.py
"""
import hashlib
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "samples"
OUT.mkdir(exist_ok=True)
random.seed(7)


def font(size, bold=False):
    for name in (["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def receipt_image(lines, width=620, paper=(250, 248, 240)):
    """lines: list of (text, size, bold, align) tuples."""
    height = 80 + sum(s + 14 for _, s, _, _ in lines)
    img = Image.new("RGB", (width, height), paper)
    d = ImageDraw.Draw(img)
    y = 40
    for text, size, bold, align in lines:
        f = font(size, bold)
        if "\t" in text:  # left \t right
            left, right = text.split("\t")
            d.text((40, y), left, font=f, fill=(30, 30, 30))
            w = d.textlength(right, font=f)
            d.text((width - 40 - w, y), right, font=f, fill=(30, 30, 30))
        else:
            w = d.textlength(text, font=f)
            x = (width - w) / 2 if align == "c" else 40
            d.text((x, y), text, font=f, fill=(30, 30, 30))
        y += size + 14
    return img


def photo(img, angle, blur=0.6, bg=(120, 110, 100)):
    """Make a receipt look like a phone photo: rotation, background, blur, noise."""
    canvas = Image.new("RGB", (img.width + 160, img.height + 160), bg)
    canvas.paste(img, (80, 80))
    canvas = canvas.rotate(angle, expand=True, fillcolor=bg, resample=Image.BICUBIC)
    px = canvas.load()
    for _ in range(canvas.width * canvas.height // 40):
        x, y = random.randrange(canvas.width), random.randrange(canvas.height)
        r, g, b = px[x, y]
        n = random.randint(-18, 18)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return canvas.filter(ImageFilter.GaussianBlur(blur))


L = lambda t, s=22, b=False, a="l": (t, s, b, a)  # noqa: E731
SEP = L("-" * 52, 18)

samples = []


def save(name, img, truth, pdf=False):
    path = OUT / name
    if pdf:
        img.save(path, "PDF", resolution=110)
    else:
        img.save(path, quality=88)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    samples.append({"file": name, "sha256": sha, **truth})


# 1. Taxi to airport (Mumbai) - photo
taxi = receipt_image([
    L("QuickRide Cabs", 34, True, "c"), L("Trip Invoice", 22, False, "c"), SEP,
    L("Invoice No: QR-88213-MUM"), L("Date: 14 Sep 2026  06:12"),
    L("From: Andheri West, Mumbai"), L("To: Chhatrapati Shivaji Intl Airport T2"), SEP,
    L("Base fare\tINR 612.00"), L("Airport fee\tINR 120.00"), L("GST 5%\tINR 36.60"),
    L("Rounding\tINR 11.40"), SEP, L("TOTAL PAID\tINR 780.00", 26, True),
    L("Paid via UPI"), L("GSTIN 27AAAQR0000Z1Z5", 18),
])
save("01_taxi_airport.jpg", photo(taxi, 1.6), {
    "document_type": "receipt", "vendor": "QuickRide Cabs", "date": "2026-09-14", "currency": "INR",
    "total": 780, "tax": 36.6, "category": "taxi_rideshare", "city": "Mumbai",
    "invoice_number": "QR-88213-MUM", "payment_method": "UPI", "nights": None, "alcohol_amount": None,
    "attendees": None, "description": "Cab from Andheri West to Mumbai airport T2",
    "line_items": [{"description": "Base fare", "amount": 612}, {"description": "Airport fee", "amount": 120}],
    "confidence": 0.95, "low_confidence_fields": [],
})

# 2. Flight e-ticket (PDF)
flight = receipt_image([
    L("SkyJet Airways", 36, True, "c"), L("E-Ticket & Tax Invoice", 22, False, "c"), SEP,
    L("Invoice No: SJ-INV-2026-551902"), L("Booking date: 02 Sep 2026"),
    L("Passenger: ASHA VERMA (synthetic)"), L("Flight SJ 517  BOM -> BLR"), L("Travel date: 14 Sep 2026  08:40"), SEP,
    L("Base fare\tINR 5,320.00"), L("Airport charges\tINR 820.00"), L("GST\tINR 310.00"), SEP,
    L("TOTAL\tINR 6,450.00", 26, True), L("Paid by Corporate Card **** 4421"),
], width=760, paper=(255, 255, 255))
save("02_flight_bom_blr.pdf", flight, {
    "document_type": "invoice", "vendor": "SkyJet Airways", "date": "2026-09-14", "currency": "INR",
    "total": 6450, "tax": 310, "category": "travel_air", "city": "Bengaluru",
    "invoice_number": "SJ-INV-2026-551902", "payment_method": "Card", "nights": None, "alcohol_amount": None,
    "attendees": None, "description": "Flight SJ 517 Mumbai to Bengaluru",
    "line_items": [{"description": "Base fare", "amount": 5320}, {"description": "Airport charges", "amount": 820}],
    "confidence": 0.97, "low_confidence_fields": [],
}, pdf=True)

# 3. Hotel folio (PDF) - over the per-night cap
hotel = receipt_image([
    L("Hotel Orchid Residency", 34, True, "c"), L("MG Road, Bengaluru", 20, False, "c"), SEP,
    L("Folio / Invoice: HOR/26/09/3381"), L("Guest: Asha Verma (synthetic)"),
    L("Check-in: 14 Sep 2026   Check-out: 16 Sep 2026"), L("Nights: 2   Room: Deluxe King"), SEP,
    L("Room 2 x 6,270.00\tINR 12,540.00"), L("GST 18% on room\tINR 2,257.20"), L("Rounding\tINR 2.80"), SEP,
    L("TOTAL\tINR 14,800.00", 26, True), L("Settled: Card **** 4421"), L("GSTIN 29AAAHO0000H1Z2", 18),
], width=760, paper=(255, 255, 255))
save("03_hotel_bengaluru.pdf", hotel, {
    "document_type": "invoice", "vendor": "Hotel Orchid Residency", "date": "2026-09-16", "currency": "INR",
    "total": 14800, "tax": 2257.2, "category": "hotel", "city": "Bengaluru",
    "invoice_number": "HOR/26/09/3381", "payment_method": "Card", "nights": 2, "alcohol_amount": None,
    "attendees": None, "description": "2 nights, Deluxe King, 14-16 Sep",
    "line_items": [{"description": "Room x2 nights", "amount": 12540}],
    "confidence": 0.96, "low_confidence_fields": [],
}, pdf=True)

# 4. Client dinner with alcohol - photo, needs attendees
dinner = receipt_image([
    L("SPICE ROUTE", 34, True, "c"), L("Indiranagar, Bengaluru", 20, False, "c"), SEP,
    L("Bill No: 4471   Table 12   Covers: 3"), L("15/09/2026  21:04"), SEP,
    L("Paneer Tikka x2\t640.00"), L("Dal Makhani\t380.00"), L("Butter Naan x6\t360.00"),
    L("Veg Biryani x2\t720.00"), L("Craft Beer x3\t600.00"), L("Fresh Lime Soda x2\t240.00"), SEP,
    L("Sub Total\t2,940.00"), L("CGST 2.5% + SGST 2.5%\t147.00"), L("Service charge\t153.00"), SEP,
    L("GRAND TOTAL\tINR 3,240.00", 26, True), L("Card **** 4421"),
])
save("04_client_dinner.jpg", photo(dinner, -1.4, blur=0.8), {
    "document_type": "receipt", "vendor": "Spice Route", "date": "2026-09-15", "currency": "INR",
    "total": 3240, "tax": 147, "category": "client_entertainment", "city": "Bengaluru",
    "invoice_number": "4471", "payment_method": "Card", "nights": None, "alcohol_amount": 600,
    "attendees": None, "description": "Dinner for 3 covers incl. 3 craft beers",
    "line_items": [{"description": "Food & soft drinks", "amount": 2340}, {"description": "Craft Beer x3", "amount": 600}],
    "confidence": 0.88, "low_confidence_fields": [],
})

# 5. Same taxi receipt photographed again (different file, same expense) -> probable duplicate
save("05_taxi_airport_again.jpg", photo(taxi, -1.2, blur=1.0, bg=(90, 95, 105)), {
    "document_type": "receipt", "vendor": "QuickRide Cabs", "date": "2026-09-14", "currency": "INR",
    "total": 780, "tax": 36.6, "category": "taxi_rideshare", "city": "Mumbai",
    "invoice_number": "QR-88213-MUM", "payment_method": "UPI", "nights": None, "alcohol_amount": None,
    "attendees": None, "description": "Cab from Andheri West to Mumbai airport T2",
    "line_items": [], "confidence": 0.9, "low_confidence_fields": [],
})

# 6. Stationery receipt with the date torn off -> missing date
stationery = receipt_image([
    L("Stationery Mart", 32, True, "c"), L("Lower Parel, Mumbai", 20, False, "c"), SEP,
    L("Cash Memo 00912"), L("Date: ____________"), SEP,
    L("A4 Paper Ream x2\t560.00"), L("Whiteboard Markers\t240.00"), L("Spiral Notebooks x5\t350.00"), SEP,
    L("TOTAL\tINR 1,150.00", 26, True), L("Cash"),
])
save("06_stationery_no_date.jpg", photo(stationery, 1.0), {
    "document_type": "receipt", "vendor": "Stationery Mart", "date": None, "currency": "INR",
    "total": 1150, "tax": None, "category": "office_supplies", "city": "Mumbai",
    "invoice_number": "00912", "payment_method": "Cash", "nights": None, "alcohol_amount": None,
    "attendees": None, "description": "Paper, markers and notebooks",
    "line_items": [{"description": "A4 Paper Ream x2", "amount": 560}], "confidence": 0.85,
    "low_confidence_fields": ["date"],
})

# 7. Coffee already claimed in a previous claim (seeded in the mock finance system)
coffee = receipt_image([
    L("Brew Bros Cafe", 32, True, "c"), L("BKC, Mumbai", 20, False, "c"), SEP,
    L("Order #A-2231"), L("03-09-2026 16:45"), SEP,
    L("Cappuccino x2\t360.00"), L("Banana Bread\t60.00"), SEP,
    L("TOTAL\tINR 420.00", 26, True), L("UPI"),
])
save("07_coffee_already_claimed.jpg", photo(coffee, -1.5), {
    "document_type": "receipt", "vendor": "Brew Bros Cafe", "date": "2026-09-03", "currency": "INR",
    "total": 420, "tax": None, "category": "meals", "city": "Mumbai",
    "invoice_number": "A-2231", "payment_method": "UPI", "nights": None, "alcohol_amount": None,
    "attendees": None, "description": "2 cappuccinos and banana bread",
    "line_items": [], "confidence": 0.93, "low_confidence_fields": [],
})

(OUT / "ground-truth.json").write_text(json.dumps(samples, indent=2))
print(f"Wrote {len(samples)} synthetic receipts to {OUT}")
