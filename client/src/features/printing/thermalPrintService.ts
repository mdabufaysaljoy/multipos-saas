import { bytesToBase64, describeEscPosJob, encodeEscPosJob, encodeEscPosText, trimBlankRows, type MonoBitmap } from './escpos';
import { dotsPerLine, dotsPerMm, loadPrinterSettings, mmToDots, type ThermalPrinterSettings } from './printerSettings';
import { bitmapToCanvas, rasterizeElement } from './raster';
import { AgentUnavailableError, ensureConnected, printAgent, printImageBase64, printRawBase64, printerExists } from './printAgent';

/**
 * The printer transport: QZ Tray or NanoPrint, whichever this computer is set
 * to use (Settings → Printer → Print service). Tests replace it with a fake
 * printer to exercise failures without hardware.
 */
export const printTransport = { ensureConnected, printerExists, printRawBase64, printImageBase64 };

/**
 * Direct thermal printing: one entry point for receipts, labels and loyalty
 * cards.
 *
 *   rendered document (existing React component)
 *     → raster.ts   exact-width 1-bit bitmap, height = content
 *     → escpos.ts   ESC/POS raster bytes   (or a PNG for the Windows-driver mode)
 *     → printAgent.ts  QZ Tray or NanoPrint → local printer
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
  | 'AGENT_UNAVAILABLE'
  /** The agent is running but this site is not allowed to print. */
  | 'AGENT_BLOCKED'
  | 'PRINTER_NOT_SELECTED'
  | 'PRINTER_NOT_FOUND'
  | 'PRINTER_UNAVAILABLE'
  | 'RENDER_FAILED'
  | 'UNSUPPORTED'
  /** The agent refuses pixel (driver image) jobs - NanoPrint. */
  | 'PIXEL_UNSUPPORTED'
  | 'PRINT_FAILED';

/**
 * Till-facing messages. `agent` is the print service this computer uses, so the
 * message names the program the cashier actually has to look at.
 */
const message = (code: ThermalPrintErrorCode, agent: string): string =>
  ({
    AGENT_UNAVAILABLE: `Direct printing is unavailable. ${agent} is not installed or not running on this computer - start ${agent} and try again.`,
    AGENT_BLOCKED: `${agent} is running but this site is not allowed to print on this computer. Open ${agent} and allow this site (tick "Remember this decision"), then try again.`,
    PRINTER_NOT_SELECTED: 'No thermal printer is selected on this computer. Choose one in Settings → Printer.',
    PRINTER_NOT_FOUND: 'The selected thermal printer was not found on this computer.',
    PRINTER_UNAVAILABLE: 'The thermal printer appears to be unavailable. Check that it is on, connected and has paper.',
    RENDER_FAILED: 'The document could not be prepared for printing.',
    UNSUPPORTED: `${agent} could not print this document the selected way. Check the printer language in Settings → Printer.`,
    PIXEL_UNSUPPORTED:
      'NanoPrint prints raw ESC/POS only, so the "Windows driver (image)" printer language cannot be used with it. Switch the printer language to ESC/POS, or switch the print service to QZ Tray.',
    PRINT_FAILED: 'Printing failed.',
  })[code];

/** A print failure with a message safe to show at the till (technical detail goes to the console only). */
export class ThermalPrintError extends Error {
  constructor(
    public readonly code: ThermalPrintErrorCode,
    public readonly detail?: unknown,
    agentLabel = 'The print service',
  ) {
    super(message(code, agentLabel));
    this.name = 'ThermalPrintError';
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error ?? ''));

/** Maps what the print agent and the OS print services report to a till-friendly error. */
export function classifyPrintError(error: unknown, agentLabel = 'The print service'): ThermalPrintError {
  if (error instanceof ThermalPrintError) return error;
  if (error instanceof AgentUnavailableError) return new ThermalPrintError('AGENT_UNAVAILABLE', error, agentLabel);
  const text = describe(error).toLowerCase();
  if (/could not be found|not found|no such printer/.test(text)) return new ThermalPrintError('PRINTER_NOT_FOUND', error, agentLabel);
  if (/blocked by client|permission|denied|not allowed/.test(text)) return new ThermalPrintError('AGENT_BLOCKED', error, agentLabel);
  if (/websocket|connection|not connected|closed/.test(text)) return new ThermalPrintError('AGENT_UNAVAILABLE', error, agentLabel);
  if (/offline|not available|unavailable|paused|error state|out of paper|printerexception|not accepting/.test(text)) {
    return new ThermalPrintError('PRINTER_UNAVAILABLE', error, agentLabel);
  }
  if (/unsupported|not supported|invalid (flavor|format)|unsupported data type/.test(text)) {
    return new ThermalPrintError('UNSUPPORTED', error, agentLabel);
  }
  return new ThermalPrintError('PRINT_FAILED', error, agentLabel);
}

