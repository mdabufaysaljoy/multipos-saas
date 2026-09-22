/**
 * ESC/POS encoding of a 1-bit raster. Pure functions, no DOM, no QZ.
 *
 * Only standard commands are used, so this works on practically every ESC/POS
 * thermal printer without assuming fonts, code pages or native barcode support:
 *
 *   ESC @            1B 40                initialise
 *   GS v 0 m xL xH yL yH d...            raster bit image (m = 0, normal size)
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
  /** Rows per GS v 0 block - some printers have small receive buffers. */
  bandHeight?: number;
}

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

/** Encodes one or more images (e.g. label copies) into a single print job. */
export function encodeEscPosJob(images: MonoBitmap[], options: EscPosOptions): Uint8Array {
  const band = Math.max(1, Math.min(options.bandHeight ?? 128, 2047));
  const feed = Math.max(0, Math.min(255, Math.round(options.feedLines)));
  const gap = Math.max(0, Math.min(255, Math.round(options.gapLines ?? 2)));
  const out: number[] = [ESC, 0x40];

  images.forEach((image, index) => {
    const { bytesPerRow, rows } = packRows(image);
    for (let y = 0; y < image.height; y += band) {
      const h = Math.min(band, image.height - y);
      out.push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
      const chunk = rows.subarray(y * bytesPerRow, (y + h) * bytesPerRow);
      for (let i = 0; i < chunk.length; i += 1) out.push(chunk[i]);
    }
    const last = index === images.length - 1;
    const lines = last || options.autoCut ? feed : gap;
    if (lines > 0) out.push(ESC, 0x64, lines);
    if (options.autoCut) out.push(GS, 0x56, 0x42, 0x00);
  });

  return Uint8Array.from(out);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
