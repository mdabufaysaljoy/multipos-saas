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

  React.useEffect(() => {
    if (label) {
      setCopies(1);
      setShowPrice(true);
    }
  }, [label]);

  const count = copies && copies > 0 ? Math.min(copies, 100) : 1;

  return (
    <Dialog open={Boolean(label)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="no-print">
          <DialogTitle>Print barcode labels</DialogTitle>
          <DialogDescription>
            {label?.productName} — {label?.barcode}
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
            </div>
          </div>
        </div>

        {/* The print area: repeated once per copy. */}
        <div id="barcode-print-area" className="barcode-sheet rounded-md bg-white p-2">
          {label &&
            Array.from({ length: count }).map((_, index) => (
              <BarcodeLabel
                key={index}
                data={label}
                currency={currency}
                storeName={showStore ? storeName : undefined}
                showPrice={showPrice}
              />
            ))}
        </div>

        <DialogFooter className="no-print">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => window.print()} disabled={!label}>
            <Printer />
            Print {count} label{count === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
