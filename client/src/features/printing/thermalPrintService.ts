import { bytesToBase64, describeEscPosJob, encodeEscPosJob, encodeEscPosText, trimBlankRows, type MonoBitmap } from './escpos';
import { dotsPerLine, dotsPerMm, loadPrinterSettings, mmToDots, type ThermalPrinterSettings } from './printerSettings';
import { bitmapToCanvas, rasterizeElement } from './raster';
import { QzUnavailableError, ensureConnected, printImageBase64, printRawBase64, printerExists } from './qzTray';

/**
 * The printer transport. Always QZ Tray in the app; tests replace it with a
 * fake printer to exercise failures without hardware.
 */
export const printTransport = { ensureConnected, printerExists, printRawBase64, printImageBase64 };

/**
 * Direct thermal printing: one entry point for receipts, labels and loyalty
 * cards.
 *
 *   rendered document (existing React component)
 *     → raster.ts   exact-width 1-bit bitmap, height = content
 *     → escpos.ts   ESC/POS raster bytes   (or a PNG for the Windows-driver mode)
 *     → qzTray.ts   QZ Tray → local printer
 *
 * Printing is OUTPUT ONLY: it never calls the sale, return or loyalty APIs, so
 * a retry can never create a sale, move stock, take a payment or award points.
 */
export type ThermalDocumentType = 'receipt' | 'label' | 'loyalty-card' | 'test';

export interface ThermalPrintJob {
  type: ThermalDocumentType;
  /** The on-screen document to print (a receipt root, one label, one card). */
  element: HTMLElement;
  /** Physical width of the document; defaults to the full printable width. */
  contentWidthMm?: number;
  copies?: number;
}

export type ThermalPrintErrorCode =
  | 'QZ_UNAVAILABLE'
  | 'PRINTER_NOT_SELECTED'
  | 'PRINTER_NOT_FOUND'
  | 'PRINTER_UNAVAILABLE'
  | 'RENDER_FAILED'
  | 'UNSUPPORTED'
  | 'PRINT_FAILED';

const MESSAGES: Record<ThermalPrintErrorCode, string> = {
  QZ_UNAVAILABLE: 'Direct printing is unavailable. QZ Tray is not installed or not running on this computer - start QZ Tray and try again.',
  PRINTER_NOT_SELECTED: 'No thermal printer is selected on this computer. Choose one in Settings → Printer.',
  PRINTER_NOT_FOUND: 'The selected thermal printer was not found on this computer.',
  PRINTER_UNAVAILABLE: 'The thermal printer appears to be unavailable. Check that it is on, connected and has paper.',
  RENDER_FAILED: 'The document could not be prepared for printing.',
  UNSUPPORTED: 'The printer does not support this operation. Try the "Windows driver" printer language.',
  PRINT_FAILED: 'Printing failed.',
};

/** A print failure with a message safe to show at the till (technical detail goes to the console only). */
export class ThermalPrintError extends Error {
  constructor(
    public readonly code: ThermalPrintErrorCode,
    public readonly detail?: unknown,
  ) {
    super(MESSAGES[code]);
    this.name = 'ThermalPrintError';
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ''));

/** Maps what QZ Tray / Java print services report to a till-friendly error. */
export function classifyPrintError(error: unknown): ThermalPrintError {
  if (error instanceof ThermalPrintError) return error;
  if (error instanceof QzUnavailableError) return new ThermalPrintError('QZ_UNAVAILABLE', error);
  const text = describe(error).toLowerCase();
  if (/could not be found|not found|no such printer/.test(text)) return new ThermalPrintError('PRINTER_NOT_FOUND', error);
  if (/websocket|connection|not connected|closed/.test(text)) return new ThermalPrintError('QZ_UNAVAILABLE', error);
  if (/offline|not available|unavailable|paused|error state|out of paper|printerexception|not accepting/.test(text)) {
    return new ThermalPrintError('PRINTER_UNAVAILABLE', error);
  }
  if (/unsupported|not supported|invalid (flavor|format)/.test(text)) return new ThermalPrintError('UNSUPPORTED', error);
  return new ThermalPrintError('PRINT_FAILED', error);
}

/**
 * Blank lines added after every RECEIPT, on top of the device's "feed after
 * printing": the print head sits some way below the tear bar, so without it the
 * last line of a receipt stays inside the printer and back-to-back receipts
 * run into each other. Labels are unaffected.
 */
