import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, Info, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { QuantityInput } from '@/components/QuantityInput';
import { ApiError } from '@/api/client';
import { returnApi, storeApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

interface LineState {
  selected: boolean;
  quantity: number | null;
  restock: boolean;
}

export function CreateReturnPage() {
  const { saleId } = useParams<{ saleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [lines, setLines] = React.useState<Record<string, LineState>>({});
  const [reason, setReason] = React.useState('');
  const [refundMethod, setRefundMethod] = React.useState('cash');

  const { data: store } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['returnable', saleId],
    queryFn: () => returnApi.returnable(saleId!),
    enabled: Boolean(saleId),
  });

  // Seed one row of state per returnable line.
  React.useEffect(() => {
    if (!data) return;
    setLines(
      Object.fromEntries(
        data.items.map((item) => [item.saleItemId, { selected: false, quantity: null, restock: true }]),
      ),
    );
  }, [data]);

  const update = (saleItemId: string, patch: Partial<LineState>) =>
    setLines((prev) => ({ ...prev, [saleItemId]: { ...prev[saleItemId], ...patch } }));

  const selectedItems = React.useMemo(
    () =>
      (data?.items ?? [])
        .map((item) => ({ item, state: lines[item.saleItemId] }))
        .filter((entry) => entry.state?.selected),
    [data, lines],
  );

  /**
   * Local validation mirrors the server rule exactly: the quantity must be a
   * whole number between 1 and (sold - already returned). The server enforces
   * the same cap atomically, so this is guidance rather than the guarantee.
   */
  const issues = React.useMemo(() => {
    const found: string[] = [];
    for (const { item, state } of selectedItems) {
      if (state.quantity === null) {
        found.push(`Enter a quantity for "${item.productName}"`);
      } else if (state.quantity <= 0) {
        found.push(`"${item.productName}" must return at least 1`);
      } else if (state.quantity > item.returnableQuantity) {
        found.push(
          `"${item.productName}": you can return at most ${item.returnableQuantity} (sold ${item.soldQuantity}, already returned ${item.returnedQuantity})`,
        );
      }
    }
    if (selectedItems.length === 0) found.push('Select at least one item to return');
    return found;
  }, [selectedItems]);

  const refundTotal = selectedItems.reduce(
    (sum, { item, state }) => sum + (state.quantity ?? 0) * item.unitPriceMinor,
    0,
  );

  const submit = useMutation({
    mutationFn: () =>
      returnApi.create({
        saleId,
        items: selectedItems.map(({ item, state }) => ({
          saleItemId: item.saleItemId,
          quantity: state.quantity,
          restock: state.restock,
        })),
        reason: reason.trim(),
        refundMethod,
      }),
    onSuccess: (result) => {
      toast.success(`Return ${result.returnNumber} processed`, {
        description: `${formatMoney(result.totalMinor, currency)} refunded · stock restored`,
      });
      void queryClient.invalidateQueries({ queryKey: ['returns'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      navigate('/returns');
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Could not process the return';
      toast.error('Return failed', { description: message });
      void refetch();
    },
  });

  if (isLoading) return <LoadingState label="Loading sale…" />;
  if (error || !data) {
    return (
      <div className="p-6">
        <ErrorState
          title="Could not load that sale"
          message={error instanceof ApiError ? error.message : 'The sale may not exist.'}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const allReturned = data.items.every((item) => item.returnableQuantity <= 0);

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/returns')} className="-ml-2">
        <ArrowLeft />
        Back to returns
      </Button>

      <PageHeader
        title={`Return against ${data.sale.saleNumber}`}
        description={`Sold ${format(new Date(data.sale.soldAt), 'dd MMM yyyy, hh:mm a')} by ${data.sale.cashierNameSnapshot}`}
      />

      {allReturned && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <Info className="h-4 w-4 shrink-0" />
          Every item on this sale has already been returned in full.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Select what is coming back</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.items.map((item) => {
              const state = lines[item.saleItemId] ?? { selected: false, quantity: null, restock: true };
              const exhausted = item.returnableQuantity <= 0;

              return (
                <div
                  key={item.saleItemId}
                  className={cn(
                    'rounded-md border p-3 transition-colors',
                    exhausted && 'opacity-55',
                    state.selected && 'border-primary bg-primary/5',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      className="mt-1"
                      disabled={exhausted}
                      checked={state.selected}
                      onCheckedChange={(checked) =>
                        update(item.saleItemId, {
                          selected: Boolean(checked),
                          // Default to the full returnable amount, which is the
                          // common case and can still be edited down.
                          quantity: checked ? item.returnableQuantity : null,
                        })
                      }
                      aria-label={`Select ${item.productName}`}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{item.productName}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.variantName} · <span className="font-mono">{item.sku}</span>
                      </p>

                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Badge variant="secondary">Sold {item.soldQuantity}</Badge>
                        {item.returnedQuantity > 0 && (
                          <Badge variant="warning">Already returned {item.returnedQuantity}</Badge>
                        )}
                        {exhausted ? (
                          <Badge variant="destructive">Nothing left to return</Badge>
                        ) : (
                          <Badge variant="success">Can return {item.returnableQuantity}</Badge>
                        )}
                      </div>
                    </div>

                    <div className="text-right">
                      <p className="tabular text-sm font-medium">{formatMoney(item.unitPriceMinor, currency)}</p>
                      <p className="text-xs text-muted-foreground">unit price at sale</p>
                    </div>
                  </div>

                  {state.selected && (
                    <div className="mt-3 flex flex-wrap items-end gap-4 border-t pt-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Quantity to return</Label>
                        <QuantityInput
                          value={state.quantity}
                          onChange={(quantity) => update(item.saleItemId, { quantity })}
                          max={item.returnableQuantity}
                          ariaLabel={`Return quantity for ${item.productName}`}
                        />
                      </div>

                      <label className="flex items-center gap-2 pb-2 text-sm">
                        <Checkbox
                          checked={state.restock}
                          onCheckedChange={(checked) => update(item.saleItemId, { restock: Boolean(checked) })}
                        />
                        Put back into stock
                      </label>

                      <div className="ml-auto text-right">
                        <p className="text-xs text-muted-foreground">Refund</p>
                        <p className="tabular font-semibold">
                          {formatMoney((state.quantity ?? 0) * item.unitPriceMinor, currency)}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Refund details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ret-method">Refund method</Label>
                <Select value={refundMethod} onValueChange={setRefundMethod}>
                  <SelectTrigger id="ret-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(store?.paymentMethods ?? ['cash']).map((method) => (
                      <SelectItem key={method} value={method}>
                        {method}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ret-reason">Reason</Label>
                <Textarea
                  id="ret-reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Wrong size, faulty stitching, customer changed their mind…"
                />
              </div>

              <Separator />

              <div className="flex justify-between text-lg font-semibold">
                <span>Refund total</span>
                <span className="tabular">{formatMoney(refundTotal, currency)}</span>
              </div>

              {issues.length > 0 && selectedItems.length > 0 && (
                <ul className="list-inside list-disc rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  {issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}

              <Button
                className="w-full"
                size="lg"
                disabled={issues.length > 0 || allReturned}
                loading={submit.isPending}
                onClick={() => submit.mutate()}
              >
                <RotateCcw />
                Process return
              </Button>

              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Refunds always use the price the item was originally sold at, even if the product's price has changed
                since.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-1 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sale total</span>
                <span className="tabular">{formatMoney(data.sale.totalMinor, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Already refunded</span>
                <span className="tabular">{formatMoney(data.sale.returnedTotalMinor, currency)}</span>
              </div>
              {data.sale.customerSnapshot && (
                <div className="flex justify-between border-t pt-1">
                  <span className="text-muted-foreground">Customer</span>
                  <span>{data.sale.customerSnapshot.name}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
