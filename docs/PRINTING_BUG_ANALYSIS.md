# Printing Bug Analysis — garbled thermal output (QZ Tray, ESC/POS)

Scope: Clothing POS direct printing (`client/src/features/printing/*`). Other POS types don't use it.

## 1. Symptom (from the photographed receipt)

Reading the paper in the order it came out of the printer:

1. **The previous receipt's end is perfect**: "…items are final. Thank you for shopping with us!
   https://retailersuites.com".
2. **The start of the next receipt is garbage**, about 35 text lines of `x < > ? | p 8 0 ` a c 1 0a 0c ps`,
   black blocks, and some lines **underlined**.
3. **That receipt then resumes perfectly** at `admin@demostore.dev` (the store e-mail, the 3rd/4th header line),
   followed by Invoice / Date / Cashier / Customer / Phone / items.
4. **Missing:** the receipt's first lines (store name, address, phone) never printed as an image.

## 2. What the garbage is

The characters are the image data itself, printed as text:

| Printed | Byte | Bits | Meaning in the raster |
|---|---|---|---|
| `x` | 0x78 | 0111 1000 | a 4-dot black run (a letter stroke) |
| `<` / `>` / `?` | 0x3C / 0x3E / 0x3F | 0011 1100 / 0011 1110 / 0011 1111 | stroke runs |
| `p` | 0x70 | 0111 0000 | stroke run |
| `8` / `0` / `` ` `` | 0x38 / 0x30 / 0x60 | 0011 1000 / 0011 0000 / 0110 0000 | stroke runs |
| `a`, `c`, `1`, `q`, `s` | 0x61, 0x63, 0x31, 0x71, 0x73 | … | stroke runs |
| black blocks | ≥ 0x80 (0xFF = solid) | solid runs | printed with the printer's block glyphs |
| **underlined lines** | random `1B 2D 01` (ESC – 1) inside the data | – | the data happened to contain an "underline on" command |

Zero bytes (white dots) print nothing, which is why a whole band of mostly-white image becomes about 35
short lines of scattered characters. The text "0a", "0c", "8a", "ps" in the photo is **not hex being sent
as text**. It is the glyphs `0`, `a`, `c`, `8`, `p`, `s` produced by stroke bytes.

**Conclusion:** the printer received correct image bytes but did **not** read them as image data. It read
them as characters.

## 3. Why only the start of a job

The job the app sent (from `escpos.ts`, before the fix):

```
1B 40                         ESC @      initialise (clears the print buffer)
1D 76 30 00 30 00 80 00       GS v 0     raster band 1: 48 bytes × 128 rows
<6144 bytes of image>
1D 76 30 00 30 00 80 00       GS v 0     band 2 …
…
1B 64 07                      ESC d 7    feed
```

- **Band 1 was lost.** Band 1 (128 dots, about 16 mm, holding the store name, address and phone) is exactly what
  is missing. Its 6,144 data bytes printed as text.
- **The printer resynchronised at band 2's header.** The first thing that can resynchronise an ESC/POS
  parser after lost framing is the next complete command, and the photo resumes exactly one band later.
- **The first header arrived straight after `ESC @`.** `ESC @` *clears the print buffer*. On many low-cost
  58 mm printers (Xprinter / "POS-58" clones and similar), bytes that arrive while the reset is still being
  processed are dropped, or the reset clears them from the buffer.
  - **When the header is lost:** if any of the 8 header bytes are lost, the printer is in text mode when the
    6,144 data bytes arrive.
- **It's intermittent.** It depends on timing, such as whether the printer is still feeding the previous
  receipt when the next job arrives. It happened on the **second of two consecutive receipts**.
- **Why the damage was so large.** Very large bands (6,144 bytes per command) made the damage large: one
  lost header ruins 16 mm of receipt.

## 4. Audit checklist (what was checked and ruled out)

