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
import { dotsPerLine, savePrinterSettings, useThermalPrinterSettings, type PrintAgentId } from './printerSettings';
import { agentState, ensureConnected, listPrinters, printAgent, type AgentState } from './printAgent';
import { RECEIPT_END_GAP_LINES, RECEIPT_TAIL_MM, ThermalPrintError, printTestPage } from './thermalPrintService';
import { PrinterDiagnosticsCard } from './PrinterDiagnosticsCard';

const statusText = (status: AgentState['status'], agent: string): string =>
  ({
    idle: 'Not connected yet',
    connecting: `Connecting to ${agent}…`,
    connected: `${agent} connected`,
    disconnected: `${agent} disconnected`,
    unavailable: `${agent} is not installed or not running`,
  })[status];

/**
 * The two local print agents. Both print the same bytes; they differ in how a
 * till is allowed to print at all, which is the reason to switch.
 */
const SERVICES: { id: PrintAgentId; title: string; description: string }[] = [
  {
    id: 'nanoprint',
    title: 'NanoPrint',
    description:
      'No certificate to buy or install. Asks once per computer and "Remember this decision" works, so printing is silent afterwards. Prints raw ESC/POS only.',
  },
  {
    id: 'qz',
    title: 'QZ Tray',
    description:
      'Needs a signing certificate trusted on this computer; without one it asks on every print and greys out "Remember". Supports the Windows driver (image) language.',
  },
];

/**
 * Thermal printer setup for THIS computer (stored in this browser only - each
 * till can use a different printer). Nothing here is saved to the server.
 */
