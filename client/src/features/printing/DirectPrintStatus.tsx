import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ThermalPrintStatus } from './useThermalPrint';

interface DirectPrintStatusProps {
  status: ThermalPrintStatus;
  message: string | null;
  /** What is being printed, e.g. "labels". */
  noun: string;
  onRetry: () => void;
  /** Explicit, user-chosen fallback - never opened automatically. */
  onBrowserPrint: () => void;
}

/** Status line for direct (QZ Tray) printing, with Retry and an explicit browser fallback on failure. */
export function DirectPrintStatus({ status, message, noun, onRetry, onBrowserPrint }: DirectPrintStatusProps) {
  if (status === 'idle') return null;
  if (status === 'printing') return <p role="status" className="no-print rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Printing {noun}…</p>;
  if (status === 'printed') return <p role="status" className="no-print rounded-md bg-success/10 px-3 py-2 text-xs text-success">{message}</p>;
  return (
    <div role="status" className="no-print space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <p>{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw />
          Retry print
        </Button>
        <Button size="sm" variant="ghost" onClick={onBrowserPrint}>
          Print using browser
        </Button>
      </div>
    </div>
  );
}