export const RECEIPT_END_GAP_LINES = 3;

/** ESC/POS default line spacing is 1/6 inch; used to size the same gap as blank rows for the driver path. */
const LINE_MM = 25.4 / 6;

/** Total lines fed after a document of this type. */
export const feedLinesFor = (type: ThermalDocumentType, settings: Pick<ThermalPrinterSettings, 'feedLines'>) =>
  settings.feedLines + (type === 'receipt' || type === 'test' ? RECEIPT_END_GAP_LINES : 0);

/** Adds blank rows under a bitmap (the Windows-driver path has no ESC/POS feed command). */
function withBlankRows(bitmap: MonoBitmap, rows: number): MonoBitmap {
  if (rows <= 0) return bitmap;
  const data = new Uint8Array(bitmap.width * (bitmap.height + rows));
  data.set(bitmap.data);
  return { width: bitmap.width, height: bitmap.height + rows, data };
}

/**
 * One print job at a time for the whole app. Receipts, labels, cards and test
 * pages from any dialog wait their turn, so two jobs can never be handed to
 * QZ Tray / the spooler at the same moment.
 */
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
}

/** What was last handed to QZ Tray - command bytes and sizes only, never customer data. */
export interface PrintDiagnostics {
  at: string;
  type: ThermalDocumentType | 'diagnostic';
  printer: string;
  language: ThermalPrinterSettings['language'];
  rasterMode: ThermalPrinterSettings['rasterMode'];
  bandHeight: number;
  widthDots: number;
  heightDots: number;
  payload: ReturnType<typeof describeEscPosJob> | { pngBytes: number };
  qz: { type: 'raw' | 'pixel'; format: 'command' | 'image'; flavor: 'base64' };
  result: 'sent' | 'failed';
  error?: string;
}
let lastDiagnostics: PrintDiagnostics | null = null;
const diagnosticListeners = new Set<() => void>();
export const printDiagnostics = {
  get: () => lastDiagnostics,
  subscribe(listener: () => void) {
    diagnosticListeners.add(listener);
    return () => diagnosticListeners.delete(listener);
  },
};
function recordDiagnostics(entry: PrintDiagnostics) {
  lastDiagnostics = entry;
  // Safe to log: sizes and command bytes only.
  console.info('[thermal-print] job', entry);
  diagnosticListeners.forEach((listener) => listener());
}

/** Renders the job to the bitmap that will be printed (exported for previews and tests). */
export async function renderJob(job: ThermalPrintJob, settings: ThermalPrinterSettings): Promise<MonoBitmap> {
  const target = dotsPerLine(settings);
  const content = job.contentWidthMm ? Math.min(target, mmToDots(job.contentWidthMm, settings.dpi)) : target;
  try {
    const { bitmap } = await rasterizeElement(job.element, { targetWidthDots: target, contentWidthDots: content });
    return trimBlankRows(bitmap);
  } catch (error) {
    throw new ThermalPrintError('RENDER_FAILED', error);
  }
}

/**
 * Prints a document on this computer's thermal printer through QZ Tray.
 * Resolves when QZ Tray has accepted the job; rejects with ThermalPrintError.
 */
export function printThermalDocument(job: ThermalPrintJob, settings: ThermalPrinterSettings = loadPrinterSettings()): Promise<{ printer: string; heightDots: number }> {
  return enqueue(() => runPrintJob(job, settings));
}

