# Printing Architecture (Clothing POS)

Status: QZ Tray direct thermal printing implemented (see IMPLIMENTATION_STATUS.md).
Scope: **Clothing POS only.** Restaurant, Pharmacy and Super Shop printing is untouched.

---

## 1. Audit — what existed before direct printing

### Output format

Everything printable is **HTML/CSS rendered by React**. There is no PDF, no canvas,
no ESC/POS and no print queue anywhere in the client or server.

| Document | Component | Barcode | Transport |
|---|---|---|---|
| Sale / exchange receipt (Clothing) | `client/src/features/receipt/ThermalReceipt.tsx` inside `ReceiptDialog.tsx` | – | `window.print()` via `printReceipt()` |
| Product barcode labels | `client/src/features/barcode/BarcodeLabel.tsx` inside `BarcodePrintDialog.tsx` | SVG from `jsbarcode` (EAN-13 / CODE128) | `window.print()` |
| Loyalty membership card sticker | `client/src/features/loyalty/LoyaltyCardSticker.tsx` inside `LoyaltyCardPrintDialog.tsx` | SVG from `jsbarcode` (EAN-13, 299 range) | `window.print()` |
| Restaurant receipts / kitchen tickets | `features/restaurant/RestaurantPrints.tsx` | – | `printReceipt()` (**not touched**) |
| Pharmacy / Super Shop receipts | own `printReceipt()` in their dialogs | – | own `window.print()` (**not touched**) |
| Billing invoice / wallet receipt / statement | `InvoicePage`, `ReceiptPage`, `StatementPanel` | – | `window.print()` on A4 (**not touched**) |

- **QR codes:** none existed.
- **Browser print CSS** (`client/src/index.css`): `@media print` hides the page and shows only
  `#receipt-print-area`, `#barcode-print-area` or `#loyalty-card-print-area`. Receipts inject
  `@page { size: <width>mm auto }`, and labels do the same in label-roll mode.
- **The problem:** Chrome ignores `auto` heights for most drivers and offers fixed paper
  heights instead (210 / 297 / 600 / 3000 mm). This is why dynamic thermal output was
  impossible through the browser.

### Settings that already existed

| Setting | Where | Values |
|---|---|---|
| Receipt paper width | `store.receipt.paperWidthMm` | 48 / 58 / 78 / 80 |
| Product label width | `store.labels.productWidthMm` | 38 / 48 / 58 |
| Loyalty card width | `store.labels.loyaltyCardWidthMm` | 48 / 58 / 85 |
| Label paper | `store.labels.paper` | sheet / roll |

These are per-branch layout settings (what the receipt or label looks like), stored in the store.

### Print entry points

1. **Auto-print after Complete Sale:** `PosPage` opens `<ReceiptDialog autoPrint>` once the sale API
   succeeds. It prints once per sale id, and the sale already exists by then.
2. **Auto-print after an exchange:** `CreateReturnPage` opens `<ReceiptDialog autoPrint>` for the
   replacement sale.
3. **Manual reprint:** `SalesPage` opens `<ReceiptDialog>` and the Print button calls `printReceipt()`.
4. **Product labels:** `ProductFormDialog`, then `BarcodePrintDialog`, then the Print button.
5. **Loyalty card:** `LoyaltyPage`, `MemberDetailDialog`, `CustomerLoyaltyDialog`, then
   `LoyaltyCardPrintDialog`.

The receipt data comes from `GET /api/sales/:id/receipt`. This is read-only: it never
creates, changes or awards anything, so rendering it again is always safe.

---

## 2. Direct printing design

### Principle

Only the **final transport** is replaced. The same React components render the same data.

```text
Existing POS business logic (sale / return / loyalty - backend is authoritative)
        ↓
Existing receipt / label / loyalty-card React components (unchanged layout)
        ↓
features/printing/raster.ts         DOM node → exact-width 1-bit bitmap
        ↓                           (+ crisp printer-resolution barcodes / QR)
features/printing/escpos.ts         bitmap → ESC/POS raster bytes   (or PNG for "driver" mode)
        ↓
features/printing/thermalPrintService.ts   printThermalDocument(job)
        ↓
features/printing/qzTray.ts         the ONLY module that talks to QZ Tray
        ↓  WebSocket (localhost)
QZ Tray  →  Windows printer (raw pass-through)  →  thermal printer
```

### Why a raster rather than text ESC/POS

- **Reuses the existing layout exactly.** Receipts have many variants (VAT on/off, split payment,
  cash/change, exchange, loyalty). A second text renderer would duplicate all of them.
