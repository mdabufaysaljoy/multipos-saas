import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Ban, Printer, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { Separator } from '@/components/ui/separator';
import { LoadingState } from '@/components/states';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { saleApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';

interface SaleDetailDialogProps {
  saleId: string | null;
  onClose: () => void;
  onPrint: (saleId: string) => void;
}

export function SaleDetailDialog({ saleId, onClose, onPrint }: SaleDetailDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [cancelling, setCancelling] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const { data: sale, isLoading } = useQuery({
    queryKey: ['sale', saleId],
    queryFn: () => saleApi.get(saleId!),
    enabled: Boolean(saleId),
  });

  const cancel = useMutation({
    mutationFn: () => saleApi.cancel(saleId!, reason),
    onSuccess: () => {
      toast.success('Sale cancelled and stock restored');
      setCancelling(false);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale', saleId] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not cancel the sale'),
  });

  return (
    <Dialog open={Boolean(saleId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {isLoading || !sale ? (
          <LoadingState label="Loading sale…" />
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <DialogTitle className="font-mono">{sale.saleNumber}</DialogTitle>
                {sale.status === 'cancelled' && <Badge variant="destructive">Cancelled</Badge>}
                {sale.fullyReturned && <Badge variant="warning">Fully returned</Badge>}
              </div>
              <DialogDescription>
                {format(new Date(sale.soldAt), 'dd MMMM yyyy, hh:mm a')} · Cashier {sale.cashierNameSnapshot}
              </DialogDescription>
            </DialogHeader>

            <div className="scrollbar-thin max-h-[55vh] space-y-4 overflow-y-auto">
              {sale.customerSnapshot && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="font-medium">{sale.customerSnapshot.name}</p>
                  <p className="text-muted-foreground">{sale.customerSnapshot.phone}</p>
                </div>
              )}

              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">Item</th>
                      <th className="px-3 py-2 text-right font-semibold">Price</th>
                      <th className="px-3 py-2 text-right font-semibold">Qty</th>
                      <th className="px-3 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sale.items.map((item) => (
                      <tr key={item._id} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          {/* Rendered entirely from the stored snapshot. */}
                          <p className="font-medium">{item.productNameSnapshot}</p>
                          <p className="text-xs text-muted-foreground">
                            {item.variantNameSnapshot} · <span className="font-mono">{item.skuSnapshot}</span>
                          </p>
                          {item.outOfStockOverride && (
                            <p className="mt-0.5 text-xs font-medium text-warning">Out-of-stock override</p>
                          )}
                          {item.returnedQuantity > 0 && (
                            <p className="mt-0.5 text-xs text-destructive">{item.returnedQuantity} returned</p>
                          )}
                        </td>
                        <td className="tabular px-3 py-2 text-right">
                          {formatMoney(item.unitPriceMinor, currency)}
                          {item.unitPriceMinor !== item.listPriceMinor && (
                            <p className="text-xs text-muted-foreground line-through">
                              {formatMoney(item.listPriceMinor, currency)}
                            </p>
                          )}
                        </td>
                        <td className="tabular px-3 py-2 text-right">{item.quantity}</td>
                        <td className="tabular px-3 py-2 text-right font-medium">
                          {formatMoney(item.lineTotalMinor, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <dl className="ml-auto max-w-xs space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Subtotal</dt>
                  <dd className="tabular">{formatMoney(sale.subtotalMinor, currency)}</dd>
                </div>
                {sale.discountMinor - (sale.loyalty?.discountMinor ?? 0) > 0 && (
                  <div className="flex justify-between text-success">
                    <dt>Discount</dt>
                    <dd className="tabular">-{formatMoney(sale.discountMinor - (sale.loyalty?.discountMinor ?? 0), currency)}</dd>
                  </div>
                )}
                {(sale.loyalty?.discountMinor ?? 0) > 0 && (
                  <div className="flex justify-between text-success">
                    <dt>Loyalty ({sale.loyalty!.pointsRedeemed} pts)</dt>
                    <dd className="tabular">-{formatMoney(sale.loyalty!.discountMinor, currency)}</dd>
                  </div>
                )}
                {sale.taxMinor > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Tax</dt>
                    <dd className="tabular">{formatMoney(sale.taxMinor, currency)}</dd>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular">{formatMoney(sale.totalMinor, currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Paid ({sale.paymentMethod})</dt>
                  <dd className="tabular">{formatMoney(sale.paidMinor, currency)}</dd>
                </div>
                {sale.changeMinor > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Change</dt>
                    <dd className="tabular">{formatMoney(sale.changeMinor, currency)}</dd>
                  </div>
                )}
                {sale.returnedTotalMinor > 0 && (
                  <div className="flex justify-between text-destructive">
                    <dt>Returned</dt>
                    <dd className="tabular">-{formatMoney(sale.returnedTotalMinor, currency)}</dd>
                  </div>
                )}
              </dl>

              {sale.loyalty && (
                <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                  Loyalty card <span className="font-mono">{sale.loyalty.cardNumber}</span>
                  {sale.loyalty.pointsRedeemed > 0 && ` · ${sale.loyalty.pointsRedeemed} redeemed`}
                  {sale.loyalty.pointsEarned > 0 && ` · ${sale.loyalty.pointsEarned} earned`}
                  {` · balance after sale ${sale.loyalty.balanceAfter}`}
                  {sale.loyalty.pointsEarnedReversed + sale.loyalty.pointsRedeemedRestored > 0 &&
                    ` · returns: ${sale.loyalty.pointsEarnedReversed} taken back, ${sale.loyalty.pointsRedeemedRestored} given back`}
                </p>
              )}

              {sale.note && (
                <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-muted-foreground">{sale.note}</p>
              )}

              {cancelling && (
                <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <Label htmlFor="cancel-reason">Reason for cancelling</Label>
                  <Input
                    id="cancel-reason"
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Duplicate transaction, customer changed their mind…"
                  />
                  <p className="text-xs text-muted-foreground">
                    All items go back into stock. This cannot be undone.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              {cancelling ? (
                <>
                  <Button variant="outline" onClick={() => setCancelling(false)}>
                    Keep sale
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={reason.trim().length < 3}
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    Cancel this sale
                  </Button>
                </>
              ) : (
                <>
                  {sale.status === 'completed' && (
                    <PermissionGate anyOf={['sales.cancel']}>
                      <Button variant="outline" className="mr-auto" onClick={() => setCancelling(true)}>
                        <Ban />
                        Cancel sale
                      </Button>
                    </PermissionGate>
                  )}
                  {sale.status === 'completed' && !sale.fullyReturned && (
                    <PermissionGate anyOf={['returns.create']}>
                      <Button variant="outline" onClick={() => { onClose(); navigate(`/returns/new/${sale._id}`); }}>
                        <RotateCcw />
                        Create return
                      </Button>
                    </PermissionGate>
                  )}
                  <Button onClick={() => onPrint(sale._id)}>
                    <Printer />
                    Print receipt
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
