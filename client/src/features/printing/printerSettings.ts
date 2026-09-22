import * as React from 'react';

/**
 * Thermal printer settings for THIS computer.
 *
 * A SaaS account can have many tills with different printers, so the choice
 * lives in the browser (localStorage), not in the database. Nothing here is a
 * secret; a missing or corrupted entry simply falls back to the defaults.
 */
export type PrintMode = 'browser' | 'direct';
/** escpos: raw ESC/POS raster (most receipt printers). driver: image through the Windows driver. */
export type PrinterLanguage = 'escpos' | 'driver';

export interface ThermalPrinterSettings {
  mode: PrintMode;
  printerName: string | null;
  language: PrinterLanguage;
  /** Physical printable width of the head (a 58 mm roll typically prints 48 mm). */
  printableWidthMm: number;
  /** Head resolution; thermal printers are usually 203 dpi (8 dots/mm). */
  dpi: number;
  /** Blank lines fed after each print so the paper clears the tear bar. */
  feedLines: number;
  /** Send a cut command - only for printers that have a cutter. */
  autoCut: boolean;
}

export const DEFAULT_PRINTER_SETTINGS: ThermalPrinterSettings = {
  mode: 'browser',
  printerName: null,
  language: 'escpos',
  printableWidthMm: 48,
  dpi: 203,
  feedLines: 4,
  autoCut: false,
};

export const PRINTER_SETTINGS_KEY = 'pos.thermalPrinter.v1';
const CHANGE_EVENT = 'pos:thermal-printer-settings';

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Reads and validates the stored settings; anything malformed falls back to the default for that field. */
export function parsePrinterSettings(raw: unknown): ThermalPrinterSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof value.printerName === 'string' ? value.printerName.trim().slice(0, 200) : '';
  return {
    mode: value.mode === 'direct' ? 'direct' : 'browser',
    printerName: name || null,
    language: value.language === 'driver' ? 'driver' : 'escpos',
    printableWidthMm: clampInt(value.printableWidthMm, 30, 110, DEFAULT_PRINTER_SETTINGS.printableWidthMm),
    dpi: clampInt(value.dpi, 150, 600, DEFAULT_PRINTER_SETTINGS.dpi),
    feedLines: clampInt(value.feedLines, 0, 20, DEFAULT_PRINTER_SETTINGS.feedLines),
    autoCut: value.autoCut === true,
  };
}

export function loadPrinterSettings(): ThermalPrinterSettings {
  try {
    const stored = window.localStorage.getItem(PRINTER_SETTINGS_KEY);
    return parsePrinterSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

export function savePrinterSettings(patch: Partial<ThermalPrinterSettings>): ThermalPrinterSettings {
  const next = parsePrinterSettings({ ...loadPrinterSettings(), ...patch });
  try {
    window.localStorage.setItem(PRINTER_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / blocked storage: the setting lasts for this page only.
  }
  cachedSnapshot = next;
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

/**
 * Thermal heads are specified in whole dots per millimetre (203 dpi = 8 dots/mm,
 * 300 dpi = 12 dots/mm), which is how their printable widths are quoted:
 * 48 mm = 384 dots, 72 mm = 576 dots.
 */
export const dotsPerMm = (dpi: number) => Math.max(1, Math.round(dpi / 25.4));

/**
 * Dots per printed line: printable width × dots/mm, rounded DOWN to a whole
 * byte (ESC/POS rasters are sent 8 dots per byte). 48 mm at 203 dpi = 384.
 */
export const dotsPerLine = (settings: Pick<ThermalPrinterSettings, 'printableWidthMm' | 'dpi'>) =>
  Math.max(8, Math.floor((settings.printableWidthMm * dotsPerMm(settings.dpi)) / 8) * 8);

/** Millimetres → printer dots at this resolution. */
export const mmToDots = (mm: number, dpi: number) => Math.round(mm * dotsPerMm(dpi));

let cachedSnapshot: ThermalPrinterSettings | null = null;
const snapshot = () => (cachedSnapshot ??= loadPrinterSettings());
const subscribe = (onChange: () => void) => {
  const handler = (event: Event) => {
    if (event instanceof StorageEvent && event.key !== PRINTER_SETTINGS_KEY) return;
    cachedSnapshot = loadPrinterSettings();
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
};

/** Live device settings for React components. */
export function useThermalPrinterSettings() {
  return React.useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PRINTER_SETTINGS);
}
