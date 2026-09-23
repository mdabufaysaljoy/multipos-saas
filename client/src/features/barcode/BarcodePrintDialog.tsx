import * as React from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { QuantityInput } from '@/components/QuantityInput';
import { useQuery } from '@tanstack/react-query';
import { storeApi } from '@/api/endpoints';
import { DEFAULT_LABEL_SETTINGS } from '@/types/domain';
import { DirectPrintStatus } from '@/features/printing/DirectPrintStatus';
import { useThermalPrint } from '@/features/printing/useThermalPrint';
import { BarcodeLabel, type BarcodeLabelData } from './BarcodeLabel';

interface BarcodePrintDialogProps {
  label: BarcodeLabelData | null;
  currency: string;
  storeName?: string;
  onClose: () => void;
}

/**
 * Prints barcode labels through the SAME browser-print path the receipt uses:
 * a dedicated print area, isolated by CSS. That keeps one printing mechanism in
 * the app rather than a second, parallel one.
 */
export function BarcodePrintDialog({ label, currency, storeName, onClose }: BarcodePrintDialogProps) {
  const [copies, setCopies] = React.useState<number | null>(1);
  const [showPrice, setShowPrice] = React.useState(true);
  const [showStore, setShowStore] = React.useState(true);
  const [showQr, setShowQr] = React.useState(false);
  const thermal = useThermalPrint();
  const sheetRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (label) {
      setCopies(1);
      setShowPrice(true);
    }
    thermal.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  const count = copies && copies > 0 ? Math.min(copies, 100) : 1;
  // Label size and paper come from Settings → Labels.
  const { data: config } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig, enabled: Boolean(label) });
  const labels = { ...DEFAULT_LABEL_SETTINGS, ...(config?.labels ?? {}) };

  // Direct (QZ Tray) printing sends ONE rendered label as `count` copies; the
  // label's own height decides the paper used - no browser paper sizes.
  const printDirect = () => {
    const element = sheetRef.current?.querySelector<HTMLElement>('.barcode-label');
    if (element) void thermal.print({ type: 'label', element, copies: count, contentWidthMm: labels.productWidthMm });
  };

  return (
    <Dialog open={Boolean(label)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="no-print">
          <DialogTitle>Print barcode labels</DialogTitle>
          <DialogDescription>
            {label?.productName} — {label?.barcode} · {labels.productWidthMm}mm {labels.paper === 'roll' ? 'label roll' : 'sheet'}
          </DialogDescription>
        </DialogHeader>

        <div className="no-print space-y-3">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Copies</Label>
              <QuantityInput value={copies} onChange={setCopies} min={1} max={100} ariaLabel="Number of labels" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <label className="flex items-center justify-between gap-2 text-sm">
                Show price
                <Switch checked={showPrice} onCheckedChange={setShowPrice} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                Show store name
                <Switch checked={showStore} onCheckedChange={setShowStore} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                Add QR code
                <Switch checked={showQr} onCheckedChange={setShowQr} />
              </label>
            </div>
          </div>
        </div>

        {/* A label printer's page is one label wide; a sheet keeps the normal page. */}
        {labels.paper === 'roll' && label && (
          <style>{`@media print { @page { size: ${labels.productWidthMm}mm auto; margin: 0; } #barcode-print-area { width: ${labels.productWidthMm}mm; } }`}</style>
        )}

        {/* The print area: repeated once per copy. */}
        <div ref={sheetRef} id="barcode-print-area" className="barcode-sheet rounded-md bg-white p-2" data-paper={labels.paper}>
          {label &&
            Array.from({ length: count }).map((_, index) => (
              <BarcodeLabel
                key={index}
                data={label}
                currency={currency}
                storeName={showStore ? storeName : undefined}
                showPrice={showPrice}
                widthMm={labels.productWidthMm}
                showQr={showQr}
                vatEnabled={config?.tax?.enabled === true}
              />
            ))}
        </div>

        {thermal.direct && (
          <DirectPrintStatus status={thermal.status} message={thermal.message} noun="labels" onRetry={printDirect} onBrowserPrint={() => window.print()} />
        )}

        <DialogFooter className="no-print">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={thermal.direct ? printDirect : () => window.print()} disabled={!label} loading={thermal.direct && thermal.status === 'printing'}>
            <Printer />
            Print {count} label{count === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
