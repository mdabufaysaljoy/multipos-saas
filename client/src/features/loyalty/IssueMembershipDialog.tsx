import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, UserRound } from 'lucide-react';
import { customerApi, loyaltyApi, storeApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { usePayments } from '@/features/payments/usePayments';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Customer, LoyaltyMember, PaymentMethod } from '@/types/domain';
import { newRequestKey } from './useLoyaltyAccess';

interface IssueMembershipDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selects a customer (e.g. from the customer screen). */
  customer?: Pick<Customer, '_id' | 'name' | 'phone'> | null;
  onIssued: (member: LoyaltyMember) => void;
}

/**
 * Issue a membership card: pick an existing customer, take the store's fee
 * with the POS payment panel, then the server creates the ACTIVE card and its
 * barcode. The fee shown comes from the store settings; the server charges its
 * own copy of it and refuses a payment that does not add up.
 */
export function IssueMembershipDialog({ open, onOpenChange, customer: preset, onIssued }: IssueMembershipDialogProps) {
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState('');
  const debounced = useDebounced(term, 250);
  const [selected, setSelected] = React.useState<Pick<Customer, '_id' | 'name' | 'phone'> | null>(preset ?? null);
  const requestKey = React.useRef(newRequestKey('card'));

  const { data: config } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig, enabled: open });
  const feeMinor = config?.loyalty?.membershipFeeMinor ?? 0;
  const currency = config?.currency ?? 'BDT';
  const payments = usePayments(open && feeMinor > 0 ? feeMinor : 0);

  const { data: results } = useQuery({
    queryKey: ['customers', 'loyalty-issue', debounced],
    queryFn: () => customerApi.list({ search: debounced, limit: 6 }),
    enabled: open && !selected,
  });

  React.useEffect(() => {
    if (!open) return;
    setSelected(preset ?? null);
    setTerm('');
    requestKey.current = newRequestKey('card');
    payments.reset();
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const issue = useMutation({
    mutationFn: () =>
      loyaltyApi.issue({
        customerId: selected!._id,
        ...(feeMinor > 0
          ? {
              payments: payments.applied.map((row) => ({ method: row.method, amountMinor: row.amountMinor, reference: '' })),
              ...(payments.hasCash && payments.cashTenderedMinor !== null ? { cashTenderedMinor: payments.cashTenderedMinor } : {}),
            }
          : {}),
        idempotencyKey: requestKey.current,
      }),
    onSuccess: (member) => {
      toast.success(`Card ${member.cardNumber} issued`, {
        description: member.feeChangeMinor > 0 ? `Give change ${formatMoney(member.feeChangeMinor, currency)}` : member.customer?.name,
      });
      void queryClient.invalidateQueries({ queryKey: ['loyalty'] });
      onOpenChange(false);
      onIssued(member);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not issue the card'),
  });

  const canSubmit = Boolean(selected) && (feeMinor === 0 || payments.isSettled) && !issue.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Issue loyalty card</DialogTitle>
          <DialogDescription>The card is activated only after the membership fee is taken.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {selected ? (
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{selected.name}</p>
                <p className="truncate text-xs text-muted-foreground">{selected.phone}</p>
              </div>
              {!preset && (
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  Change
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <SearchInput value={term} onChange={setTerm} autoFocus placeholder="Search customers by name or phone…" />
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {(results?.items ?? []).map((customer) => (
                  <button
                    key={customer._id}
                    type="button"
                    onClick={() => setSelected(customer)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:border-primary hover:bg-accent"
                  >
                    <span className="truncate font-medium">{customer.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{customer.phone}</span>
                  </button>
                ))}
                {results && results.items.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">No customer found. Add the customer first on the Customers page.</p>
                )}
              </div>
            </div>
          )}

          <div className={cn('flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm', feeMinor === 0 && 'text-muted-foreground')}>
            <span className="flex items-center gap-1.5">
              <CreditCard className="h-4 w-4" />
              Membership fee
            </span>
            <span className="tabular font-semibold">{feeMinor > 0 ? formatMoney(feeMinor, currency) : 'Free'}</span>
          </div>

          {feeMinor > 0 && (
            <PaymentPanel
              rows={payments.rows}
              availableMethods={(config?.paymentMethods ?? ['cash']) as PaymentMethod[]}
              totalMinor={feeMinor}
              hasCash={payments.hasCash}
              remainingPayableMinor={payments.remainingPayableMinor}
              changeMinor={payments.changeMinor}
              dueMinor={payments.dueMinor}
              cashTyped={payments.cashTyped}
              issues={payments.issues}
              currency={currency}
              onAmountChange={payments.setAmount}
              onMethodChange={payments.setMethod}
              onAddRow={payments.addRow}
              onRemoveRow={payments.removeRow}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => issue.mutate()} disabled={!canSubmit} loading={issue.isPending}>
            {feeMinor > 0 ? `Take ${formatMoney(feeMinor, currency)} & issue card` : 'Issue card'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
