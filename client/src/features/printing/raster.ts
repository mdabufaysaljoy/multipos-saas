import { toCanvas } from 'html-to-image';
import JsBarcode from 'jsbarcode';
import type { MonoBitmap } from './escpos';
import { drawQr } from './qr';

/**
 * Turns an already-rendered receipt / label / card (the SAME React component
 * the screen shows) into a 1-bit bitmap exactly `targetWidthDots` wide and
 * exactly as tall as its content.
 *
 * Text and layout come from the browser's own rendering. Barcodes and QR codes
 * are then redrawn on top at printer resolution (whole-dot module widths, quiet
 * zones, pure black on white), because a scaled screenshot of a barcode would
 * have uneven bars. Elements opt in with:
 *   data-barcode-value / data-barcode-format   (jsbarcode formats, e.g. EAN13, CODE128)
 *   data-qr-value
 */
export interface RasterOptions {
  /** Width of the printed line in dots (the printer's printable width). */
  targetWidthDots: number;
  /** Width the document itself should occupy (labels narrower than the roll are centred). */
  contentWidthDots?: number;
  /** Luminance below this prints black (0-255). */
  threshold?: number;
}

export interface RasterResult {
  bitmap: MonoBitmap;
  /** Black-and-white preview/driver image of the exact bitmap. */
  canvas: HTMLCanvasElement;
}

const BARCODE_QUIET_MODULES = 10;

/**
 * `ui-*` / `system-ui` font keywords resolve in the page but NOT inside the
 * image the capture is drawn from, so text would render in a different font
 * than it was measured in (wrapped lines, blank gaps). The capture copy uses
 * concrete installed fonts instead, identical for measuring and drawing.
 */
const CONCRETE_FONTS: Record<string, string> = {
  'ui-monospace': "Menlo, Consolas, 'Liberation Mono', 'Courier New'",
  'ui-sans-serif': "'Helvetica Neue', 'Segoe UI', Arial",
  'system-ui': "'Helvetica Neue', 'Segoe UI', Arial",
  '-apple-system': "'Helvetica Neue', 'Segoe UI', Arial",
  blinkmacsystemfont: "'Helvetica Neue', 'Segoe UI', Arial",
  'ui-serif': "Georgia, 'Times New Roman'",
};
const concreteFontFamily = (family: string) =>
  family
    .split(',')
    .map((part) => {
      const key = part.trim().replace(/^["']|["']$/g, '').toLowerCase();
      return CONCRETE_FONTS[key] ?? part.trim();
    })
    .join(', ');

/**
 * An off-screen copy of the document with concrete fonts, so the screen never
 * flickers and the capture is measured and drawn with the same font.
 */
function captureCopy(element: HTMLElement) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;background:#fff;pointer-events:none;';
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';
  clone.style.width = `${element.offsetWidth}px`;
  const originals = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!copy?.style) return;
    copy.style.fontFamily = concreteFontFamily(getComputedStyle(original).fontFamily);
  });
  // Codes are redrawn at printer resolution over their boxes; the screen
  // versions are hidden (keeping their space) so none of their pixels - e.g.
  // digit glyphs overhanging the SVG box - survive next to the redraw.
  clone.querySelectorAll<HTMLElement | SVGElement>('[data-barcode-value], [data-qr-value]').forEach((node) => {
    node.style.visibility = 'hidden';
  });
  host.appendChild(clone);
  document.body.appendChild(host);
  freezeLineBreaks(clone);
  return { clone, dispose: () => host.remove() };
}

/**
 * The capture re-lays out text itself, and a line that only just fits on
 * screen can break differently there (leaving a blank line or pushing text
 * down). So the copy's line breaks are measured here and written in as real
 * newlines, and wrapping is switched off: the capture can only draw the same
 * lines in the same places the layout measured.
 */
function freezeLineBreaks(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.trim()) textNodes.push(node as Text);
  }
  const range = document.createRange();
  const breaks = new Map<Text, number[]>();
  for (const text of textNodes) {
    const found: number[] = [];
    let previousTop: number | null = null;
    for (let i = 0; i < text.data.length; i += 1) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      if (previousTop !== null && rect.top > previousTop + 1) found.push(i);
      previousTop = rect.top;
    }
    breaks.set(text, found);
  }
  // Apply after measuring everything, so earlier edits cannot move later text.
  for (const [text, found] of breaks) {
    let value = text.data;
    for (let k = found.length - 1; k >= 0; k -= 1) {
      const at = found[k];
      value = /\s/.test(value[at - 1] ?? '') ? `${value.slice(0, at - 1)}\n${value.slice(at)}` : `${value.slice(0, at)}\n${value.slice(at)}`;
    }
    text.data = value;
    const parent = text.parentElement;
    if (parent) parent.style.whiteSpace = found.length ? 'pre' : 'nowrap';
  }
}

async function captureCanvas(element: HTMLElement, pixelRatio: number, width: number, height: number) {
  const options = {
    pixelRatio,
    width,
    height,
    backgroundColor: '#ffffff',
    // System fonts only: faster, and nothing is fetched from font CDNs at print time.
    skipFonts: true,
    style: { margin: '0', boxShadow: 'none', transform: 'none' },
  };
  try {
    return await toCanvas(element, options);
  } catch {
    // A logo that cannot be fetched must not stop the receipt: print without images.
    return toCanvas(element, { ...options, filter: (node) => !(node instanceof HTMLImageElement) });
  }
}

