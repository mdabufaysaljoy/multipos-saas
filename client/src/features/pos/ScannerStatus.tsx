import { ScanBarcode } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScannerPresence } from './useScannerPresence';

/** "just now", "2 min ago", "1 h ago" - short enough for one line on a till. */
function ago(seconds: number): string {
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/**
 * The scanner indicator: green while the scanner is connected, grey when it is
 * not. Nothing to click - it follows the hardware by itself.
 */
export function ScannerStatus({ scanner, hint, className }: { scanner: ScannerPresence; hint?: string; className?: string }) {
  const { connected, source, deviceName, secondsSinceScan } = scanner;

  const label = connected
    ? source === 'device'
      ? `Scanner connected${deviceName ? ` — ${deviceName}` : ''}`
      : `Scanner connected — last scan ${ago(secondsSinceScan ?? 0)}${hint ? `, ${hint}` : ''}`
    : 'Scanner not connected';

  return (
    <p
      className={cn('mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      title={
        source === 'device'
          ? 'The scanner is attached to this computer. The dot follows it as it is plugged in and unplugged.'
          : 'Most scanners look like a keyboard to the browser, so the dot follows recent scans and clears itself when the scanner stops being used.'
      }
    >
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full transition-colors', connected ? 'bg-success' : 'bg-muted-foreground/40')}
        role="status"
        aria-live="polite"
        aria-label={label}
      />
      <ScanBarcode className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </p>
  );
}
