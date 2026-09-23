import type { Qz, QzHidDevice } from 'qz-tray';
import { get, post } from '@/api/client';

/**
 * The ONLY module that talks to QZ Tray.
 *
 *   Browser  --WebSocket (localhost)-->  QZ Tray  -->  Windows printer
 *
 * - The official client is loaded lazily, so tills that never print directly
 *   never download it.
 * - One connection is shared; concurrent callers wait for the same attempt.
 * - A dropped connection is detected and reported; the next print reconnects.
 * - Requests are signed by the SERVER (the private key never reaches the
 *   browser). Without a configured key QZ runs unsigned and asks the user to
 *   allow the site - fine for development, never a "trust everything" hack.
 */
export type QzStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export interface QzState {
  status: QzStatus;
  /** true = requests signed with the site certificate; false = unsigned; null = unknown yet. */
  signed: boolean | null;
  version: string | null;
}

let state: QzState = { status: 'idle', signed: null, version: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<QzState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const qzState = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let qzPromise: Promise<Qz> | null = null;
let connecting: Promise<Qz> | null = null;

async function loadQz(): Promise<Qz> {
  qzPromise ??= import('qz-tray').then(({ default: qz }) => {
    qz.security.setCertificatePromise((resolve) => {
      get<{ configured: boolean; certificate: string | null }>('/printing/qz/certificate')
        .then((result) => {
          setState({ signed: result.configured });
          // An empty certificate = unsigned (anonymous) mode.
          resolve(result.configured && result.certificate ? result.certificate : '');
        })
        .catch(() => {
          setState({ signed: false });
          resolve('');
        });
    });
    qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise((toSign) => (resolve) => {
      post<{ configured: boolean; signature: string | null }>('/printing/qz/sign', { request: toSign })
        .then((result) => resolve(result.signature ?? ''))
        .catch(() => resolve(''));
    });
    qz.websocket.setClosedCallbacks(() => setState({ status: 'disconnected' }));
    return qz;
  });
  return qzPromise;
}

/** Connects if needed. Rejects with a QzUnavailableError when QZ Tray is not installed or not running. */
export async function ensureConnected(): Promise<Qz> {
  const qz = await loadQz();
  if (qz.websocket.isActive()) return qz;
  connecting ??= (async () => {
    setState({ status: 'connecting' });
    try {
      await qz.websocket.connect({ retries: 1, delay: 1 });
    } catch (error) {
      // A connection opened by a concurrent caller is still a connection.
      if (!qz.websocket.isActive()) {
        setState({ status: 'unavailable' });
        throw new QzUnavailableError(error);
      }
    }
    let version: string | null = null;
    try {
      version = await qz.api.getVersion();
    } catch {
      version = null;
    }
    setState({ status: 'connected', version });
    return qz;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function disconnect() {
  const qz = await loadQz();
  if (qz.websocket.isActive()) await qz.websocket.disconnect();
  setState({ status: 'disconnected' });
}

export class QzUnavailableError extends Error {
  constructor(public readonly cause?: unknown) {
    super('QZ Tray is not installed or not running');
    this.name = 'QzUnavailableError';
  }
}

/** Printers installed on THIS computer, as QZ Tray reports them. */
export async function listPrinters(): Promise<string[]> {
  const qz = await ensureConnected();
  const found = await qz.printers.find();
  return (Array.isArray(found) ? found : [found]).filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** Whether a printer with exactly this name exists here. */
export async function printerExists(name: string): Promise<boolean> {
  const printers = await listPrinters();
  return printers.includes(name);
}

/** Raw bytes straight to the printer (ESC/POS), bypassing the driver's page layout. */
export async function printRawBase64(printerName: string, base64: string) {
  const qz = await ensureConnected();
  const config = qz.configs.create(printerName, { copies: 1 });
  await qz.print(config, [{ type: 'raw', format: 'command', flavor: 'base64', data: base64 }]);
}

/**
 * An image through the Windows driver with a page size set for THIS job:
 * width = printable width, height = the content's own height. No browser
 * paper sizes are involved.
 */
export async function printImageBase64(printerName: string, pngBase64: string, page: { widthMm: number; heightMm: number; dpi: number; copies: number }) {
  const qz = await ensureConnected();
  const config = qz.configs.create(printerName, {
    units: 'mm',
    size: { width: page.widthMm, height: page.heightMm },
    margins: 0,
    colorType: 'blackwhite',
    density: page.dpi,
    interpolation: 'nearest-neighbor',
    scaleContent: true,
    rasterize: true,
    copies: page.copies,
  });
  await qz.print(config, [{ type: 'pixel', format: 'image', flavor: 'base64', data: pngBase64 }]);
}

/**
 * Watches the HID devices attached to this computer, through a QZ Tray
 * connection that is ALREADY open.
 *
 * It never connects by itself: direct printing is a per-till choice, and a
 * status dot must not pop QZ's permission prompt. When QZ is connected it asks
 * for attach/detach events and re-lists on each one, with a slow poll as a
 * safety net, so a scanner being plugged in or pulled out is seen within
 * seconds without anyone clicking anything.
 */
export function watchHidDevices(onDevices: (devices: QzHidDevice[]) => void): () => void {
  let stopped = false;
  let timer = 0;
  let listening = false;
  let starting = false;
  let qzRef: Qz | null = null;

  const refresh = async () => {
    if (stopped || !qzRef) return;
    try {
      const devices = await qzRef.hid.listDevices();
      if (!stopped) onDevices(Array.isArray(devices) ? devices : []);
    } catch {
      if (!stopped) onDevices([]);
    }
  };

  const stopWatching = () => {
    window.clearInterval(timer);
    timer = 0;
    if (listening && qzRef) {
      try {
        qzRef.hid.setHidCallbacks([]);
        void qzRef.hid.stopListening().catch(() => undefined);
      } catch {
        // Nothing to undo if the connection has already gone.
      }
    }
    listening = false;
    qzRef = null;
  };

  const start = async () => {
    if (starting || qzRef || stopped || state.status !== 'connected') return;
    starting = true;
    try {
      const qz = await loadQz();
      if (stopped || !qz.websocket.isActive()) return;
      qzRef = qz;
      try {
        qz.hid.setHidCallbacks(() => void refresh());
        await qz.hid.startListening();
        listening = true;
      } catch {
        // Events unavailable (older QZ, or HID not permitted): the poll still works.
        listening = false;
      }
      await refresh();
      timer = window.setInterval(() => void refresh(), 10_000);
    } finally {
      starting = false;
    }
  };

  void start();
  const unsubscribe = qzState.subscribe(() => {
    if (state.status === 'connected') {
      void start();
    } else if (qzRef) {
      // QZ went away: stop polling a dead socket and report nothing attached,
      // so a reconnection starts the watch cleanly.
      stopWatching();
      onDevices([]);
    }
  });

  return () => {
    stopped = true;
    unsubscribe();
    stopWatching();
  };
}