async function runPrintJob(job: ThermalPrintJob, settings: ThermalPrinterSettings): Promise<{ printer: string; heightDots: number }> {
  const printer = settings.printerName;
  if (!printer) throw new ThermalPrintError('PRINTER_NOT_SELECTED');
  const copies = Math.max(1, Math.min(100, Math.round(job.copies ?? 1)));

  try {
    await printTransport.ensureConnected();
    if (!(await printTransport.printerExists(printer))) throw new ThermalPrintError('PRINTER_NOT_FOUND');

    const bitmap = await renderJob(job, settings);
    if (bitmap.height === 0) throw new ThermalPrintError('RENDER_FAILED', 'empty document');

    const base = {
      at: new Date().toISOString(),
      type: job.type,
      printer,
      language: settings.language,
      rasterMode: settings.rasterMode,
      bandHeight: settings.bandHeight,
      widthDots: bitmap.width,
      heightDots: bitmap.height,
    };
    if (settings.language === 'escpos') {
      const bytes = encodeEscPosJob(Array.from({ length: copies }, () => bitmap), {
        feedLines: feedLinesFor(job.type, settings),
        autoCut: settings.autoCut,
        bandHeight: settings.bandHeight,
        rasterMode: settings.rasterMode,
      });
      const entry: PrintDiagnostics = { ...base, payload: describeEscPosJob(bytes), qz: { type: 'raw', format: 'command', flavor: 'base64' }, result: 'sent' };
      try {
        await printTransport.printRawBase64(printer, bytesToBase64(bytes));
        recordDiagnostics(entry);
      } catch (error) {
        recordDiagnostics({ ...entry, result: 'failed', error: describe(error).slice(0, 200) });
        throw error;
      }
    } else {
      const page = withBlankRows(bitmap, Math.round(feedLinesFor(job.type, settings) * LINE_MM * dotsPerMm(settings.dpi)));
      const png = bitmapToCanvas(page).toDataURL('image/png').split(',')[1];
      recordDiagnostics({ ...base, payload: { pngBytes: Math.round((png.length * 3) / 4) }, qz: { type: 'pixel', format: 'image', flavor: 'base64' }, result: 'sent' });
      await printTransport.printImageBase64(printer, png, {
        widthMm: page.width / dotsPerMm(settings.dpi),
        heightMm: page.height / dotsPerMm(settings.dpi),
        dpi: settings.dpi,
        copies,
      });
    }
    return { printer, heightDots: bitmap.height };
  } catch (error) {
    const classified = classifyPrintError(error);
    // Technical detail for support; the till only shows the friendly message.
    console.error(`[thermal-print] ${job.type} failed (${classified.code})`, classified.detail ?? error);
    throw classified;
  }
}

/**
 * A small test page - creates no sale, touches no data. Built as a temporary
 * off-screen element so it goes through exactly the same pipeline as receipts.
 */
export async function printTestPage(settings: ThermalPrinterSettings = loadPrinterSettings()) {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText =
    'position:fixed;left:-10000px;top:0;width:48mm;padding:2mm;background:#fff;color:#000;font:9.5pt/1.35 ui-monospace,Menlo,monospace;';
  const line = (text: string, style = '') => {
    const div = document.createElement('div');
    div.textContent = text;
    div.style.cssText = style;
    element.appendChild(div);
  };
  line('RetailerSuites.com', 'text-align:center;font-weight:700;font-size:11pt');
  line('--------------------------------', 'overflow:hidden;white-space:nowrap');
  line('QZ Tray Test Print', 'text-align:center;font-weight:700');
  line(`Printer: ${settings.printerName ?? '-'}`);
  line(`Width: ${settings.printableWidthMm}mm (${dotsPerLine(settings)} dots)`);
  line(`Mode: ${settings.language === 'escpos' ? 'ESC/POS raster' : 'Windows driver'}`);
  line(new Date().toLocaleString());
  const code = document.createElement('div');
  code.setAttribute('data-barcode-value', 'TEST-48MM');
  code.setAttribute('data-barcode-format', 'CODE128');
  code.style.cssText = 'height:14mm;margin-top:2mm';
  element.appendChild(code);
  const qr = document.createElement('div');
  qr.setAttribute('data-qr-value', 'https://retailersuites.com');
  qr.style.cssText = 'width:22mm;height:22mm;margin:2mm auto 0';
  element.appendChild(qr);
  line('SUCCESS', 'text-align:center;font-weight:700;margin-top:2mm');
  document.body.appendChild(element);
  try {
    return await printThermalDocument({ type: 'test', element }, settings);
  } finally {
    element.remove();
  }
}


// ------------------------------------------------------------------ diagnostics

export type DiagnosticKind = 'raw-text' | 'raster-text' | 'barcode' | 'qr' | 'logo';

/**
 * Isolation tests for a garbled printer (Settings → Printer → Diagnostics).
 * None of them touch any sale, customer or loyalty data.
 *   raw-text     plain ESC/POS text - NO image. Garbled here = driver/port problem.
 *   raster-text  text as a raster image
 *   barcode      EAN-13 1234567890128 (the test value 123456789012 + check digit)
 *   qr           https://retailersuites.com
 *   logo         the store's receipt logo (if configured) between two text lines
 */