- **One command only.** It needs just `GS v 0` (raster bit image), which practically every
  ESC/POS thermal printer supports. Fonts, code pages, native barcode and QR commands differ
  between models and are not assumed.
- **Bangla and ৳ print correctly.** They are rendered by the browser, so no printer code page is needed.
- **Dynamic height.** The bitmap is exactly as tall as the content, and the printer feeds only
  those rows plus a configurable number of lines.
- **Scannable codes.** Barcodes and QR codes are not screenshots. They are redrawn onto the
  bitmap at printer resolution with whole-dot module widths and a quiet zone.

A second mode, **Windows driver (image)**, sends a PNG through the printer driver with a page
size set per job: width = printable width, height = content height. This is for printers that
are not ESC/POS (for example TSPL label printers). Neither mode uses browser paper sizes.

### Width (48 mm)

These are separate values:

| Value | Meaning |
|---|---|
| **Printable width** (device setting, default 48 mm) | Physical width the head can print. A 58 mm paper roll typically has a 48 mm printable area. |
| **Printer resolution** (device setting, default 203 dpi) | 8 dots/mm, standard for thermal heads. |
| **Dots per line** | printable mm × dots/mm (`round(dpi / 25.4)`: 203 dpi = 8, 300 dpi = 12), rounded down to a whole byte → 48 mm @ 203 dpi = **384 dots**; 72 mm = 576. Derived from the two settings, never hard-coded. |
| **CSS width** | The receipt's own layout width (store setting, e.g. 48 mm). It is scaled to exactly the dots per line when rasterised. |

### Raw job structure (after the garbled-output fix, see PRINTING_BUG_ANALYSIS.md)

```
1B 40                          ESC @      reset modes a previous job may have left on
00 × 64                        NUL        resync padding (bytes a printer drops during the reset hit this, not the image)
1D 76 30 00 30 00 18 00 …      GS v 0     raster block: 48 bytes × 24 rows (default; 48 / 128 selectable)
…                                         one self-contained block every 24 rows, so an error spoils at most ~3 mm
1B 64 07                       ESC d 7    feed (device feed + 3 for receipts)
1D 56 42 00                    GS V 66 0  cut - only when the device has a cutter
```

- **QZ call:** `qz.print(qz.configs.create(printer, { copies: 1 }), [{ type: 'raw', format: 'command', flavor: 'base64', data }])`.
  No text encoding is involved: QZ decodes the base64 to the exact bytes.
- **Compatibility mode:** `ESC *` 24-dot column stripes, for clones with incomplete `GS v 0` support.
- **App-wide queue:** one job at a time, from any dialog.
- **Diagnostics:** the last job's command summary, plus isolation tests (Settings → Printer → Diagnostics).

### Device-specific settings

Printer choices belong to a **computer**, not to the SaaS account: different tills can use
different printers. They are stored in the browser's `localStorage` (key `pos.thermalPrinter.v1`)
and never in the database. There is no device-management module to attach them to.

| Setting | Values / default |
|---|---|
| mode | `browser` (default, unchanged behaviour) or `direct` (QZ Tray) |
| printer name | Chosen from `qz.printers.find()`. Never hard-coded. |
| language | `escpos` or `driver` |
| printable width | 48 mm |
| dpi | 203 |
| feed lines after print | 4 (receipts add 3 more — `RECEIPT_END_GAP_LINES` — so the last line clears the tear bar and consecutive receipts stay apart: 7 in total by default) |
| auto cutter | off (a cut command is sent only when this is on) |
| raster block height | 24 rows (48 / 128 selectable) |
| raster command | `GS v 0` (or `ESC *` compatibility) |

### Sale safety and retry

- Printing starts **only after** the sale API has succeeded and the receipt has been fetched with
  a read-only GET. It never calls the sale, return or loyalty APIs.
- A failed print leaves the sale as it is. The dialog shows the reason, a **Retry** button (the
  same already-rendered receipt) and an explicit **Print using browser** button. The browser
  dialog is never opened automatically in direct mode.
- Retry re-sends the bitmap only, so there is no second sale, payment, stock movement or loyalty
  transaction.

### Security

- **Private key:** the QZ signing key lives **only on the server** (`QZ_PRIVATE_KEY_PATH` or
  `QZ_PRIVATE_KEY`). It is never sent to the browser and never committed (`*.pem`, `*.key` and
  `certs/` are git-ignored).
- **Endpoints:** `GET /api/printing/qz/certificate` returns the public certificate.
  `POST /api/printing/qz/sign` returns an RSA-SHA512 signature of the QZ request. Both require a
  signed-in user of the workspace, and signing is rate-limited and size-limited.
