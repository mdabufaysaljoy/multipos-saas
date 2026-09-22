/**
 * ESC/POS encoding of a 1-bit raster. Pure functions, no DOM, no QZ.
 *
 * Only standard commands are used, so this works on practically every ESC/POS
 * thermal printer without assuming fonts, code pages or native barcode support:
 *
 *   ESC @            1B 40                initialise (resets modes a previous job may have left on)
 *   NUL × 64         00 …                 resync padding: ESC @ clears the print buffer, and on
 *                                         low-cost printers bytes arriving during the reset can be
 *                                         dropped. NUL is ignored in text mode, so padding - not the
 *                                         first raster header - absorbs that. (Without it the first
 *                                         band's image bytes printed as text: see
 *                                         docs/PRINTING_BUG_ANALYSIS.md.)
 *   GS v 0 m xL xH yL yH d...            raster bit image (m = 0), in SMALL bands (default 24 rows):
 *                                         each band is a complete command, so any transmission error
 *                                         spoils at most one thin band and the printer resyncs at the next
 *   ESC * 33 nL nH d...                  alternative 24-dot column bit image for clones with
 *                                         incomplete GS v 0 support (device setting)
 *   ESC d n          1B 64 n              feed n lines
 *   GS V 66 0        1D 56 42 00          partial cut after feeding - ONLY when the
 *                                         device setting says the printer has a cutter
 *
 * The bitmap is exactly as tall as the content, so the paper used follows the
 * receipt: a 2-line receipt is short, a 50-line receipt is long. Nothing here
 * accepts text or commands from users - input is only pixels.
 */

/** One byte per pixel: 1 = black (print), 0 = white. Row-major. */
export interface MonoBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface EscPosOptions {
  /** Lines fed after the last image. */
  feedLines: number;
  /** Send a cut command after each copy. */
  autoCut: boolean;
  /** Lines fed between copies (labels). */
  gapLines?: number;
  /** Rows per GS v 0 block (default 24) - small blocks limit damage and fit small receive buffers. */
  bandHeight?: number;
  /** Raster command: GS v 0 (default) or ESC * 24-dot columns (compatibility). */
  rasterMode?: RasterMode;
  /** NUL bytes after ESC @ (default 64). */
  syncPadding?: number;
}

export type RasterMode = 'gsv0' | 'escstar';
export const DEFAULT_BAND_HEIGHT = 24;
const DEFAULT_SYNC_PADDING = 64;

const ESC = 0x1b;
const GS = 0x1d;

/** Removes blank rows at the top and bottom (keeping a small margin), so no paper is wasted. */
export function trimBlankRows(bitmap: MonoBitmap, keep = 8): MonoBitmap {
  const { width, height, data } = bitmap;
  const rowHasInk = (y: number) => {
    const start = y * width;
    for (let x = 0; x < width; x += 1) if (data[start + x]) return true;
    return false;
  };
  let top = 0;
  while (top < height && !rowHasInk(top)) top += 1;
  if (top === height) return { width, height: 0, data: new Uint8Array(0) };
  let bottom = height - 1;
  while (bottom > top && !rowHasInk(bottom)) bottom -= 1;
  const from = Math.max(0, top - keep);
  const to = Math.min(height - 1, bottom + keep);
  return { width, height: to - from + 1, data: data.slice(from * width, (to + 1) * width) };
}

/** Packs pixels 8 per byte, most significant bit = leftmost dot. */
export function packRows(bitmap: MonoBitmap): { bytesPerRow: number; rows: Uint8Array } {
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  const rows = new Uint8Array(bytesPerRow * bitmap.height);
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      if (bitmap.data[y * bitmap.width + x]) rows[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bytesPerRow, rows };
}

/** GS v 0 raster in bands of `band` rows. */
function pushRasterGsv0(out: number[], image: MonoBitmap, band: number) {
  const { bytesPerRow, rows } = packRows(image);
  for (let y = 0; y < image.height; y += band) {
    const h = Math.min(band, image.height - y);
    out.push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
    const chunk = rows.subarray(y * bytesPerRow, (y + h) * bytesPerRow);
    for (let i = 0; i < chunk.length; i += 1) out.push(chunk[i]);
  }
}

/**
 * ESC * mode 33 (24-dot double density): each stripe is 24 rows, sent column
 * by column as 3 bytes (top dot = MSB), followed by LF with line spacing set to
 * exactly 24 dots so stripes join without gaps.
 */