/** Redraws a barcode with an integer number of dots per module, centred in its box. */
function drawBarcode(ctx: CanvasRenderingContext2D, value: string, format: string, box: { x: number; y: number; w: number; h: number }) {
  // First pass: how many modules wide is this symbol?
  const probe = document.createElement('canvas');
  JsBarcode(probe, value, { format, width: 1, height: 10, margin: 0, displayValue: false });
  const modules = probe.width;
  if (!modules) return;

  let moduleDots = Math.max(1, Math.floor(box.w / (modules + 2 * BARCODE_QUIET_MODULES)));
  const fontSize = Math.max(10, Math.round(box.h * 0.2));
  let symbol: HTMLCanvasElement | null = null;
  for (; moduleDots >= 1; moduleDots -= 1) {
    const candidate = document.createElement('canvas');
    JsBarcode(candidate, value, {
      format,
      width: moduleDots,
      height: Math.max(20, Math.round(box.h - fontSize - 4)),
      margin: 0,
      marginLeft: BARCODE_QUIET_MODULES * moduleDots,
      marginRight: BARCODE_QUIET_MODULES * moduleDots,
      displayValue: true,
      fontSize,
      textMargin: 2,
      background: '#ffffff',
      lineColor: '#000000',
    });
    symbol = candidate;
    if (candidate.width <= box.w || moduleDots === 1) break;
  }
  if (!symbol) return;
  ctx.fillStyle = '#fff';
  ctx.fillRect(Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h));
  ctx.imageSmoothingEnabled = false;
  const x = Math.round(box.x + (box.w - symbol.width) / 2);
  const y = Math.round(box.y + Math.max(0, (box.h - symbol.height) / 2));
  ctx.drawImage(symbol, x, y);
}

export async function rasterizeElement(source: HTMLElement, options: RasterOptions): Promise<RasterResult> {
  if (!source.offsetWidth || !source.offsetHeight) throw new Error('Nothing to print: the document is not rendered');
  const { clone: element, dispose } = captureCopy(source);
  try {
    return await rasterizeCopy(element, options);
  } finally {
    dispose();
  }
}

async function rasterizeCopy(element: HTMLElement, options: RasterOptions): Promise<RasterResult> {
  const cssWidth = element.offsetWidth;
  const cssHeight = element.offsetHeight;

  const target = Math.max(8, Math.floor(options.targetWidthDots));
  const content = Math.min(target, Math.max(8, Math.floor(options.contentWidthDots ?? target)));
  const pixelRatio = content / cssWidth;
  const captured = await captureCanvas(element, pixelRatio, cssWidth, cssHeight);

  const height = Math.max(1, Math.round(cssHeight * pixelRatio));
  const offsetX = Math.floor((target - content) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, target, height);
  ctx.drawImage(captured, offsetX, 0, content, height);

  // Printer-resolution codes on top of the captured layout.
  const origin = element.getBoundingClientRect();
  const boxOf = (node: Element) => {
    const r = node.getBoundingClientRect();
    return { x: offsetX + (r.left - origin.left) * pixelRatio, y: (r.top - origin.top) * pixelRatio, w: r.width * pixelRatio, h: r.height * pixelRatio };
  };
  element.querySelectorAll<HTMLElement | SVGElement>('[data-barcode-value]').forEach((node) => {
    const value = node.getAttribute('data-barcode-value');
    if (!value) return;
    try {
      drawBarcode(ctx, value, node.getAttribute('data-barcode-format') || 'CODE128', boxOf(node));
    } catch {
      // An invalid value keeps whatever the layout showed (its error text).
    }
  });
  element.querySelectorAll<HTMLElement>('[data-qr-value]').forEach((node) => {
    const value = node.getAttribute('data-qr-value');
    if (!value) return;
    const box = boxOf(node);
    drawQr(ctx, value, { x: box.x, y: box.y, size: Math.min(box.w, box.h) });
  });

  // Threshold to pure black/white: thermal heads cannot print grey.
  const threshold = options.threshold ?? 160;
  const pixels = ctx.getImageData(0, 0, target, height);
  const data = new Uint8Array(target * height);
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    const alpha = pixels.data[p + 3] / 255;
    const luma = (0.299 * pixels.data[p] + 0.587 * pixels.data[p + 1] + 0.114 * pixels.data[p + 2]) * alpha + 255 * (1 - alpha);
    const black = luma < threshold;
    data[i] = black ? 1 : 0;
    const v = black ? 0 : 255;
    pixels.data[p] = v;
    pixels.data[p + 1] = v;
    pixels.data[p + 2] = v;
    pixels.data[p + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);

  return { bitmap: { width: target, height, data }, canvas };
}

/** Canvas of an (already trimmed) bitmap, for the Windows-driver path and previews. */
export function bitmapToCanvas(bitmap: MonoBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = Math.max(1, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < bitmap.data.length; i += 1) {
    const v = bitmap.data[i] ? 0 : 255;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