- **No raw commands from users:** printer commands are generated only from the rasterised bitmap
  by `escpos.ts`. There is no API or UI that accepts raw printer commands, and receipt text never
  reaches the printer as commands.
- **Printer names** come only from the local QZ Tray printer list chosen on that computer.

### Files

| Created | Purpose |
|---|---|
| `client/src/features/printing/qzTray.ts` | Connection manager, security, printer discovery, raw/pixel print. |
| `client/src/features/printing/printerSettings.ts` | Device settings (`localStorage`) and dots-per-line maths. |
| `client/src/features/printing/raster.ts` | DOM → 1-bit bitmap, crisp barcode/QR overlay. |
| `client/src/features/printing/escpos.ts` | Bitmap → ESC/POS bytes (pure, unit-tested). |
| `client/src/features/printing/thermalPrintService.ts` | `printThermalDocument`, friendly errors, test print. |
| `client/src/features/printing/useThermalPrint.ts` | React hook: status, print, retry. |
| `client/src/features/printing/PrinterSettingsCard.tsx` | Settings → Printer tab (per device). |
| `client/src/features/printing/qr.ts` | QR rendering for labels. |
| `client/src/types/qz-tray.d.ts` | Type declarations for the official client. |
| `server/src/modules/printing/*` | Certificate and signing endpoints. |

| Modified (transport only) | Change |
|---|---|
| `features/receipt/ReceiptDialog.tsx` | Direct print, status, retry, explicit browser fallback. |
| `features/barcode/BarcodePrintDialog.tsx`, `BarcodeLabel.tsx` | Direct print; optional QR; barcode data attributes. |
| `features/loyalty/LoyaltyCardPrintDialog.tsx`, `LoyaltyCardSticker.tsx` | Direct print; barcode data attributes. |
| `pages/SettingsPage.tsx` | Printer tab. |
| `server/src/config/env.ts`, `routes/index.ts` | QZ key configuration and route mount. |

| Untouched | Why |
|---|---|
| `ThermalReceipt.tsx` layout, `printReceipt()` export | Shared with Restaurant, which keeps browser printing. |
| Restaurant / Pharmacy / Super Shop print code | Out of scope (Clothing only). |
| Sale, return, loyalty services | Printing is output only. |
| Browser print CSS | Kept as the explicit fallback and for `browser` mode. |

---

## 3. Setup on a Windows POS computer

1. **Install the printer driver.** Install the thermal printer's Windows driver and check that
   Windows can print a test page.
2. **Install QZ Tray.** Download it from https://qz.io/download, install it and start it. A tray
   icon appears, and it should start with Windows (the default).
3. **Open Settings → Printer** in the POS on that computer.
   - **Connection** should show *QZ Tray connected*.
   - **Printer:** choose the thermal printer from the list.
   - **Printer language:** *ESC/POS* for most receipt printers. Use *Windows driver* for non-ESC/POS label printers.
   - **Printable width:** 48 mm. **Resolution:** 203 dpi (check the printer's specification).
   - **Auto cutter:** on only if the printer has a cutter.
4. **Test print.** Press **Test print**, which creates no sale. Then set **Print mode → Direct (QZ Tray)**.
5. **Signing prompt.** The first time, QZ Tray asks to allow the site.
   - In **production** (signed): tick *Remember* and *Allow*.
   - In **development** (unsigned): QZ asks every session, and *Remember* is not offered.

### Receipt paper

Set **Settings → Receipt → Paper width = 48 mm** so the layout is designed for the printable width.
A wider layout is scaled down to fit.

---

## 4. Certificate and signing setup (production)

QZ Tray trusts a website when every request is signed by a key whose certificate QZ trusts.

1. **Obtain the key and certificate.** Either buy a QZ Tray certificate from QZ Industries (trusted
   out of the box), or generate a self-signed pair with QZ Tray's *Site Manager → +* (or
   `openssl req -x509 -newkey rsa:2048 -keyout private-key.pem -out digital-certificate.txt -days 3650 -nodes`).
   A self-signed certificate must be imported on every POS computer (QZ Tray → *Site Manager*, or
   the `authcert.override` property).
2. **Store the files on the SERVER only**, outside the repository (e.g. `/etc/retailersuites/qz/`).
3. **Configure the server environment:**
   ```
   QZ_CERTIFICATE_PATH=/etc/retailersuites/qz/digital-certificate.txt
   QZ_PRIVATE_KEY_PATH=/etc/retailersuites/qz/private-key.pem
   ```
   `QZ_CERTIFICATE` and `QZ_PRIVATE_KEY` (PEM text with `\n` escapes) also work for platforms
   without a filesystem.