function pushRasterEscStar(out: number[], image: MonoBitmap) {
  const { width, height, data } = image;
  out.push(ESC, 0x33, 24);
  for (let y0 = 0; y0 < height; y0 += 24) {
    out.push(ESC, 0x2a, 33, width & 0xff, (width >> 8) & 0xff);
    for (let x = 0; x < width; x += 1) {
      for (let k = 0; k < 3; k += 1) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit += 1) {
          const y = y0 + k * 8 + bit;
          if (y < height && data[y * width + x]) byte |= 0x80 >> bit;
        }
        out.push(byte);
      }
    }
    out.push(0x0a);
  }
  out.push(ESC, 0x32);
}

/** Encodes one or more images (e.g. label copies) into a single print job. */
export function encodeEscPosJob(images: MonoBitmap[], options: EscPosOptions): Uint8Array {
  const band = Math.max(1, Math.min(options.bandHeight ?? DEFAULT_BAND_HEIGHT, 2047));
  const feed = Math.max(0, Math.min(255, Math.round(options.feedLines)));
  const gap = Math.max(0, Math.min(255, Math.round(options.gapLines ?? 2)));
  const padding = Math.max(0, Math.min(1024, Math.round(options.syncPadding ?? DEFAULT_SYNC_PADDING)));
  const out: number[] = [ESC, 0x40];
  for (let i = 0; i < padding; i += 1) out.push(0x00);

  images.forEach((image, index) => {
    if (options.rasterMode === 'escstar') pushRasterEscStar(out, image);
    else pushRasterGsv0(out, image, band);
    const last = index === images.length - 1;
    const lines = last || options.autoCut ? feed : gap;
    if (lines > 0) out.push(ESC, 0x64, lines);
    if (options.autoCut) out.push(GS, 0x56, 0x42, 0x00);
  });

  return Uint8Array.from(out);
}

/** Plain ASCII text as ESC/POS (diagnostics only: no image, no user data). */
export function encodeEscPosText(lines: string[], options: Pick<EscPosOptions, 'feedLines' | 'autoCut' | 'syncPadding'>): Uint8Array {
  const out: number[] = [ESC, 0x40];
  const padding = Math.max(0, Math.round(options.syncPadding ?? DEFAULT_SYNC_PADDING));
  for (let i = 0; i < padding; i += 1) out.push(0x00);
  for (const line of lines) {
    for (const char of line) {
      const code = char.charCodeAt(0);
      // Printable ASCII only - anything else becomes '?', never a control byte.
      out.push(code >= 0x20 && code < 0x7f ? code : 0x3f);
    }
    out.push(0x0a);
  }
  const feed = Math.max(0, Math.min(255, Math.round(options.feedLines)));
  if (feed > 0) out.push(ESC, 0x64, feed);
  if (options.autoCut) out.push(GS, 0x56, 0x42, 0x00);
  return Uint8Array.from(out);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/**
 * A safe description of a job for diagnostics: sizes and COMMAND bytes only
 * (image data is never echoed, and the payload holds no customer text).
 */
export function describeEscPosJob(bytes: Uint8Array) {
  let gsv0 = 0;
  let escStar = 0;
  let firstHeader = '';
  for (let i = 0; i < bytes.length - 2; i += 1) {
    if (bytes[i] === GS && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
      if (!firstHeader) firstHeader = hex(bytes.subarray(i, i + 8));
      gsv0 += 1;
      const bpr = bytes[i + 4] | (bytes[i + 5] << 8);
      const h = bytes[i + 6] | (bytes[i + 7] << 8);
      i += 7 + bpr * h;
    } else if (bytes[i] === ESC && bytes[i + 1] === 0x2a && bytes[i + 2] === 33) {
      if (!firstHeader) firstHeader = hex(bytes.subarray(i, i + 5));
      escStar += 1;
      const w = bytes[i + 3] | (bytes[i + 4] << 8);
      i += 4 + w * 3;
    }
  }
  return {
    bytes: bytes.length,
    gsv0Bands: gsv0,
    escStarStripes: escStar,
    firstRasterHeader: firstHeader,
    head: hex(bytes.subarray(0, 4)),
    tail: hex(bytes.subarray(Math.max(0, bytes.length - 8))),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
