import type { Qz } from 'qz-tray';
import { loadPrinterSettings, type PrintAgentId, type ThermalPrinterSettings } from './printerSettings';
import { qzAgent } from './qzTray';
import { nanoPrintAgent } from './nanoPrint';

/**
 * The ONLY module that talks to a local print agent.
 *
 *   Browser  --WebSocket (localhost)-->  QZ Tray | NanoPrint  -->  printer
 *
 * Two agents, one protocol: NanoPrint is API-compatible with the QZ Tray
 * client, so the same official `qz-tray` client drives either one and the
 * rasterised receipt or label bytes are identical. Only the connection and the
 * permission model differ, and those live in the agent profiles
 * (`qzTray.ts`, `nanoPrint.ts`).
 *
 * - The client is loaded lazily, so tills that never print directly never
 *   download it.
 * - One connection is shared; concurrent callers wait for the same attempt.
 * - Switching agent disconnects first: the client is a singleton whose security
 *   callbacks are global, so they are re-applied for the agent being used.
 * - A dropped connection is detected and reported; the next print reconnects.
 */

/** How one agent is reached and what it will accept. */
export interface PrintAgentProfile {
  id: PrintAgentId;
  /** Shown in the UI and in error messages. */
  label: string;
  /** Where to get it, for the "not installed" hint. */
  download: string;
  /**
   * Whether the agent accepts `type: 'pixel'` jobs (an image through the OS
   * printer driver). NanoPrint refuses them: raw ESC/POS only.
   */
  supportsPixel: boolean;
  /**
   * Applied to the client before connecting. `onSigned` reports whether
   * requests carry a trusted signature (`null` when the idea does not apply).
   */
  configure(qz: Qz, onSigned: (signed: boolean | null) => void): void;
  /** Connection options for this agent, e.g. non-default ports. */
  connectOptions(settings: ThermalPrinterSettings): Parameters<Qz['websocket']['connect']>[0];
}

const AGENTS: Record<PrintAgentId, PrintAgentProfile> = {
  qz: qzAgent,
  nanoprint: nanoPrintAgent,
};

export const printAgent = (id: PrintAgentId): PrintAgentProfile => AGENTS[id] ?? AGENTS.qz;

export type AgentStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export interface AgentState {
  /** The agent this state describes. */
  agent: PrintAgentId;
  status: AgentStatus;
  /** true = requests signed with the site certificate; false = unsigned; null = not applicable. */
  signed: boolean | null;
  version: string | null;
}

/** Kept for the QZ-only callers that predate the second agent. */
export type QzStatus = AgentStatus;
export type QzState = AgentState;

let state: AgentState = { agent: loadPrinterSettings().service, status: 'idle', signed: null, version: null };
const listeners = new Set<() => void>();
const setState = (patch: Partial<AgentState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const agentState = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Legacy alias: the settings card and diagnostics read the same store. */
export const qzState = agentState;

let qzPromise: Promise<Qz> | null = null;
let connecting: Promise<Qz> | null = null;
/** The agent whose security callbacks are currently installed on the client. */
let configuredFor: PrintAgentId | null = null;

async function loadClient(): Promise<Qz> {
  qzPromise ??= import('qz-tray').then(({ default: qz }) => {
    qz.websocket.setClosedCallbacks(() => setState({ status: 'disconnected' }));
    return qz;
  });
  return qzPromise;
}

/** The client is a singleton, so its security callbacks are rewritten per agent. */
function configure(qz: Qz, profile: PrintAgentProfile) {
  if (configuredFor === profile.id) return;
  profile.configure(qz, (signed) => setState({ signed }));
  configuredFor = profile.id;
}

export class AgentUnavailableError extends Error {
  constructor(
    public readonly agent: PrintAgentId,
    public readonly cause?: unknown,
  ) {
    super(`${printAgent(agent).label} is not installed or not running`);
    this.name = 'AgentUnavailableError';
  }
}

/** Kept so existing `catch` sites and tests keep working. */
export const QzUnavailableError = AgentUnavailableError;

/**
 * Connects if needed, to the agent this computer is set to use.
 * Rejects with an AgentUnavailableError when that agent is not running.
 */
export async function ensureConnected(settings: ThermalPrinterSettings = loadPrinterSettings()): Promise<Qz> {
  const profile = printAgent(settings.service);
  const qz = await loadClient();

  // Changing agent in Settings means a different program on a different port.
  if (configuredFor && configuredFor !== profile.id) {
    if (qz.websocket.isActive()) {
      try {
        await qz.websocket.disconnect();
      } catch {
        // Already gone; connecting below is what matters.
      }
    }
    configuredFor = null;
    setState({ status: 'idle', signed: null, version: null });
  }
  setState({ agent: profile.id });
  configure(qz, profile);

  if (qz.websocket.isActive()) return qz;
  connecting ??= (async () => {
    setState({ status: 'connecting' });
    try {
      await qz.websocket.connect(profile.connectOptions(settings));
    } catch (error) {
      // A connection opened by a concurrent caller is still a connection.
      if (!qz.websocket.isActive()) {
        setState({ status: 'unavailable' });
        throw new AgentUnavailableError(profile.id, error);
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
  const qz = await loadClient();
  if (qz.websocket.isActive()) await qz.websocket.disconnect();
  setState({ status: 'disconnected' });
}

/** Printers installed on THIS computer, as the agent reports them. */
export async function listPrinters(settings?: ThermalPrinterSettings): Promise<string[]> {
  const qz = await ensureConnected(settings);
  const found = await qz.printers.find();
  return (Array.isArray(found) ? found : [found]).filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** Whether a printer with exactly this name exists here. */
export async function printerExists(name: string, settings?: ThermalPrinterSettings): Promise<boolean> {
  const printers = await listPrinters(settings);
  return printers.includes(name);
}

/** Raw bytes straight to the printer (ESC/POS), bypassing the driver's page layout. */
export async function printRawBase64(printerName: string, base64: string, settings?: ThermalPrinterSettings) {
  const qz = await ensureConnected(settings);
  const config = qz.configs.create(printerName, { copies: 1 });
  await qz.print(config, [{ type: 'raw', format: 'command', flavor: 'base64', data: base64 }]);
}

/**
 * An image through the OS printer driver with a page size set for THIS job:
 * width = printable width, height = the content's own height. No browser paper
 * sizes are involved. QZ Tray only - NanoPrint refuses pixel jobs, which the
 * print service checks before it gets here.
 */
export async function printImageBase64(
  printerName: string,
  pngBase64: string,
  page: { widthMm: number; heightMm: number; dpi: number; copies: number },
  settings?: ThermalPrinterSettings,
) {
  const qz = await ensureConnected(settings);
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