4. **Restart the API.** Settings → Printer then shows *Signed requests*.

**Development:** with no key configured, the endpoints report `configured: false` and the client
connects unsigned. QZ Tray shows an allow prompt, which is fine for local testing. Never use a
blanket "trust everything" override.

---

## 5. Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| QZ Tray is not installed or not running | No QZ WebSocket on this computer | Install or start QZ Tray; check the tray icon. |
| Selected thermal printer was not found | Printer renamed or removed, or wrong computer | Settings → Printer → choose it again. |
| Printer not selected | New device | Settings → Printer. |
| Thermal printer appears to be unavailable | Printer off, cable, paper out | Check the printer, then press Retry. |
| Printed garbage characters | Printer is not ESC/POS | Switch language to *Windows driver*. |
| Output too narrow or cut off | Wrong printable width or dpi | Adjust width/dpi and use Test print. |
| Prompt appears every time | Unsigned (development) or untrusted certificate | Configure signing (§4). |

The browser fallback is always available from the receipt or label dialog (**Print using browser**),
and by setting **Print mode → Browser** on that computer.

---

## 6. Rendering details (why the printed output matches the screen)

- **Capture copy.** `raster.ts` never captures the live DOM. It clones the document into an off-screen host,
  so the screen does not flicker.
- **Concrete fonts.** `ui-monospace`, `system-ui` and similar keywords resolve on the page but *not* inside the
  capture image. The copy's fonts are rewritten to concrete installed fonts (Menlo / Consolas / Courier New;
  Helvetica / Segoe UI / Arial), so text is measured and drawn in the same font.
- **Frozen line breaks.** The capture copies each element's measured height but recomputes line wrapping, so a
  line that only just fits on screen could break differently and leave a blank line. The copy's line breaks are
  measured, written in as real newlines, and wrapping is switched off. The capture then draws exactly the
  measured lines.
- **Barcodes and QR codes.** These are redrawn at printer resolution over their boxes, and the on-screen versions
  are hidden in the copy so no stray pixels survive:
  - EAN-13 / CODE128 via `jsbarcode` with a whole number of dots per module and a 10-module quiet zone;
  - QR via `qrcode` (error correction M) with whole-dot modules and a 4-module quiet zone.
- **1-bit output.** The image is thresholded to pure black and white (luminance < 160), then blank rows at the top
  and bottom are trimmed to an 8-dot margin.

## 7. Test results (development machine, no printer attached)

| Area | Result |
|---|---|
| **ESC/POS encoder** (unit, 15) | `ESC @`, `GS v 0` bands of 128 rows, 48 bytes/row at 384 dots, feed, cut only when enabled; long jobs grow by exactly their extra rows; blank trimming; copies; base64. |
| **Device settings** (unit, 8) | Default browser mode; 48 mm @ 203 dpi = 384 dots, 72 mm = 576, 300 dpi = 576; validation and clamping; corrupted storage falls back to defaults. |
| **Server signing** (unit, 4) | Public certificate only; RSA-SHA512 signature verifies with the certificate and fails for another request. |
| **End-to-end** (9) | Auth required; unsigned mode reveals nothing; size and field validation; no raw-print endpoint; reprinting a loyalty receipt 3× changes no points, ledger or sales. |
| **Browser pipeline: receipt height** (real Chromium) | All documents exactly 384 dots wide. Heights follow content: 2 items 101 mm, 30 items 537 mm, VAT + split payment + exchange + loyalty 195 mm. |
| **Browser pipeline: labels and card** | 38 mm label 28 mm tall, 48 mm label + QR 51 mm, loyalty card 39 mm. |
| **Browser pipeline: scanning** | Every EAN-13 and QR code decoded from the printed bitmaps (Chromium BarcodeDetector). |
| **Failure scenarios** (fake printer) | QZ stopped, printer missing, printer offline, unsupported operation and no printer selected each map to the right message. Retry succeeds, and zero API calls are made while printing. |
| **Real QZ Tray client, not running** | Detected as *not installed / not running* in about 1.2 s; status becomes `unavailable`. |
| **Receipt dialog** (direct mode, fake printer) | Auto-print once per sale; reopening doesn't print again; failure shows "Sale completed, but the receipt did not print" with Retry and Print using browser; `window.print()` is never called automatically; Retry prints; double-click prints once; zero API calls. |

**Not yet done:** a real hardware test on the Windows computer with the 48 mm printer (see §3). Until that
passes, treat printer-specific behaviour (ESC/POS raster support, driver raw pass-through, feed and cutter) as
unverified.

