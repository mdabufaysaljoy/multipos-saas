import * as React from 'react';
import type { QzHidDevice } from 'qz-tray';
import { watchHidDevices } from '@/features/printing/qzTray';

/**
 * Is the barcode scanner attached right now?
 *
 * Green when it is, grey when it is not - and worked out automatically, with
 * nothing to click. Three sources feed it, best first:
 *
 *  1. **QZ Tray** (the till's own helper, already used for direct printing).
 *     It sees the computer's real USB/HID devices and reports attach and detach
 *     events, so the dot follows the scanner being plugged in or pulled out
 *     within seconds. Nothing is ever connected or claimed by this code - it
 *     only reads the device list when QZ is already running.
 *  2. **WebHID**, when the browser has already been given access to the device.
 *     It fires `connect` / `disconnect` the same way. No prompt is ever raised.
 *  3. **Recent scan.** Most USB scanners present themselves as a keyboard, and
 *     browsers refuse HID access to keyboards, so without QZ there is nothing
 *     to see until the scanner is used. A scan seen in the last few minutes
 *     therefore counts as attached; it expires by itself instead of insisting
 *     the scanner is there hours after it was unplugged.
 *
 * The key listener only observes timing. It never handles, blocks or changes a
 * key press.
 */

const LAST_SEEN_KEY = 'pos.scanner.lastSeenAt';

/** How long a scan keeps the scanner "attached" when nothing better is known. */
const RECENT_FOR_MS = 5 * 60 * 1000;
/** How often recency is re-evaluated, so the dot goes grey on its own. */
const TICK_MS = 5_000;
/** A scanner types a whole code faster than any person; slower gaps are typing. */
const MAX_GAP_MS = 35;
const MIN_LENGTH = 4;

/**
 * How a scanner names itself. Matched against the manufacturer and product
 * strings the device reports, so a plain keyboard is never mistaken for one.
 */
const SCANNER_WORDS = [
  'barcode',
  'bar code',
  'scanner',
  'scan',
  'imager',
  'symbol',
  'honeywell',
  'zebra',
  'datalogic',
  'newland',
  'netum',
  'tera',
  'symcode',
  'opticon',
  'zebex',
  'eyoyo',
  'inateck',
  'wcs',
  'pos hid',
  'hid kbw',
];

/** Whether a device's own description says it is a scanner. Exported for tests. */
export const looksLikeScanner = (text: string) => {
  const lower = text.toLowerCase();
  return SCANNER_WORDS.some((word) => lower.includes(word));
};

const qzScanner = (devices: QzHidDevice[]): QzHidDevice | null =>
  devices.find((device) => looksLikeScanner(`${device.manufacturer ?? ''} ${device.product ?? ''}`)) ?? null;

const qzLabel = (device: QzHidDevice) => (device.product ?? device.manufacturer ?? 'Barcode scanner').trim() || 'Barcode scanner';

interface HidDeviceLike {
  vendorId: number;
  productId: number;
  productName?: string;
}

interface HidLike extends EventTarget {
  getDevices: () => Promise<HidDeviceLike[]>;
}

const webHid = (): HidLike | null => (navigator as Navigator & { hid?: HidLike }).hid ?? null;

const webHidLabel = (device: HidDeviceLike) =>
  device.productName?.trim() || `Scanner ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;

const readLastSeen = (): number => {
  try {
    return Number(window.localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};

export type ScannerSource = 'device' | 'recent-scan' | null;

export interface ScannerPresence {
  /** True while the scanner is attached (or was used a moment ago). */
  connected: boolean;
  /** Kept for callers that only ask whether scanning works. */
  ready: boolean;
  /** What the answer is based on, for the label. */
  source: ScannerSource;
  deviceName: string | null;
  lastScanAt: number | null;
  secondsSinceScan: number | null;
}

export function useScannerPresence(): ScannerPresence {
  const [hidDevice, setHidDevice] = React.useState<{ name: string } | null>(null);
  const [qzDevice, setQzDevice] = React.useState<{ name: string } | null>(null);
  const [lastSeenAt, setLastSeenAt] = React.useState(readLastSeen);
  const [now, setNow] = React.useState(() => Date.now());

  // ---- 1. the computer's own device list, through QZ Tray ----
  React.useEffect(() => {
    const stop = watchHidDevices((devices) => {
      const match = qzScanner(devices);
      setQzDevice(match ? { name: qzLabel(match) } : null);
    });
    return stop;
  }, []);

  // ---- 2. WebHID, only for a device the browser already has access to ----
  React.useEffect(() => {
    const api = webHid();
    if (!api) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        // getDevices() never prompts, and returns only devices attached NOW.
        const devices = await api.getDevices();
        if (cancelled) return;
        const match = devices.find((device) => looksLikeScanner(webHidLabel(device))) ?? devices[0] ?? null;
        setHidDevice(match ? { name: webHidLabel(match) } : null);
      } catch {
        if (!cancelled) setHidDevice(null);
      }
    };

    void refresh();
    const onChange = () => void refresh();
    api.addEventListener('connect', onChange);
    api.addEventListener('disconnect', onChange);
    // A device can be plugged or unplugged while this tab is in the background.
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onChange);

    return () => {
      cancelled = true;
      api.removeEventListener('connect', onChange);
      api.removeEventListener('disconnect', onChange);
      window.removeEventListener('focus', onChange);
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);

  // ---- 3. scans seen on this computer ----
  React.useEffect(() => {
    let buffer = 0;
    let lastKeyAt = 0;

    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const at = Date.now();
      const gap = at - lastKeyAt;
      lastKeyAt = at;
      if (gap > MAX_GAP_MS) buffer = 0;

      if (event.key === 'Enter') {
        if (buffer >= MIN_LENGTH) {
          try {
            window.localStorage.setItem(LAST_SEEN_KEY, String(at));
          } catch {
            // Storage unavailable: the state still holds for this session.
          }
          setLastSeenAt(at);
          setNow(at);
        }
        buffer = 0;
        return;
      }
      if (event.key.length === 1) buffer += 1;
    };

    window.addEventListener('keydown', handler, true);
    // Re-evaluate often enough that the dot goes grey on its own.
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.clearInterval(timer);
    };
  }, []);

  const device = qzDevice ?? hidDevice;
  const sinceScan = lastSeenAt > 0 ? now - lastSeenAt : null;
  const usedRecently = sinceScan !== null && sinceScan < RECENT_FOR_MS;
  const connected = Boolean(device) || usedRecently;

  return {
    connected,
    ready: connected,
    source: device ? 'device' : usedRecently ? 'recent-scan' : null,
    deviceName: device?.name ?? null,
    lastScanAt: lastSeenAt > 0 ? lastSeenAt : null,
    secondsSinceScan: sinceScan === null ? null : Math.floor(sinceScan / 1000),
  };
}
