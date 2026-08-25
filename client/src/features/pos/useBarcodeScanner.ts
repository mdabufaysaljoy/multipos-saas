import * as React from 'react';

interface Options {
  onScan: (barcode: string) => void;
  /**
   * Scanners emit a whole code in a few milliseconds; a human cannot. Anything
   * slower than this between keystrokes is treated as typing, not scanning.
   */
  maxKeystrokeGapMs?: number;
  minLength?: number;
  enabled?: boolean;
}

/**
 * Global listener for USB/Bluetooth barcode scanners.
 *
 * These devices act as keyboards: they "type" the code and press Enter. The
 * only reliable way to tell them apart from a person is SPEED, so this hook
 * buffers keystrokes and only treats the buffer as a scan when the characters
 * arrived faster than a human could type them.
 *
 * It deliberately ignores keystrokes while a text field is focused, so a
 * cashier typing "Black shirt" into the search box is never mistaken for a scan.
 */
export function useBarcodeScanner({
  onScan,
  maxKeystrokeGapMs = 35,
  minLength = 4,
  enabled = true,
}: Options) {
  const buffer = React.useRef('');
  const lastKeyAt = React.useRef(0);
  // Keeps the effect from re-subscribing on every render.
  const onScanRef = React.useRef(onScan);
  onScanRef.current = onScan;

  React.useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      // A field explicitly marked as a scan target still receives scans; every
      // other input is left alone.
      if (isTypingField && target?.dataset.barcodeTarget !== 'true') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const now = Date.now();
      const gap = now - lastKeyAt.current;
      lastKeyAt.current = now;

      // Too slow: this is a person. Start a fresh buffer from this keystroke.
      if (gap > maxKeystrokeGapMs) buffer.current = '';

      if (event.key === 'Enter') {
        const code = buffer.current.trim();
        buffer.current = '';
        if (code.length >= minLength) {
          event.preventDefault();
          onScanRef.current(code);
        }
        return;
      }

      // Scanners send printable characters one at a time.
      if (event.key.length === 1) buffer.current += event.key;
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled, maxKeystrokeGapMs, minLength]);
}