| # | Item | Finding |
|---|---|---|
| 1–2 | QZ integration / `qz.print()` | One raw call: `qzTray.ts printRawBase64` → `qz.print(config, [{ type:'raw', format:'command', flavor:'base64', data }])`. Plus one pixel call for the optional Windows-driver mode. |
| 3 | `qz.configs.create()` | `{ copies: 1 }` for raw. No `encoding`, no `forceRaw`. |
| 4–5 | Payload / ESC/POS generation | Only `escpos.ts`: `ESC @`, `GS v 0` bands, `ESC d n`, optional `GS V 66 0`. No text commands at all. |
| 6–7 | Barcode / QR | Not ESC/POS commands. Drawn into the raster bitmap at printer resolution, so they cannot inject commands. |
| 8 | Raster generation | `raster.ts` produces a 1-bit bitmap; `packRows` packs MSB = leftmost dot. Unit-tested and decoded back correctly. |
| 9–10 | Base64 / hex | `bytesToBase64`: `String.fromCharCode` on byte chunks, then `btoa`. This is binary-safe (each byte 0–255 becomes one Latin-1 char). No hex anywhere. |
| 11, 14 | Encoding | None needed or used. The `base64` flavor makes QZ decode to exact bytes; QZ's `encoding` applies only to plain-string data. |
| 15–16 | UTF-8 / CP1252 / string conversion of binary | None. The bytes never become Unicode text. |
| 17–18 | Escaped strings (`"\\x1B"`, `"1B40"`, `0x1B0x40`) | None. Commands are numeric byte values in a `Uint8Array`. |
| 19 | QZ format/flavor | `raw` / `command` / `base64` is the documented structure for pre-built byte payloads. |
| 20 | Driver config | QZ on Windows sends raw jobs through the installed driver (RAW datatype). QZ 2.3's `forceRaw` is documented as "Not yet supported on Windows", so it isn't a valid fix there. |
| 18 (phase) | Concurrent jobs | Each dialog blocked double clicks, but there was **no app-wide queue**. Two dialogs or quick successive sales could submit jobs back to back with no gap. |

The payload bytes were correct. That was proven by decoding the generated job back into the identical
bitmap in tests. The fault is **framing**: the printer didn't see the start of the first raster command.

## 5. Fix (see IMPLIMENTATION_STATUS.md for the date)

1. **Resynchronisation after `ESC @`.** `ESC @` is still sent to reset any state a previous job left behind,
   such as underline or reverse switched on by garbage. It is now followed by 64 NUL bytes. NUL is ignored by
   ESC/POS in text mode, so bytes the printer drops or clears while resetting are harmless padding instead of
   the raster header.
2. **Small raster bands: 24 rows (1,152 bytes) instead of 128 (6,144 bytes).**
   - Every band is a self-contained command, so a corrupted band can damage at most 3 mm, not 16 mm, and the
     printer resynchronises at the very next band.
   - Small commands also stay well inside the receive buffer of low-cost printers.
   - It's configurable (24 / 48 / 128).
3. **Compatibility raster command (optional).** `ESC *` 24-dot column images for clones with incomplete
   `GS v 0` support. It's selectable per device and off by default.
4. **One print job at a time, app-wide.** `thermalPrintService` has a queue, so receipts, labels, cards and test
   pages never overlap, even across dialogs.
5. **Diagnostics.**
   - The exact job summary is recorded before `qz.print`: type, printer, byte count, bands, band height, and the
     first and last command bytes in hex. Only command bytes, never customer data.
   - Settings → Printer shows the last job and offers isolation tests: A raw text (no raster), B raster text,
     C barcode, D QR, E store logo, F full test page.

## 6. How to confirm on the real printer

Run Settings → Printer → Diagnostics in this order:

1. **A. Raw text.** Plain ESC/POS text, no image. If this is garbled, the problem is the Windows driver or port,
   not the image. Check the driver is the printer's own ESC/POS driver or "Generic / Text Only" with RAW
   spooling, and disable *Advanced printing features* in the driver's Advanced tab.
2. **B–E.** Each must print cleanly. The barcode and QR code must scan.
3. **F.** Then print two receipts back to back, then several quickly. Nothing should garble. With 24-row bands,
   even a transmission error would show as at most a 3 mm streak.
