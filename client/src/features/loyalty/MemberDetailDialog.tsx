import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, CheckCircle2, Printer, SlidersHorizontal } from 'lucide-react';
import { loyaltyApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingState } from '@/components/states';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PAYMENT_METHOD_LABELS, type LoyaltyMember, type PaymentMethod } from '@/types/domain';
import { LoyaltyCardPrintDialog } from './LoyaltyCardPrintDialog';
import { LOYALTY_TX_LABELS, newRequestKey, useLoyaltyAccess } from './useLoyaltyAccess';

const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

interface MemberDetailDialogProps {
  memberId: string | null;
  currency: string;
  onClose: () => void;
}

export function MemberDetailDialog({ memberId, currency, onClose }: MemberDetailDialogProps) {
  const queryClient = useQueryClient();
  const { canManage } = useLoyaltyAccess();
  const [historyLimit, setHistoryLimit] = React.useState(20);
  const [printing, setPrinting] = React.useState(false);
  const [action, setAction] = React.useState<null | 'status' | 'adjust'>(null);
  const [reason, setReason] = React.useState('');
  const [points, setPoints] = React.useState('');
  const adjustKey = React.useRef(newRequestKey('adj'));

  React.useEffect(() => {
    setHistoryLimit(20);
    setAction(null);
  }, [memberId]);

  const { data: member, isLoading } = useQuery({
    queryKey: ['loyalty', 'member', memberId],
    queryFn: () => loyaltyApi.get(memberId!),
    enabled: Boolean(memberId),
  });
  const { data: history } = useQuery({
    queryKey: ['loyalty', 'history', memberId, historyLimit],
    queryFn: () => loyaltyApi.history(memberId!, { limit: historyLimit }),
    enabled: Boolean(memberId),
  });

  const refresh = (updated: LoyaltyMember) => {
    queryClient.setQueryData(['loyalty', 'member', memberId], updated);
    void queryClient.invalidateQueries({ queryKey: ['loyalty'] });
    setAction(null);
    setReason('');
    setPoints('');
    adjustKey.current = newRequestKey('adj');
  };

  const setStatus = useMutation({
    mutationFn: () => loyaltyApi.setStatus(memberId!, { status: member?.status === 'active' ? 'inactive' : 'active', reason: reason.trim() }),
    onSuccess: (updated) => {
      toast.success(updated.status === 'active' ? 'Card activated' : 'Card deactivated');
      refresh(updated);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not change the card'),
  });

  const parsedPoints = /^-?\d{1,7}$/.test(points.trim()) ? Number(points.trim()) : null;
  const adjust = useMutation({
    mutationFn: () => loyaltyApi.adjust(memberId!, { points: parsedPoints!, reason: reason.trim(), idempotencyKey: adjustKey.current }),
    onSuccess: (updated) => {
      toast.success('Points adjusted', { description: `Balance ${updated.pointsBalance}` });
      refresh(updated);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not adjust the points'),
  });

  const total = history?.meta.total ?? 0;

  return (
    <>
      <Dialog open={Boolean(memberId) && !printing} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {member?.customer?.name ?? 'Loyalty member'}
              {member && <Badge variant={member.status === 'active' ? 'success' : 'secondary'}>{member.status === 'active' ? 'Active' : 'Inactive'}</Badge>}
            </DialogTitle>
            <DialogDescription>
              {member ? `${member.cardNumber} · ${member.customer?.phone ?? ''}` : 'Loading…'}
            </DialogDescription>
          </DialogHeader>

          {isLoading || !member ? (
            <LoadingState label="Loading member…" />
          ) : (
            <div className="scrollbar-thin -mx-1 max-h-[60vh] space-y-3 overflow-y-auto px-1">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Points" value={member.pointsBalance.toLocaleString()} strong />
                <Stat label="Value" value={formatMoney(member.valueMinor, currency)} />
                <Stat label="Issued" value={formatDate(member.issuedAt)} />
                <Stat label="Earned (net)" value={member.pointsEarnedTotal.toLocaleString()} />
                <Stat label="Redeemed (net)" value={member.pointsRedeemedTotal.toLocaleString()} />
                <Stat label="Barcode" value={member.barcode} mono />
              </div>

              <div className="rounded-md border px-3 py-2 text-xs">
                <p>
                  <span className="text-muted-foreground">Membership fee: </span>
                  <span className="font-medium">{member.membershipFeeMinor > 0 ? formatMoney(member.membershipFeeMinor, currency) : 'Free'}</span>
                  {member.feePayments.length > 0 && (
                    <span className="text-muted-foreground">
                      {' '}
                      ({member.feePayments.map((p) => `${PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} ${formatMoney(p.amountMinor, currency)}`).join(', ')})
                    </span>
                  )}
                </p>
                {member.customer?.email && (
                  <p>
                    <span className="text-muted-foreground">Email: </span>
                    {member.customer.email}
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Issued by: </span>
                  {member.issuedByNameSnapshot || '—'}
                </p>
                {member.statusReason && (
                  <p>
                    <span className="text-muted-foreground">Last status change: </span>
                    {member.statusReason} ({formatDate(member.statusChangedAt)})
                  </p>
                )}
              </div>

              {action && (
                <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
                  {action === 'adjust' && (
                    <div className="space-y-1">
                      <Label htmlFor="loy-adjust-points" className="text-xs">
                        Points to add (use a minus sign to remove)
                      </Label>
                      <Input id="loy-adjust-points" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="e.g. 20 or -20" />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="loy-reason" className="text-xs">
                      Reason (recorded in the history)
                    </Label>
                    <Input id="loy-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === 'adjust' ? 'Customer service compensation' : 'Card reported lost'} />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setAction(null)}>
                      Cancel
                    </Button>
                    {action === 'adjust' ? (
                      <Button size="sm" disabled={parsedPoints === null || parsedPoints === 0 || reason.trim().length < 5} loading={adjust.isPending} onClick={() => adjust.mutate()}>
                        Save adjustment
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={member.status === 'active' ? 'destructive' : 'default'}
                        disabled={reason.trim().length < 3}
                        loading={setStatus.isPending}
                        onClick={() => setStatus.mutate()}
                      >
                        {member.status === 'active' ? 'Deactivate card' : 'Activate card'}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Point history</p>
                <div className="divide-y rounded-md border">
                  {(history?.items ?? []).map((row) => (
                    <div key={row._id} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <span className={cn('tabular w-14 shrink-0 font-semibold', row.points > 0 ? 'text-success' : 'text-destructive')}>
                        {row.points > 0 ? `+${row.points}` : row.points}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate">
                          {LOYALTY_TX_LABELS[row.type] ?? row.type}
                          {row.saleNumber && <span className="text-muted-foreground"> · {row.saleNumber}</span>}
                          {row.returnNumber && <span className="text-muted-foreground"> · {row.returnNumber}</span>}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {row.performedByNameSnapshot ? ` · ${row.performedByNameSnapshot}` : ''}
                          {row.type === 'adjustment' && row.reason ? ` · ${row.reason}` : ''}
                        </p>
                      </div>
                      <span className="tabular shrink-0 text-xs text-muted-foreground">
                        {row.balanceBefore} → {row.balanceAfter}
                      </span>
                    </div>
                  ))}
                  {history && history.items.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No point activity yet.</p>}
                </div>
                {total > historyLimit && (
                  <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setHistoryLimit((n) => n + 20)}>
                    Show more ({total - historyLimit} older)
                  </Button>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {member && canManage && !action && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setAction('adjust')}>
                    <SlidersHorizontal />
                    Adjust points
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setAction('status')}>
                    {member.status === 'active' ? <Ban /> : <CheckCircle2 />}
                    {member.status === 'active' ? 'Deactivate' : 'Activate'}
                  </Button>
                </>
              )}
            </div>
            <Button size="sm" onClick={() => setPrinting(true)} disabled={!member}>
              <Printer />
              Print card
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LoyaltyCardPrintDialog
        card={
          printing && member
            ? { cardNumber: member.cardNumber, barcode: member.barcode, customerName: member.customer?.name ?? '', phone: member.customer?.phone ?? '', email: member.customer?.email }
            : null
        }
        onClose={() => setPrinting(false)}
      />
    </>
  );
}

function Stat({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border px-2.5 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('truncate text-sm', strong && 'text-base font-semibold', mono && 'font-mono text-xs')}>{value}</p>
    </div>
  );
}
