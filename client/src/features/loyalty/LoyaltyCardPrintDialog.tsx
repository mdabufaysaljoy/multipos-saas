import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { storeApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_LABEL_SETTINGS } from '@/types/domain';
import { LoyaltyCardSticker, type LoyaltyCardData } from './LoyaltyCardSticker';

interface LoyaltyCardPrintDialogProps {
  card: LoyaltyCardData | null;
  onClose: () => void;
}

/** Prints (or reprints) a card through the app's single isolated print-area mechanism. Same card, same barcode, every time. */
export function LoyaltyCardPrintDialog({ card, onClose }: LoyaltyCardPrintDialogProps) {
  const [showEmail, setShowEmail] = React.useState(true);
  const { data: store } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig, enabled: Boolean(card) });
  const labels = { ...DEFAULT_LABEL_SETTINGS, ...(store?.labels ?? {}) };

  return (
    <Dialog open={Boolean(card)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="no-print">
          <DialogTitle>Print membership card</DialogTitle>
          <DialogDescription>
            {card?.cardNumber} · {card?.customerName} · {labels.loyaltyCardWidthMm}mm
          </DialogDescription>
        </DialogHeader>

        {card?.email ? (
          <label className="no-print flex items-center justify-between gap-2 text-sm">
            Show email on the card
            <Switch checked={showEmail} onCheckedChange={setShowEmail} />
          </label>
        ) : null}

        {labels.paper === 'roll' && card && (
          <style>{`@media print { @page { size: ${labels.loyaltyCardWidthMm}mm auto; margin: 0; } #loyalty-card-print-area { width: ${labels.loyaltyCardWidthMm}mm; } }`}</style>
        )}

        <div id="loyalty-card-print-area" className="flex justify-center overflow-x-auto rounded-md bg-muted/40 p-3">
          {card && <LoyaltyCardSticker card={card} storeName={store?.name ?? ''} logoUrl={store?.receiptLogoUrl ?? store?.logoUrl} showEmail={showEmail} widthMm={labels.loyaltyCardWidthMm} />}
        </div>

        <DialogFooter className="no-print">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => window.print()} disabled={!card}>
            <Printer />
            Print card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
