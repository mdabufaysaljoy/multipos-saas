import * as React from 'react';
import { ScanBarcode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (code: string) => void;
}

/**
 * Manual fallback for the Scan button.
 *
 * A hardware scanner needs none of this - it types straight into the page and
 * `useBarcodeScanner` picks it up. This dialog covers a damaged label the
 * cashier has to key in, and gives the Scan button somewhere sensible to lead.
 */
export function ScanDialog({ open, onOpenChange, onSubmit }: ScanDialogProps) {
  const [code, setCode] = React.useState('');

  React.useEffect(() => {
    if (open) setCode('');
  }, [open]);

  const submit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanBarcode className="h-5 w-5" />
            Scan or enter a barcode
          </DialogTitle>
          <DialogDescription>
            Point the scanner at the label, or type the code and press Enter.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="scan-code">Barcode</Label>
          <Input
            id="scan-code"
            autoFocus
            // Marked so the global scanner listener still reads this field.
            data-barcode-target="true"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. 8901234567890"
            className="font-mono"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!code.trim()}>
            Add to cart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