export function PrinterSettingsCard() {
  const settings = useThermalPrinterSettings();
  const qz = React.useSyncExternalStore(agentState.subscribe, agentState.get, agentState.get);
  const agent = printAgent(settings.service);
  const [printers, setPrinters] = React.useState<string[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      await ensureConnected(settings);
      setPrinters(await listPrinters(settings));
    } catch {
      setPrinters(null);
    } finally {
      setLoading(false);
    }
  }, [settings]);

  // Look for the agent when the tab opens, and again after the service or its
  // ports change - a different service means a different program and port.
  React.useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.service, settings.nanoSecurePort, settings.nanoInsecurePort]);

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
  const connected = qz.status === 'connected' && qz.agent === settings.service;
  // NanoPrint refuses pixel jobs, so this combination can never print.
  const driverUnsupported = settings.language === 'driver' && !agent.supportsPixel;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4" />
            Thermal printer (this computer)
          </CardTitle>
          <CardDescription>
            Direct printing sends receipts, labels and shift reports straight to the printer through {agent.label} - no browser print
            dialog. These settings are saved in this browser only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <span className={cn('h-2.5 w-2.5 rounded-full', connected ? 'bg-success' : qz.status === 'connecting' ? 'bg-warning' : 'bg-destructive')} />
              {statusText(connected ? 'connected' : qz.agent === settings.service ? qz.status : 'idle', agent.label)}
              {qz.version && <span className="text-xs text-muted-foreground">v{qz.version}</span>}
            </span>
            <Button size="sm" variant="outline" onClick={() => void refresh()} loading={loading}>
              {connected ? <RefreshCw /> : <Plug />}
              {connected ? 'Refresh' : 'Connect'}
            </Button>
          </div>
          {qz.status === 'unavailable' && qz.agent === settings.service && (
            <p className="rounded-md bg-muted px-3 py-2 text-xs">
              Direct printing is unavailable. Install {agent.label} from <span className="font-medium">{agent.download}</span> on this computer,
              start it, then press Connect.
            </p>
          )}
          {connected && settings.service === 'qz' && qz.signed !== null && (
            <p className={cn('flex items-center gap-1.5 text-xs', qz.signed ? 'text-success' : 'text-warning')}>
              {qz.signed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              {qz.signed
                ? 'Signed requests - QZ Tray can remember "Allow" for this site.'
                : 'Unsigned - QZ Tray asks to allow this site on every print and "Remember" stays greyed out. Configure signing, or switch the print service to NanoPrint.'}
            </p>
          )}
          {connected && settings.service === 'nanoprint' && (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <ShieldCheck className="h-3.5 w-3.5" />
              Allowed by origin - no certificate needed. NanoPrint asks once, and remembers it when this site is served over https.
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
                <SelectValue placeholder={printers ? 'Choose the thermal printer' : `Connect to ${agent.label} to list printers`} />
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
                  <SelectItem value="driver" disabled={!agent.supportsPixel}>
                    Windows driver (image){agent.supportsPixel ? '' : ' - not supported by NanoPrint'}
                  </SelectItem>
                </SelectContent>
              </Select>
              {driverUnsupported && (
                <p className="text-xs text-destructive">
                  NanoPrint prints raw ESC/POS only. Choose ESC/POS, or switch the print service to QZ Tray.
                </p>
              )}
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
            {settings.printableWidthMm}mm at {settings.dpi} dpi = {dotsPerLine(settings)} dots per line. Receipt height always follows its content. Every print -
            receipts, barcode labels (each copy), loyalty cards and test pages - ends with a dashed tear line and about {RECEIPT_TAIL_MM}mm of blank paper
            printed as part of the image, so the last line clears the tear bar and back-to-back prints stay apart - even on printers that ignore the feed command. Then {settings.feedLines + RECEIPT_END_GAP_LINES} feed lines are
            sent as extra.
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
            <Plug className="h-4 w-4" />
            Print service (this computer)
          </CardTitle>
          <CardDescription>
            The small program that passes print jobs to the printer. Both print exactly the same receipt and label - they differ only in
            how this computer grants permission to print.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {SERVICES.map((service) => (
            <button
              key={service.id}
              type="button"
              onClick={() => savePrinterSettings({ service: service.id })}
              className={cn(
                'w-full rounded-md border p-3 text-left text-sm transition-colors',
                settings.service === service.id ? 'border-primary bg-primary/5' : 'hover:bg-accent',
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                {service.title}
                {settings.service === service.id && <Badge>Active</Badge>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{service.description}</span>
            </button>
          ))}

          {settings.service === 'nanoprint' && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label>Name shown in the NanoPrint prompt</Label>
                <Input
                  value={settings.nanoSiteName}
                  maxLength={40}
                  onChange={(event) => savePrinterSettings({ nanoSiteName: event.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Secure port (wss)</Label>
                  <Input
                    inputMode="numeric"
                    placeholder="8181 (default)"
                    value={settings.nanoSecurePort ?? ''}
                    onChange={(event) =>
                      /^\d{0,5}$/.test(event.target.value) &&
                      savePrinterSettings({ nanoSecurePort: event.target.value ? Number(event.target.value) : null })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Insecure port (ws)</Label>
                  <Input
                    inputMode="numeric"
                    placeholder="8182 (default)"
                    value={settings.nanoInsecurePort ?? ''}
                    onChange={(event) =>
                      /^\d{0,5}$/.test(event.target.value) &&
                      savePrinterSettings({ nanoInsecurePort: event.target.value ? Number(event.target.value) : null })
                    }
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave the ports empty unless QZ Tray is also installed here. Both programs listen on the same default ports and whichever
                starts first takes them, so move NanoPrint in its Preferences → Connection ports and enter the same numbers here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Monitor className="h-4 w-4" />
            Print mode on this computer
          </CardTitle>
          <CardDescription>Choose how receipts, labels, loyalty cards and shift reports print here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ['direct', `Direct (${agent.label})`, 'Prints immediately on the thermal printer. No browser dialog. If printing fails you get Retry and an explicit "Print using browser".'],
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

          <Button
            className="w-full"
            variant="outline"
            onClick={() => void test()}
            disabled={!settings.printerName || !connected || driverUnsupported}
            loading={testing}
          >
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
