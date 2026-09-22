import * as React from 'react';
import { CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface LoyaltyCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (code: string) => void;
  loading?: boolean;
}

/**
 * Fallback for a card the scanner cannot read: type the barcode digits or the
 * printed card number. A scanner needs none of this - scanning a card anywhere
 * on the POS attaches it. A phone number is not accepted as a card.
 */
export function LoyaltyCardDialog({ open, onOpenChange, onSubmit, loading }: LoyaltyCardDialogProps) {
  const [code, setCode] = React.useState('');
  React.useEffect(() => {
    if (open) setCode('');
  }, [open]);

  const submit = () => {
    const trimmed = code.trim();
    if (trimmed.length >= 4) onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Loyalty card</DialogTitle>
          <DialogDescription>Scan the member's card, or type its barcode or card number (e.g. LM-000012).</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              submit();
            }
          }}
          placeholder="Card barcode or number"
          aria-label="Loyalty card barcode or number"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={code.trim().length < 4} loading={loading}>
            <CreditCard />
            Find member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
