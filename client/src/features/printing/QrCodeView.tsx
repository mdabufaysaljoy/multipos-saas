import * as React from 'react';
import { drawQr } from './qr';

/**
 * A QR code for on-screen documents. The printed version is redrawn at printer
 * resolution by the rasteriser (via `data-qr-value`), never scaled from this.
 */
export function QrCodeView({ value, sizeMm, className }: { value: string; sizeMm: number; className?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const px = Math.round((sizeMm / 25.4) * 96 * Math.max(2, window.devicePixelRatio || 1));
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      drawQr(ctx, value, { x: 0, y: 0, size: px });
    } catch {
      ctx.clearRect(0, 0, px, px);
    }
  }, [value, sizeMm]);
  return (
    <div data-qr-value={value} className={className} style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm`, margin: '0 auto' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
