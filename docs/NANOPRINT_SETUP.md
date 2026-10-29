# NanoPrint — direct printing with no browser print window

How a till prints receipts, labels and shift reports straight to the thermal
printer, with no Chrome print dialog and no "allow this site?" prompt on every
sale.

NanoPrint is an alternative to QZ Tray, not a replacement: both stay available
and each computer chooses one in **Settings → Printer → Print service**. The
receipt and label designs, widths, barcodes, QR codes and tear-off tail are
produced by the same code either way — only the program that hands the bytes to
the printer changes.

---

## 1. Why NanoPrint instead of QZ Tray

A browser cannot talk to a USB thermal printer. Both programs solve that the
same way: they run on the till, listen on a WebSocket on `localhost`, and the
POS sends them finished ESC/POS bytes. Neither one opens the browser's print
window, so receipt height follows the content instead of Chrome's fixed paper
sizes.

They differ only in **how the till decides the POS is allowed to print**:

| | QZ Tray | NanoPrint |
|---|---|---|
| Permission is based on | a signing certificate | the site's origin |
| Needs a certificate | yes, trusted on every till (`override.crt`) or bought from QZ | no |
| Server must sign every request | yes (`/api/printing/qz/sign`) | no — the server is not in the print path at all |
| Prompt | per session; **"Remember" is greyed out while requests are unsigned** | once per site; **"Remember this decision" works** |
| Job types | raw ESC/POS and images through the OS driver | **raw ESC/POS only** |
| Needs Java | yes | no |
| Maturity | stable, years of field use | **pre-1.0** (v0.2.0, Oct 2026); only Windows printing is tested by its authors |

**The prompt you are seeing is the unsigned case.** QZ Tray disables
"Remember" on purpose when a request is not signed by a certificate it trusts,
so ticking it does nothing and the prompt comes back. There are only three ways
out: trust a certificate on every till (`docs/PRINTING_ARCHITECTURE.md` §4),
buy one from QZ Industries, or use an agent that does not work that way —
NanoPrint.

Because NanoPrint is pre-1.0, keep QZ Tray installed on at least one till until
you have printed a full day on NanoPrint.

---

## 2. Set up a till

### 2.1 Install the printer

Install the thermal printer's own Windows driver and print a Windows test page.
NanoPrint prints through OS printer queues in raw mode, so the printer must
exist in Windows first.

> Remote Desktop "Easy Print" queues cannot accept raw data. On a remote till,
> install the printer's real driver on the machine NanoPrint runs on.

### 2.2 Install NanoPrint

1. Download the installer for the till's OS from
   <https://github.com/nanofactura/nanoprint/releases> (Windows `.exe`,
   macOS `.dmg`, Linux `.deb` / `.rpm` / AppImage).
2. The installers are not code-signed yet, so the OS warns:
   - **Windows:** "Windows protected your PC" → *More info* → *Run anyway*.
     The installer is per-user and needs no administrator rights.
   - **macOS:** open it once, then *System Settings → Privacy & Security →
     Open Anyway*.
3. Start it. It sits in the tray and starts with the computer (switch that off
   in its Preferences if you prefer).

### 2.3 If the POS is served over https (production)

NanoPrint serves its local WebSocket over TLS with a certificate it generates
for `localhost`. The browser has to trust it, or the connection fails silently.

Open NanoPrint → **Secure sites** → let it install its local CA. It offers this
once per run. On Linux `.deb` / `.rpm` installs this needs `certutil`
(`libnss3-tools` on Debian/Ubuntu, `nss-tools` on Fedora). Firefox on Linux is
not covered yet — use Chrome or Edge there.

A POS served over plain `http://` (other than `http://localhost`) works, but
NanoPrint only remembers the decision for the session and asks again every time
it restarts. **Serve the POS over https on tills**, which you want anyway.

### 2.4 Point the POS at it

In the POS on that computer: **Settings → Printer**.

1. **Print service → NanoPrint.** The status line should turn into
   *NanoPrint connected*.
2. **Printer:** choose the thermal printer from the list.
3. **Printer language:** ESC/POS. (*Windows driver (image)* is disabled for
   NanoPrint — see §4.)
4. **Printable width:** 48 mm for a 58 mm roll, 72 mm for an 80 mm roll.
   **Resolution:** 203 dpi unless the printer's specification says otherwise.
5. **Auto cutter:** on only if the printer has one.
6. Press **Test print** (it creates no sale), then set
   **Print mode → Direct (NanoPrint)**.

### 2.5 Allow the site once

The first print opens NanoPrint's own window: *"&lt;your POS address&gt; wants to
print"*, with the printers it may use.

