import QRCode from 'qrcode';

/** QR modules for a value (error correction M: survives a scuffed label). */
export function qrMatrix(value: string): { size: number; isDark: (row: number, col: number) => boolean } {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, isDark: (row, col) => Boolean(qr.modules.get(row, col)) };
}

/**
 * Draws a QR code on a canvas with WHOLE-dot modules and a 4-module quiet zone,
 * as large as fits the box. Used both for the on-screen label and for the
 * printer-resolution overlay, so the printed code is never a scaled screenshot.
 */
export function drawQr(ctx: CanvasRenderingContext2D, value: string, box: { x: number; y: number; size: number }) {
  const { size, isDark } = qrMatrix(value);
  const total = size + 8;
  const moduleDots = Math.max(1, Math.floor(box.size / total));
  const drawn = moduleDots * total;
  const x0 = Math.round(box.x + (box.size - drawn) / 2) + 4 * moduleDots;
  const y0 = Math.round(box.y + (box.size - drawn) / 2) + 4 * moduleDots;
  ctx.fillStyle = '#fff';
  ctx.fillRect(Math.round(box.x), Math.round(box.y), Math.round(box.size), Math.round(box.size));
  ctx.fillStyle = '#000';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isDark(row, col)) ctx.fillRect(x0 + col * moduleDots, y0 + row * moduleDots, moduleDots, moduleDots);
    }
  }
  return { moduleDots };
}