export function printDiagnostic(kind: DiagnosticKind, settings: ThermalPrinterSettings = loadPrinterSettings(), logoUrl?: string | null) {
  if (kind === 'raw-text') return enqueue(() => runRawTextTest(settings));
  return enqueue(async () => {
    const element = diagnosticElement(kind, settings, logoUrl);
    document.body.appendChild(element);
    try {
      if (kind === 'logo') await waitForImages(element);
      return await runPrintJob({ type: 'test', element }, settings);
    } finally {
      element.remove();
    }
  });
}

async function runRawTextTest(settings: ThermalPrinterSettings) {
  const printer = settings.printerName;
  if (!printer) throw new ThermalPrintError('PRINTER_NOT_SELECTED');
  if (settings.language !== 'escpos') throw new ThermalPrintError('UNSUPPORTED', 'raw text test needs ESC/POS');
  try {
    await printTransport.ensureConnected();
    if (!(await printTransport.printerExists(printer))) throw new ThermalPrintError('PRINTER_NOT_FOUND');
    const rule = '================================';
    const bytes = encodeEscPosText(
      [rule, 'RetailerSuites.com', 'QZ TRAY RAW TEXT TEST', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', rule],
      { feedLines: feedLinesFor('test', settings), autoCut: settings.autoCut },
    );
    const entry: PrintDiagnostics = {
      at: new Date().toISOString(),
      type: 'diagnostic',
      printer,
      language: settings.language,
      rasterMode: settings.rasterMode,
      bandHeight: settings.bandHeight,
      widthDots: 0,
      heightDots: 0,
      payload: describeEscPosJob(bytes),
      qz: { type: 'raw', format: 'command', flavor: 'base64' },
      result: 'sent',
    };
    await printTransport.printRawBase64(printer, bytesToBase64(bytes));
    recordDiagnostics(entry);
    return { printer, heightDots: 0 };
  } catch (error) {
    throw classifyPrintError(error);
  }
}

function diagnosticElement(kind: Exclude<DiagnosticKind, 'raw-text'>, settings: ThermalPrinterSettings, logoUrl?: string | null) {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = `position:fixed;left:-10000px;top:0;width:${settings.printableWidthMm}mm;padding:1mm;background:#fff;color:#000;font:10pt/1.35 ui-monospace,Menlo,monospace;text-align:center;`;
  const line = (text: string, bold = false) => {
    const div = document.createElement('div');
    div.textContent = text;
    if (bold) div.style.fontWeight = '700';
    element.appendChild(div);
  };
  const titles = { 'raster-text': 'RASTER TEXT TEST', barcode: 'BARCODE TEST', qr: 'QR TEST', logo: 'LOGO TEST' } as const;
  line('RetailerSuites.com', true);
  line(titles[kind], true);
  if (kind === 'raster-text') {
    line('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    line('0123456789');
  }
  if (kind === 'barcode') {
    const code = document.createElement('div');
    code.setAttribute('data-barcode-value', '1234567890128');
    code.setAttribute('data-barcode-format', 'EAN13');
    code.style.cssText = 'height:16mm;margin:2mm 0';
    element.appendChild(code);
  }
  if (kind === 'qr') {
    const qr = document.createElement('div');
    qr.setAttribute('data-qr-value', 'https://retailersuites.com');
    qr.style.cssText = 'width:24mm;height:24mm;margin:2mm auto';
    element.appendChild(qr);
  }
  if (kind === 'logo') {
    if (logoUrl) {
      const img = document.createElement('img');
      img.src = logoUrl;
      img.crossOrigin = 'anonymous';
      img.style.cssText = 'max-width:32mm;max-height:18mm;margin:2mm auto;display:block;filter:grayscale(100%) contrast(2)';
      element.appendChild(img);
    } else {
      line('(no receipt logo set)');
    }
  }
  line('TEXT AFTER - OK');
  return element;
}

function waitForImages(element: HTMLElement) {
  return Promise.all(
    Array.from(element.querySelectorAll('img')).map(
      (img) => (img.complete ? Promise.resolve() : new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); })),
    ),
  );
}
