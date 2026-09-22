import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Stethoscope } from 'lucide-react';
import { storeApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { savePrinterSettings, useThermalPrinterSettings } from './printerSettings';
import { ThermalPrintError, printDiagnostic, printDiagnostics, printTestPage, type DiagnosticKind } from './thermalPrintService';

const TESTS: { kind: DiagnosticKind | 'full'; label: string; hint: string }[] = [
  { kind: 'raw-text', label: 'A. Raw text', hint: 'Plain ESC/POS text, no image. Garbled here = driver/port problem.' },
  { kind: 'raster-text', label: 'B. Raster text', hint: 'Text sent as an image.' },
  { kind: 'barcode', label: 'C. Barcode', hint: 'EAN-13 1234567890128 - scan it.' },
  { kind: 'qr', label: 'D. QR code', hint: 'https://retailersuites.com - scan with a phone.' },
  { kind: 'logo', label: 'E. Logo', hint: 'The receipt logo between two text lines.' },
  { kind: 'full', label: 'F. Full test page', hint: 'Everything together.' },
];

/**
 * Troubleshooting for a printer that prints garbage (docs/PRINTING_BUG_ANALYSIS.md):
 * raster transfer options, isolation tests and the last job's command summary.
 * All tests are local prints only - no sale, customer or loyalty data.
 */
export function PrinterDiagnosticsCard({ connected }: { connected: boolean }) {
  const settings = useThermalPrinterSettings();
  const last = React.useSyncExternalStore(printDiagnostics.subscribe, printDiagnostics.get, printDiagnostics.get);
  const [running, setRunning] = React.useState<string | null>(null);
  const { data: config } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  const run = async (kind: DiagnosticKind | 'full') => {
    setRunning(kind);
    try {
      const result = kind === 'full' ? await printTestPage(settings) : await printDiagnostic(kind, settings, config?.receiptLogoUrl ?? config?.logoUrl);
      toast.success('Test sent', { description: `Printed on ${result.printer}` });
    } catch (error) {
      toast.error('Test failed', { description: error instanceof ThermalPrintError ? error.message : 'Printing failed.' });
    } finally {
      setRunning(null);
    }
  };

  const escpos = settings.language === 'escpos';

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Stethoscope className="h-4 w-4" />
          Diagnostics
        </CardTitle>
        <CardDescription>If receipts print random characters or black blocks, run A → F and note the first one that is not clean.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Raster block height</Label>
              <Select value={String(settings.bandHeight)} onValueChange={(v) => savePrinterSettings({ bandHeight: Number(v) as 24 | 48 | 128 })} disabled={!escpos || settings.rasterMode !== 'gsv0'}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24">24 rows (recommended)</SelectItem>
                  <SelectItem value="48">48 rows</SelectItem>
                  <SelectItem value="128">128 rows</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Raster command</Label>
              <Select value={settings.rasterMode} onValueChange={(v) => savePrinterSettings({ rasterMode: v as 'gsv0' | 'escstar' })} disabled={!escpos}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gsv0">GS v 0 (standard)</SelectItem>
                  <SelectItem value="escstar">ESC * (compatibility)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Small blocks keep any transmission error to a thin streak and fit small printer buffers. Use ESC * only if B-F are garbled while A is clean.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {TESTS.map((test) => (
              <Button
                key={test.kind}
                variant="outline"
                size="sm"
                className="h-auto flex-col items-start gap-0 py-2 text-left"
                disabled={!connected || !settings.printerName || (test.kind === 'raw-text' && !escpos) || running !== null}
                loading={running === test.kind}
                onClick={() => void run(test.kind)}
              >
                <span className="font-medium">{test.label}</span>
                <span className="whitespace-normal text-[11px] font-normal text-muted-foreground">{test.hint}</span>
              </Button>
            ))}
          </div>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Last print job sent to QZ Tray</Label>
          {last ? (
            <pre className="scrollbar-thin max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed">{JSON.stringify(last, null, 2)}</pre>
          ) : (
            <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">Nothing printed yet in this session.</p>
          )}
          <p className="text-xs text-muted-foreground">Command bytes and sizes only - no receipt content. Useful when reporting a printer problem.</p>
        </div>
      </CardContent>
    </Card>
  );
}