/**
 * Blank lines added after every print (receipts, labels, loyalty cards, tests),
 * on top of the device's "feed after printing": the print head sits some way
 * below the tear bar, so without it the last line stays inside the printer and
 * back-to-back prints run into each other.
 */
export const RECEIPT_END_GAP_LINES = 2;

/** ESC/POS default line spacing is 1/6 inch; used to size the same gap as blank rows for the driver path. */
const LINE_MM = 25.4 / 6;

/** Total lines fed after a document of this type. */
export const feedLinesFor = (_type: ThermalDocumentType, settings: Pick<ThermalPrinterSettings, 'feedLines'>) =>
  settings.feedLines + RECEIPT_END_GAP_LINES;

/**
 * The end of every thermal print - receipts, variant barcode labels (each
 * copy), loyalty cards and test pages - drawn INTO the image rather than left to the
 * printer's feed command (some 58 mm printers ignore or shorten ESC d, which
 * left the website line inside the printer and receipts touching):
 *
 *   receipt content
 *   ~1.5 mm blank
 *   - - - - - - - -   dashed tear line
 *   ~8 mm blank        carries the last line and the tear line past the tear bar
 *
 * Blank image rows advance the paper on every printer that can print the
 * receipt at all. The device's feed setting is still sent afterwards as extra.
 */
export const RECEIPT_TAIL_MM = 8;
const RECEIPT_GAP_BEFORE_LINE_MM = 1.5;

export function withReceiptEnd(bitmap: MonoBitmap, dpi: number): MonoBitmap {
  const perMm = dotsPerMm(dpi);
  const before = Math.round(RECEIPT_GAP_BEFORE_LINE_MM * perMm);
  const lineRows = Math.max(2, Math.round(perMm / 3)); // ~0.4 mm thick
  const tail = Math.round(RECEIPT_TAIL_MM * perMm);
  const { width } = bitmap;
  const height = bitmap.height + before + lineRows + tail;
  const data = new Uint8Array(width * height);
  data.set(bitmap.data);
  const dash = Math.max(4, perMm * 1.5); // 1.5 mm dashes, 1 mm gaps
  const gap = Math.max(3, perMm);
  for (let r = 0; r < lineRows; r += 1) {
    const rowStart = (bitmap.height + before + r) * width;
    for (let x = 0; x < width; x += 1) {
      if (x % (dash + gap) < dash) data[rowStart + x] = 1;
    }
  }
  return { width, height, data };
}


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
 * the print agent / the spooler at the same moment.
 */
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
}

/** What was last handed to the print agent - command bytes and sizes only, never customer data. */
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
  /** Which local print agent the job was handed to. */
  service: ThermalPrinterSettings['service'];
  transport: { type: 'raw' | 'pixel'; format: 'command' | 'image'; flavor: 'base64' };
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
 * Prints a document on this computer's thermal printer through the print agent
 * it is set to use. Resolves once the agent has accepted the job; rejects with
 * a ThermalPrintError.
 */
export function printThermalDocument(job: ThermalPrintJob, settings: ThermalPrinterSettings = loadPrinterSettings()): Promise<{ printer: string; heightDots: number }> {
  return enqueue(() => runPrintJob(job, settings));
}

