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
 * The scanner indicator.
 *
 * Green means the scanner is attached right now, which only a paired device can
 * prove. Amber means a scan was seen a moment ago - it says exactly that, and
 * fades by itself, so it can never claim a scanner that has been unplugged.
 * Grey means nothing is known yet.
 */
export function ScannerStatus({ scanner, hint, className }: { scanner: ScannerPresence; hint?: string; className?: string }) {
  const { status, canPair, paired, deviceName, secondsSinceScan } = scanner;

  const dot = status === 'connected' ? 'bg-success' : status === 'recent' ? 'bg-warning' : 'bg-muted-foreground/40';
  const label =
    status === 'connected'
      ? `Scanner connected${deviceName ? ` — ${deviceName}` : ''}`
      : status === 'recent'
        ? `Scanner used ${ago(secondsSinceScan ?? 0)}${hint ? ` — ${hint}` : ''}`
        : paired
          ? 'Scanner not connected — plug it in'
          : 'No scan yet — scan a barcode, or connect the scanner to track it live';

  return (
    <p
      className={cn('mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground', className)}
      title={
        paired
          ? 'This scanner is tracked live: the dot follows it as it is plugged in and unplugged.'
          : 'Most scanners look like a keyboard to the browser, so the dot follows recent scans. Connect the scanner to track it live instead.'
      }
    >
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} role="status" aria-live="polite" aria-label={label} />
      <ScanBarcode className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {canPair && status !== 'connected' && (
        <button type="button" className="shrink-0 font-medium text-primary underline-offset-2 hover:underline" onClick={() => void scanner.pair()}>
          {paired ? 'Reconnect' : 'Connect scanner'}
        </button>
      )}
      {canPair && status === 'connected' && paired && (
        <button type="button" className="shrink-0 text-muted-foreground underline-offset-2 hover:underline" onClick={scanner.unpair}>
          Stop tracking
        </button>
      )}
    </p>
  );
}
