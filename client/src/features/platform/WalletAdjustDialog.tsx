import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownLeft, ArrowUpRight, Info } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { MoneyInput } from '@/components/MoneyInput';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

interface WalletAdjustDialogProps {
  tenantId: string | null;
  tenantName?: string;
  currentBalanceMinor?: number;
  currency?: string;
  onClose: () => void;
}

/** Preset top-up amounts, in minor units, for the common cases. */
const QUICK_AMOUNTS = [50_000, 100_000, 500_000, 1_000_000];

/**
 * Adds money to (or removes it from) a workspace wallet.
 *
 * A reason is mandatory: every adjustment writes an immutable ledger entry and
 * an audit-log record, so "why was this credited?" always has an answer.
 */
export function WalletAdjustDialog({
  tenantId,
  tenantName,
  currentBalanceMinor = 0,
  currency = 'BDT',
  onClose,
}: WalletAdjustDialogProps) {
  const queryClient = useQueryClient();
  const [direction, setDirection] = React.useState<'credit' | 'debit'>('credit');
  const [amountMinor, setAmountMinor] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (tenantId) {
      setDirection('credit');
      setAmountMinor(null);
      setReason('');
    }
  }, [tenantId]);

  const adjust = useMutation({
    mutationFn: () =>
      platformApi.adjustWallet(tenantId!, { direction, amountMinor: amountMinor!, reason: reason.trim() }),
    onSuccess: (result) => {
      toast.success(direction === 'credit' ? 'Wallet credited' : 'Wallet debited', {
        description: `New balance ${formatMoney(result.balanceMinor, currency)}`,
      });
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      void queryClient.invalidateQueries({ queryKey: ['ws'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not adjust the wallet'),
  });

  const overdraw = direction === 'debit' && amountMinor !== null && amountMinor > currentBalanceMinor;
  const valid = amountMinor !== null && amountMinor > 0 && reason.trim().length >= 3 && !overdraw;

  const projected =
    amountMinor === null
      ? currentBalanceMinor
      : direction === 'credit'
        ? currentBalanceMinor + amountMinor
        : currentBalanceMinor - amountMinor;

  return (
    <Dialog open={Boolean(tenantId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust wallet balance</DialogTitle>
          <DialogDescription>
            {tenantName ? `${tenantName} — ` : ''}currently holding {formatMoney(currentBalanceMinor, currency)}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={direction === 'credit' ? 'default' : 'outline'}
              className="flex-1"
              onClick={() => setDirection('credit')}
            >
              <ArrowDownLeft />
              Add money
            </Button>
            <Button
              type="button"
              variant={direction === 'debit' ? 'destructive' : 'outline'}
              className="flex-1"
              onClick={() => setDirection('debit')}
            >
              <ArrowUpRight />
              Deduct
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>Amount</Label>
            <MoneyInput value={amountMinor} onChange={setAmountMinor} ariaLabel="Adjustment amount" />
            {direction === 'credit' && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {QUICK_AMOUNTS.map((amount) => (
                  <Button
                    key={amount}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setAmountMinor(amount)}
                  >
                    +{formatMoney(amount, currency)}
                  </Button>
                ))}
              </div>
            )}
            {overdraw && (
              <p className="text-xs text-destructive">
                Cannot deduct more than the balance ({formatMoney(currentBalanceMinor, currency)}).
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. bKash payment received offline, ref 8F2K1L"
            />
            <p className="text-xs text-muted-foreground">
              Required. Recorded on the wallet ledger and in the audit log.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 p-3 text-sm">
            <span className="text-muted-foreground">Balance after</span>
            <span className={cn('tabular font-semibold', direction === 'credit' ? 'text-success' : 'text-destructive')}>
              {formatMoney(projected, currency)}
            </span>
          </div>

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This is a manual adjustment. For a customer-submitted payment, approve it under Financial requests instead so
            the transaction ID is recorded.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={direction === 'credit' ? 'default' : 'destructive'}
            disabled={!valid}
            loading={adjust.isPending}
            onClick={() => adjust.mutate()}
          >
            {direction === 'credit' ? 'Add to wallet' : 'Deduct from wallet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