async function runPrintJob(job: ThermalPrintJob, settings: ThermalPrinterSettings): Promise<{ printer: string; heightDots: number }> {
  const agent = printAgent(settings.service);
  const printer = settings.printerName;
  if (!printer) throw new ThermalPrintError('PRINTER_NOT_SELECTED', undefined, agent.label);
  // The driver path sends an image through the OS driver, which NanoPrint
  // refuses outright. Caught here so the till is told what to change rather
  // than seeing the agent's own wire error.
  if (settings.language === 'driver' && !agent.supportsPixel) {
    throw new ThermalPrintError('PIXEL_UNSUPPORTED', undefined, agent.label);
  }
  const copies = Math.max(1, Math.min(100, Math.round(job.copies ?? 1)));

  try {
    await printTransport.ensureConnected(settings);
    if (!(await printTransport.printerExists(printer, settings))) throw new ThermalPrintError('PRINTER_NOT_FOUND', undefined, agent.label);

    const content = await renderJob(job, settings);
    if (content.height === 0) throw new ThermalPrintError('RENDER_FAILED', 'empty document', agent.label);
    // Every print ends with the same tear line and blank tail; label copies each get their own.
    const bitmap = withReceiptEnd(content, settings.dpi);

    const base = {
      at: new Date().toISOString(),
      type: job.type,
      printer,
      language: settings.language,
      rasterMode: settings.rasterMode,
      bandHeight: settings.bandHeight,
      widthDots: bitmap.width,
      heightDots: bitmap.height,
      service: settings.service,
    };
    if (settings.language === 'escpos') {
      const bytes = encodeEscPosJob(Array.from({ length: copies }, () => bitmap), {
        feedLines: feedLinesFor(job.type, settings),
        autoCut: settings.autoCut,
        bandHeight: settings.bandHeight,
        rasterMode: settings.rasterMode,
      });
      const entry: PrintDiagnostics = { ...base, payload: describeEscPosJob(bytes), transport: { type: 'raw', format: 'command', flavor: 'base64' }, result: 'sent' };
      try {
        await printTransport.printRawBase64(printer, bytesToBase64(bytes), settings);
        recordDiagnostics(entry);
      } catch (error) {
        recordDiagnostics({ ...entry, result: 'failed', error: describe(error).slice(0, 200) });
        throw error;
      }
    } else {
      const page = withBlankRows(bitmap, Math.round(feedLinesFor(job.type, settings) * LINE_MM * dotsPerMm(settings.dpi)));
      const png = bitmapToCanvas(page).toDataURL('image/png').split(',')[1];
      recordDiagnostics({ ...base, payload: { pngBytes: Math.round((png.length * 3) / 4) }, transport: { type: 'pixel', format: 'image', flavor: 'base64' }, result: 'sent' });
      await printTransport.printImageBase64(
        printer,
        png,
        {
          widthMm: page.width / dotsPerMm(settings.dpi),
          heightMm: page.height / dotsPerMm(settings.dpi),
          dpi: settings.dpi,
          copies,
        },
        settings,
      );
    }
    return { printer, heightDots: bitmap.height };
  } catch (error) {
    const classified = classifyPrintError(error, agent.label);
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
  line('Direct Print Test', 'text-align:center;font-weight:700');
  line(`Service: ${printAgent(settings.service).label}`);
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
  const agent = printAgent(settings.service);
  const printer = settings.printerName;
  if (!printer) throw new ThermalPrintError('PRINTER_NOT_SELECTED', undefined, agent.label);
  if (settings.language !== 'escpos') throw new ThermalPrintError('UNSUPPORTED', 'raw text test needs ESC/POS', agent.label);
  try {
    await printTransport.ensureConnected(settings);
    if (!(await printTransport.printerExists(printer, settings))) throw new ThermalPrintError('PRINTER_NOT_FOUND', undefined, agent.label);
    const rule = '================================';
    const bytes = encodeEscPosText(
      // Plain line feeds after the dashed line carry the text past the tear bar even if ESC d is ignored.
      [rule, 'RetailerSuites.com', 'RAW TEXT TEST', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', rule, '', '- - - - - - - - - - - - - - - -', '', '', '', ''],
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
      service: settings.service,
      transport: { type: 'raw', format: 'command', flavor: 'base64' },
      result: 'sent',
    };
    await printTransport.printRawBase64(printer, bytesToBase64(bytes), settings);
    recordDiagnostics(entry);
    return { printer, heightDots: 0 };
  } catch (error) {
    throw classifyPrintError(error, agent.label);
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
