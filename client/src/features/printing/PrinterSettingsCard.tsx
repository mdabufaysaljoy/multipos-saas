import * as React from 'react';
import { toast } from 'sonner';
import { Monitor, Plug, Printer, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { dotsPerLine, savePrinterSettings, useThermalPrinterSettings } from './printerSettings';
import { ensureConnected, listPrinters, qzState, type QzState } from './qzTray';
import { RECEIPT_END_GAP_LINES, ThermalPrintError, printTestPage } from './thermalPrintService';
import { PrinterDiagnosticsCard } from './PrinterDiagnosticsCard';

const STATUS_TEXT: Record<QzState['status'], string> = {
  idle: 'Not connected yet',
  connecting: 'Connecting to QZ Tray…',
  connected: 'QZ Tray connected',
  disconnected: 'QZ Tray disconnected',
  unavailable: 'QZ Tray is not installed or not running',
};

/**
 * Thermal printer setup for THIS computer (stored in this browser only - each
 * till can use a different printer). Nothing here is saved to the server.
 */
export function PrinterSettingsCard() {
  const settings = useThermalPrinterSettings();
  const qz = React.useSyncExternalStore(qzState.subscribe, qzState.get, qzState.get);
  const [printers, setPrinters] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await ensureConnected();
      setPrinters(await listPrinters());
    } catch {
      setPrinters(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Look for QZ Tray once when the tab opens; it never blocks the page.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const test = async () => {
    setTesting(true);
    try {
      const result = await printTestPage(settings);
      toast.success('Test page sent', { description: `Printed on ${result.printer}` });
    } catch (error) {
      toast.error('Test print failed', { description: error instanceof ThermalPrintError ? error.message : 'Printing failed.' });
    } finally {
      setTesting(false);
    }
  };

  const selectedMissing = Boolean(settings.printerName && printers && !printers.includes(settings.printerName));
  const connected = qz.status === 'connected';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4" />
            Thermal printer (this computer)
          </CardTitle>
          <CardDescription>
            Direct printing sends receipts and labels straight to the printer through QZ Tray - no browser print dialog. These settings
            are saved in this browser only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <span className={cn('h-2.5 w-2.5 rounded-full', connected ? 'bg-success' : qz.status === 'connecting' ? 'bg-warning' : 'bg-destructive')} />
              {STATUS_TEXT[qz.status]}
              {qz.version && <span className="text-xs text-muted-foreground">v{qz.version}</span>}
            </span>
            <Button size="sm" variant="outline" onClick={() => void refresh()} loading={loading}>
              {connected ? <RefreshCw /> : <Plug />}
              {connected ? 'Refresh' : 'Connect'}
            </Button>
          </div>
          {qz.status === 'unavailable' && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">
              Direct printing is unavailable. Install QZ Tray from <span className="font-medium">qz.io/download</span> on this computer, start it,
              then press Connect.
            </p>
          )}
          {connected && qz.signed !== null && (
            <p className={cn('flex items-center gap-1.5 text-xs', qz.signed ? 'text-success' : 'text-warning')}>
              {qz.signed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {qz.signed ? 'Signed requests - QZ Tray can remember "Allow" for this site.' : 'Unsigned (development) - QZ Tray asks to allow this site each session.'}
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Printer</Label>
            <Select
              value={settings.printerName ?? ''}
              onValueChange={(printerName) => savePrinterSettings({ printerName })}
              disabled={!printers || printers.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={printers ? 'Choose the thermal printer' : 'Connect to QZ Tray to list printers'} />
              </SelectTrigger>
              <SelectContent>
                {settings.printerName && selectedMissing && (
                  <SelectItem value={settings.printerName}>{settings.printerName} (not found)</SelectItem>
                )}
                {(printers ?? []).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedMissing && <p className="text-xs text-destructive">The selected printer is not installed on this computer.</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Printer language</Label>
              <Select value={settings.language} onValueChange={(language) => savePrinterSettings({ language: language as 'escpos' | 'driver' })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="escpos">ESC/POS (receipt printers)</SelectItem>
                  <SelectItem value="driver">Windows driver (image)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Printable width (mm)</Label>
              <Input
                inputMode="numeric"
                value={settings.printableWidthMm}
                onChange={(event) => /^\d{0,3}$/.test(event.target.value) && event.target.value && savePrinterSettings({ printableWidthMm: Number(event.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Resolution</Label>
              <Select value={String(settings.dpi)} onValueChange={(dpi) => savePrinterSettings({ dpi: Number(dpi) })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="203">203 dpi (8 dots/mm)</SelectItem>
                  <SelectItem value="300">300 dpi (12 dots/mm)</SelectItem>
                  <SelectItem value="180">180 dpi</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Feed after printing (lines)</Label>
              <Input
                inputMode="numeric"
                value={settings.feedLines}
                onChange={(event) => /^\d{0,2}$/.test(event.target.value) && savePrinterSettings({ feedLines: Number(event.target.value || 0) })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {settings.printableWidthMm}mm at {settings.dpi} dpi = {dotsPerLine(settings)} dots per line. Receipt height always follows its content. Receipts
            also get {RECEIPT_END_GAP_LINES} extra blank lines at the end ({settings.feedLines + RECEIPT_END_GAP_LINES} in total), so the last line clears the
            tear bar and back-to-back receipts stay apart. Raise "Feed after printing" if your printer needs more.
          </p>

          <label className="flex items-center justify-between rounded-md border p-3 text-sm">
            <span>
              <span className="font-medium">Auto cutter</span>
              <span className="block text-xs text-muted-foreground">Only if this printer has a cutter; otherwise no cut command is sent.</span>
            </span>
            <Switch checked={settings.autoCut} onCheckedChange={(autoCut) => savePrinterSettings({ autoCut })} disabled={settings.language !== 'escpos'} />
          </label>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Monitor className="h-4 w-4" />
            Print mode on this computer
          </CardTitle>
          <CardDescription>Choose how receipts, labels and loyalty cards print here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ['direct', 'Direct (QZ Tray)', 'Prints immediately on the thermal printer. No browser dialog. If printing fails you get Retry and an explicit "Print using browser".'],
              ['browser', 'Browser', 'Uses the browser print dialog (the previous behaviour).'],
            ] as const
          ).map(([mode, title, description]) => (
            <button
              key={mode}
              type="button"
              onClick={() => savePrinterSettings({ mode })}
              className={cn(
                'w-full rounded-md border p-3 text-left text-sm transition-colors',
                settings.mode === mode ? 'border-primary bg-primary/5' : 'hover:bg-accent',
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                {title}
                {settings.mode === mode && <Badge>Active</Badge>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
            </button>
          ))}
          {settings.mode === 'direct' && !settings.printerName && (
            <p className="text-xs font-medium text-destructive">Choose a printer - direct printing needs one.</p>
          )}

          <Button className="w-full" variant="outline" onClick={() => void test()} disabled={!settings.printerName || !connected} loading={testing}>
            <Printer />
            Test print
          </Button>
          <p className="text-xs text-muted-foreground">The test page prints the width, a barcode and a QR code. It creates no sale.</p>
        </CardContent>
      </Card>

      <PrinterDiagnosticsCard connected={connected} />
    </div>
  );
}