**Tick "Remember this decision", then Allow.** *Allow* is enabled after a
short delay — that is deliberate, not a hang. The decision is stored on that
computer (signed, in NanoPrint's own database) and the prompt does not come
back. Revoke it later in NanoPrint's settings window, which lists every site
and when it last printed.

After that, a sale prints its receipt with no dialog of any kind.

### 2.6 If QZ Tray is installed on the same computer

They listen on the same default ports (`8181` secure, `8182` insecure) and
whichever starts first takes them. Either uninstall/stop QZ Tray, or move
NanoPrint:

1. NanoPrint → **Preferences → Connection ports** → set e.g. `9181` / `9182`
   and restart it.
2. POS → **Settings → Printer → Print service → NanoPrint** → enter the same
   numbers in **Secure port** / **Insecure port**.

Leave those fields empty when only NanoPrint is installed.

---

## 3. What prints this way

Every print surface in all four POS systems, because they all share one
transport:

| | Clothing | Super Shop | Pharmacy | Restaurant |
|---|---|---|---|---|
| Sale receipt (auto-prints after payment) | ✅ | ✅ | ✅ | ✅ |
| Reprint from the sales list | ✅ | ✅ | ✅ | ✅ |
| Exchange / return receipt | ✅ | ✅ | ✅ | — |
| Bill / kitchen ticket | — | — | — | ✅ |
| Product barcode labels (incl. the on-sale price label) | ✅ | ✅ | ✅ | — (no barcodes on a menu) |
| Loyalty card sticker | ✅ | ✅ | ✅ | — |
| X report (mid-shift) and Z report (on close) | ✅ | — (no shifts module) | ✅ | ✅ |
| Test page and the printer diagnostics | ✅ | ✅ | ✅ | ✅ |

Printing is output only: every path renders a document fetched with a `GET` and
never calls a sale, return or loyalty API, so a failed print, a Retry or a
reprint can never create a second sale, move stock or award points again. A
failed print shows the reason next to the receipt with **Retry print** and an
explicit **Print using browser**.

---

## 4. The one limitation: no "Windows driver (image)"

NanoPrint accepts raw ESC/POS only. It refuses the image-through-the-driver
job type, which the POS calls **Printer language → Windows driver (image)**.
That mode exists for printers that are *not* ESC/POS — most often TSPL label
printers.

So:

- **ESC/POS receipt printer** (nearly all 58 mm and 80 mm thermal printers):
  NanoPrint is fine.
- **Non-ESC/POS printer:** keep that computer on QZ Tray. The POS blocks the
  unusable combination in Settings and, if it is somehow reached, the till is
  told to change the language or the service rather than shown a wire error.

A till may use NanoPrint for its receipt printer while another till uses QZ
Tray for a label printer — the setting is per computer.

---

## 5. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| *NanoPrint is not installed or not running* | not started, or the browser cannot reach it | Check the tray icon. On https, install NanoPrint's local CA (§2.3). If QZ Tray is also installed, set the ports (§2.6). |
| *… is running but this site is not allowed to print* | the site was blocked, or the prompt was dismissed | NanoPrint → settings window → remove the decision for that site, then print again and tick *Remember*. |
| The prompt returns after every restart | the POS is served over plain `http://` | Serve it over https. NanoPrint only remembers https origins and `http://localhost`. |
| Chrome asks about access to devices on the local network | Chrome's own prompt, not NanoPrint's | Allow it. NanoPrint cannot pre-grant it. |
| *NanoPrint prints raw ESC/POS only…* | printer language is *Windows driver (image)* | Switch to ESC/POS, or switch that computer to QZ Tray (§4). |
| Printed garbage characters | the printer is not ESC/POS | That printer needs QZ Tray's driver mode (§4). |
| Receipt prints but the printer never cuts/feeds enough | cutter off, or the printer ignores the feed command | Settings → Printer: turn on *Auto cutter* if it has one, raise *Feed after printing*. Every print already ends with a printed tear line and ~8 mm of blank paper. |
| It said it printed and nothing came out | success means the OS queue accepted the job | NanoPrint cannot read paper-out or cover-open. Check the printer and the Windows queue. |
| Nothing in the printer list | the printer is hidden in NanoPrint, or virtual | NanoPrint → Printers tab: it hides PDF/XPS/fax/OneNote and RDP Easy Print queues by default. |

The diagnostics in **Settings → Printer → Diagnostics** work the same under
NanoPrint: isolation tests (raw text, raster text, barcode, QR, logo) and the
last job's command summary, which now records which service it went to. It
contains command bytes and sizes only — never receipt content.

---

## 6. Rolling it out

1. One till first. Set it to NanoPrint, print a full day: sales, a reprint, an
   exchange, barcode labels, a loyalty card, an X report and a Z report.
2. Check a scanner reads the printed barcodes and a phone reads the QR codes —
   they are redrawn at printer resolution, not scaled screenshots.
3. Then switch the other tills. Each one needs §2.2, §2.4 and §2.5 (install,
   choose, allow once); nothing is configured on the server and nothing is
   configured per POS vertical.
4. Keep QZ Tray installed somewhere until NanoPrint has proved itself in your
   shop — it is pre-1.0, and switching back is one setting on that computer.

## 7. Notes for developers

- `client/src/features/printing/printAgent.ts` is the only module that opens a
  connection. `qzTray.ts` and `nanoPrint.ts` are profiles: how the agent is
  identified, which ports it uses, and whether it accepts pixel jobs.
- Adding a third agent means adding a profile and one entry in `AGENTS`. No
  print surface changes.
- The official `qz-tray` client drives NanoPrint unchanged: NanoPrint
  implements `getVersion`, `printers.find`, `printers.getDefault`,
  `printers.detail` and `print` with raw base64/hex data, and accepts and
  ignores the `signature` fields. Everything else returns an error, which is
  why the NanoPrint profile resolves an empty signature locally instead of
  calling the server.
- The chosen service is per computer, in `localStorage`
  (`pos.thermalPrinter.v1`), like the printer name and width. Nothing about
  printing is stored per account.
- NanoPrint is GPL-3.0 and runs as a separate program on the till; the POS only
  speaks to it over a local WebSocket, so its licence does not reach this
  codebase.
