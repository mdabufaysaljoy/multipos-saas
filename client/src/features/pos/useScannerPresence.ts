import * as React from 'react';

const STORAGE_KEY = 'pos.scanner.lastSeenAt';
/** A scanner seen within this long on this device still counts as ready. */
const FRESH_FOR_MS = 12 * 60 * 60 * 1000;
/** A scanner types a whole code faster than any person; slower gaps are typing. */
const MAX_GAP_MS = 35;
const MIN_LENGTH = 4;

const readLastSeen = (): number => {
  try {
    return Number(window.localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
};

/**
 * Whether a handheld barcode scanner has been detected on this device.
 *
 * Browsers cannot see scanner hardware: USB and Bluetooth scanners present
 * themselves as keyboards. What they CAN recognise is scanner input - a whole
 * code arriving faster than a person types, ending in Enter. So "ready" means
 * a real scan was seen on this device in the last 12 hours.
 *
 * It only observes key timing, everywhere on the page (including the focused
 * search box). It never handles, blocks or changes a key press.
 */
export function useScannerPresence() {
  const [lastSeenAt, setLastSeenAt] = React.useState(readLastSeen);
  const [now, setNow] = React.useState(() => Date.now());

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
            window.localStorage.setItem(STORAGE_KEY, String(at));
          } catch {
            // Storage unavailable: still show ready for this session.
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
    // Re-check freshness once a minute, so the dot turns back after 12 idle hours.
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.clearInterval(timer);
    };
  }, []);

  return { ready: lastSeenAt > 0 && now - lastSeenAt < FRESH_FOR_MS };
}
