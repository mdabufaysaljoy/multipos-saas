import * as React from 'react';

/**
 * Live status of the handheld barcode scanner.
 *
 * Two sources, in this order:
 *
 *  1. **WebHID** - the only way a browser can actually SEE the hardware. Once
 *     the scanner has been paired here (a one-off permission prompt), the
 *     browser fires `connect` / `disconnect` as it is plugged and unplugged, so
 *     the indicator is genuinely live: green the moment it is attached, grey
 *     the moment it is removed.
 *  2. **Recent scan** - the fallback for a scanner that cannot be paired
 *     (most USB scanners present themselves as a keyboard, and browsers refuse
 *     HID access to keyboards). A scan seen in the last few minutes means it
 *     was working a moment ago - which is all that can honestly be claimed, so
 *     that is exactly what the UI says. It expires, instead of insisting the
 *     scanner is "connected" hours after it was unplugged.
 *
 * The key listener only observes timing. It never handles, blocks or changes a
 * key press.
 */

const DEVICE_KEY = 'pos.scanner.device.v1';
const LAST_SEEN_KEY = 'pos.scanner.lastSeenAt';

/** How long a scan keeps the "used a moment ago" state. */
const RECENT_FOR_MS = 5 * 60 * 1000;
/** How often the recency is re-evaluated, so the state decays on its own. */
const TICK_MS = 5_000;
/** A scanner types a whole code faster than any person; slower gaps are typing. */
const MAX_GAP_MS = 35;
const MIN_LENGTH = 4;

export type ScannerStatus = 'connected' | 'recent' | 'idle';

interface HidDeviceLike {
  vendorId: number;
  productId: number;
  productName?: string;
}

interface HidLike extends EventTarget {
  getDevices: () => Promise<HidDeviceLike[]>;
  requestDevice: (options: { filters: { vendorId?: number; productId?: number }[] }) => Promise<HidDeviceLike[]>;
}

const hid = (): HidLike | null => (navigator as Navigator & { hid?: HidLike }).hid ?? null;

interface PairedDevice {
  vendorId: number;
  productId: number;
  name: string;
}

const readPaired = (): PairedDevice | null => {
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PairedDevice;
    return typeof parsed?.vendorId === 'number' && typeof parsed?.productId === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

const writePaired = (device: PairedDevice | null) => {
  try {
    if (device) window.localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    else window.localStorage.removeItem(DEVICE_KEY);
  } catch {
    // Storage unavailable: pairing then lasts for this session only.
  }
};

const readLastSeen = (): number => {
  try {
    return Number(window.localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};

const sameDevice = (device: HidDeviceLike, paired: PairedDevice) => device.vendorId === paired.vendorId && device.productId === paired.productId;

const deviceLabel = (device: HidDeviceLike) =>
  device.productName?.trim() || `Scanner ${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')}`;

export interface ScannerPresence {
  status: ScannerStatus;
  /** Kept for callers that only care whether scanning is known to work. */
  ready: boolean;
  /** The browser can pair hardware (Chrome and Edge over HTTPS or localhost). */
  canPair: boolean;
  /** A device has been paired on this computer. */
  paired: boolean;
  deviceName: string | null;
  /** When the last scan was seen on this device, or null. */
  lastScanAt: number | null;
  /** Seconds since the last scan, for the label. */
  secondsSinceScan: number | null;
  /** Opens the browser's device picker. Must be called from a click. */
  pair: () => Promise<boolean>;
  /** Stops tracking the paired device (the browser keeps the permission). */
  unpair: () => void;
}

export function useScannerPresence(): ScannerPresence {
  const [paired, setPaired] = React.useState<PairedDevice | null>(readPaired);
  const [connected, setConnected] = React.useState<HidDeviceLike | null>(null);
  const [lastSeenAt, setLastSeenAt] = React.useState(readLastSeen);
  const [now, setNow] = React.useState(() => Date.now());

  // ---- 1. the hardware itself, while the browser can see it ----
  React.useEffect(() => {
    const api = hid();
    if (!api) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const devices = await api.getDevices();
        if (cancelled) return;
        const current = readPaired();
        // Only a device that is attached RIGHT NOW comes back from getDevices().
        const match = current ? devices.find((device) => sameDevice(device, current)) : devices[0];
        setConnected(match ?? null);
      } catch {
        if (!cancelled) setConnected(null);
      }
    };

    void refresh();
    const onChange = () => void refresh();
    api.addEventListener('connect', onChange);
    api.addEventListener('disconnect', onChange);
    // A device can be plugged or unplugged while this tab is in the background,
    // and permission can be revoked from the browser's own UI.
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onChange);

    return () => {
      cancelled = true;
      api.removeEventListener('connect', onChange);
      api.removeEventListener('disconnect', onChange);
      window.removeEventListener('focus', onChange);
      document.removeEventListener('visibilitychange', onChange);
    };
  }, [paired]);

  // ---- 2. scans seen on this device ----
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
    // Re-evaluate often enough that "used a moment ago" fades on its own.
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.clearInterval(timer);
    };
  }, []);

  const pair = React.useCallback(async () => {
    const api = hid();
    if (!api) return false;
    try {
      const [device] = await api.requestDevice({ filters: [] });
      if (!device) return false;
      const chosen = { vendorId: device.vendorId, productId: device.productId, name: deviceLabel(device) };
      writePaired(chosen);
      setPaired(chosen);
      setConnected(device);
      return true;
    } catch {
      return false;
    }
  }, []);

  const unpair = React.useCallback(() => {
    writePaired(null);
    setPaired(null);
    setConnected(null);
  }, []);

  const sinceScan = lastSeenAt > 0 ? now - lastSeenAt : null;
  const usedRecently = sinceScan !== null && sinceScan < RECENT_FOR_MS;
  const status: ScannerStatus = connected ? 'connected' : usedRecently ? 'recent' : 'idle';

  return {
    status,
    ready: status !== 'idle',
    canPair: Boolean(hid()),
    paired: Boolean(paired),
    deviceName: connected ? deviceLabel(connected) : (paired?.name ?? null),
    lastScanAt: lastSeenAt > 0 ? lastSeenAt : null,
    secondsSinceScan: sinceScan === null ? null : Math.floor(sinceScan / 1000),
    pair,
    unpair,
  };
}
