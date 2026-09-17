/**
 * Human-readable size, for limit and breach messages.
 *
 * Presentation only - never used for arithmetic. Storage is compared in raw
 * bytes everywhere it matters.
 *
 * The client has its own copy in `client/src/lib/planCatalog.ts` because the
 * two run in different bundles; keep them in step so a quota reads the same on
 * both sides.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
