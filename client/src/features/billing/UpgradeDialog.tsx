import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, CheckCircle2, Info, Smartphone, Wallet } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/api/client';
import { billingApi, walletApi, type PurchaseBody } from '@/api/endpoints';
import { VerifyContactCard } from '@/features/verification/VerifyContactCard';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney, formatPlanPrice } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { SubscriptionPlan } from '@/types/domain';

interface UpgradeDialogProps {
  plan: SubscriptionPlan | null;
  currentPlanName: string | null;
  /** Payment instructions configured by the platform admin, never hardcoded. */
  instructions: PaymentInstruction[];
  onClose: () => void;
}

export interface PaymentInstruction {
  method: 'bkash' | 'nagad' | 'bank';
  label: string;
  accountNumber: string;
  accountName?: string;
  steps: string[];
}

/** One key per purchase attempt: a double click or a network retry cannot buy twice. */
const newPurchaseKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** A purchase body without the parts the dialog fills in, kept per payment method. */
type PurchaseMethodBody = PurchaseBody extends infer Body
  ? Body extends unknown
    ? Omit<Body, 'plan' | 'billingCycle' | 'idempotencyKey'>
    : never
  : never;

/**
 * Buying a plan.
 *
 * The price shown and charged comes from the server: the dialog asks for a
 * quote in catalog terms (plan + billing cycle) and every purchase sends only
 * that, the payment method and a retry key. A manual transfer files a REQUEST;
 * the plan does not change until a platform admin verifies it.
 */
export function UpgradeDialog({ plan, currentPlanName, instructions, onClose }: UpgradeDialogProps) {
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const [step, setStep] = React.useState<'method' | 'pay' | 'wallet' | 'done'>('method');
  const [method, setMethod] = React.useState<PaymentInstruction | null>(null);
  const [senderNumber, setSenderNumber] = React.useState('');
  const [transactionId, setTransactionId] = React.useState('');
  const [note, setNote] = React.useState('');
  const [purchaseKey, setPurchaseKey] = React.useState(newPurchaseKey);

  const target = plan?.catalogPlanCode && plan.billingCycle ? { plan: plan.catalogPlanCode, billingCycle: plan.billingCycle } : null;

  React.useEffect(() => {
    if (!plan) return;
    setStep('method');
    setMethod(null);
    setSenderNumber('');
    setTransactionId('');
    setNote('');
    setPurchaseKey(newPurchaseKey());
  }, [plan]);

  // The server's price for this workspace. Bespoke plans without a catalog entry
  // use the price the server already sent with the plan.
  const quote = useQuery({
    queryKey: ['purchase-quote', target?.plan, target?.billingCycle],
    queryFn: () => billingApi.purchaseQuote(target!),
    enabled: Boolean(target),
    retry: false,
  });
  const currency = quote.data?.currency ?? plan?.currency ?? 'BDT';
  const priceMinor = quote.data?.payableMinor ?? plan?.priceMinor ?? 0;
  const priceReady = !target || quote.isSuccess;

  // Same key the wallet panel and marketing page use, so this shares their cache entry.
  // The account wallet is only read (and paid from) with the wallet permission.
  const { can: canUseWallet, session } = useAuth();
  // Buying needs one proven contact; the server refuses otherwise, so the
  // dialog asks for it here rather than letting the purchase fail.
  const contactVerified = session?.user.verification?.anyVerified !== false;
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: walletApi.balance, enabled: Boolean(plan) && canUseWallet('wallet.view') });
  const balanceMinor = wallet.data?.balanceMinor ?? 0;
  const walletFrozen = wallet.data?.isFrozen ?? false;
  const walletCovers = priceReady && balanceMinor >= priceMinor;
  const isRenewal = quote.data ? quote.data.transition.kind === 'renewal' : Boolean(plan && currentPlanName && plan.name === currentPlanName);

  const buy = (body: PurchaseMethodBody) =>
    billingApi.purchase({ ...target!, ...body, idempotencyKey: purchaseKey } as PurchaseBody);

  const submit = useMutation({
    mutationFn: (): Promise<unknown> =>
      target
        ? buy({ paymentMethod: 'manual', manualMethod: method!.method, senderNumber: senderNumber.trim(), transactionId: transactionId.trim(), note })
        : billingApi.submitUpgrade({
            planId: plan!._id,
            paymentMethod: method!.method,
            amountMinor: priceMinor,
            senderNumber,
            transactionId: transactionId.trim(),
            note,
          }),
    onSuccess: () => {
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['upgrade-requests'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not submit your request')),
  });

  const payFromWallet = useMutation({
    mutationFn: (): Promise<unknown> =>
      target
        ? buy({ paymentMethod: 'wallet', note })
        : billingApi.submitUpgrade({ planId: plan!._id, paymentMethod: 'wallet', amountMinor: priceMinor, note }),
    onSuccess: () => {
      toast.success('Subscription activated');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
      // The plan is live, so reload the session - it carries the entitlement.
      void refresh();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error, 'Wallet payment failed')),
  });

  // Online bKash checkout, offered only when the server has it configured.
  const providers = useQuery({ queryKey: ['payment-providers'], queryFn: billingApi.providers, enabled: Boolean(plan) });
  const bkashOnline = (providers.data ?? []).some((provider) => provider.name === 'bkash');
  const payWithBkash = useMutation({
    mutationFn: async () => {
      if (!target) return billingApi.checkout({ planId: plan!._id, provider: 'bkash' });
      const result = await buy({ paymentMethod: 'online', provider: 'bkash' });
      return result.method === 'online' ? result : { redirectUrl: null };
    },
    onSuccess: (result) => {
      if (!result.redirectUrl) {
        toast.error('bKash did not return a payment page. Please try again.');
        return;
      }
      // The plan is activated only after bKash confirms the payment to the server.
      window.location.assign(result.redirectUrl);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not start the bKash payment')),
  });

  const senderValid = senderNumber.replace(/\D/g, '').length >= 6 && /^[+()\-\s\d.]*$/.test(senderNumber.trim());
  const canSubmit = Boolean(method) && priceReady && senderValid && transactionId.trim().length >= 4;
  const intervalLabel = (quote.data?.billingCycle ?? (plan?.interval === 'yearly' ? 'annual' : 'monthly')) === 'annual' ? 'per year' : 'per month';

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        {step === 'done' ? (
          <>
            <DialogHeader>
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-success/12 text-success">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <DialogTitle className="text-center">Payment details submitted</DialogTitle>
              <DialogDescription className="text-center">
                We have received your transaction reference and will verify it shortly.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <p className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>Your plan has not changed yet.</strong> {plan?.name} becomes active once our team confirms the
                  payment. You will keep your current plan until then.
                </span>
              </p>
            </div>

            <DialogFooter>
              <Button className="w-full" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : !contactVerified ? (
          <>
            <DialogHeader>
              <DialogTitle>Verify your contact first</DialogTitle>
              <DialogDescription>
                Confirm your email address or phone number before buying a plan. Your invoice, receipts and renewal
                reminders go there.
              </DialogDescription>
            </DialogHeader>
            <VerifyContactCard />
            <DialogFooter>
              <Button variant="outline" className="w-full" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{isRenewal ? `Renew ${plan?.name}` : `Upgrade to ${plan?.name}`}</DialogTitle>
              <DialogDescription>
                {isRenewal
                  ? 'Your plan has lapsed. Paying restores access to the rest of the app.'
                  : currentPlanName
                    ? `Moving from ${currentPlanName}.`
                    : 'Choose how you would like to pay.'}
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center justify-between rounded-md border bg-muted/40 p-3">
              <div>
                <p className="text-sm text-muted-foreground">You pay</p>
                <p className="tabular text-xl font-semibold">
                  {target && quote.isLoading ? '…' : formatPlanPrice(priceMinor, currency)}
                </p>
                {quote.data?.proration && quote.data.proration.appliedMinor > 0 && (
                  <p className="text-xs text-success">
                    Includes {formatMoney(quote.data.proration.appliedMinor, currency)} credit for unused time on your current plan
                  </p>
                )}
                {quote.data && quote.data.walletRefundMinor > 0 && (
                  <p className="text-xs text-success">
                    {formatMoney(quote.data.walletRefundMinor, currency)} of unused credit goes back to your wallet
                  </p>
                )}
                {quote.data && quote.data.freeMonths > 0 && (
                  <p className="text-xs text-success">
                    {quote.data.freeMonths} months free · save {formatMoney(quote.data.savingsMinor, currency)}
                  </p>
                )}
              </div>
              <Badge variant="secondary">{intervalLabel}</Badge>
            </div>

            {quote.isError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {errorMessage(quote.error, 'This plan cannot be bought right now.')}
              </p>
            )}

            {step === 'method' && priceReady && (
              <div className="space-y-2">
                <Label className="text-xs">Payment method</Label>

                <button
                  type="button"
                  disabled={!walletCovers || walletFrozen}
                  onClick={() => setStep('wallet')}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors',
                    walletCovers && !walletFrozen ? 'hover:border-primary hover:bg-accent' : 'cursor-not-allowed opacity-60',
                  )}
                >
                  <Wallet className="h-5 w-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      Pay from wallet
                      <Badge variant="success">Instant</Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {wallet.isLoading
                        ? 'Checking your balance…'
                        : walletFrozen
                          ? 'Your wallet is frozen. Contact support.'
                          : walletCovers
                            ? `Balance ${formatMoney(balanceMinor, currency)} — activates immediately`
                            : `Balance ${formatMoney(balanceMinor, currency)} — ${formatMoney(priceMinor - balanceMinor, currency)} short`}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </button>

                {bkashOnline && (
                  <button
                    type="button"
                    disabled={payWithBkash.isPending}
                    onClick={() => payWithBkash.mutate()}
                    className="flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors hover:border-primary hover:bg-accent disabled:opacity-60"
                  >
                    <Smartphone className="h-5 w-5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-medium">
                        Pay online with bKash
                        <Badge variant="success">Instant</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {payWithBkash.isPending ? 'Opening bKash…' : `You approve ${formatMoney(priceMinor, currency)} on bKash; the plan activates once bKash confirms`}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                )}

                {instructions.length > 0 && <p className="pt-1 text-xs text-muted-foreground">Or pay manually and we will verify it:</p>}

                {instructions.length === 0 ? (
                  <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                    No manual payment methods have been configured yet. Top up your wallet or contact support to arrange your upgrade.
                  </p>
                ) : (
                  instructions.map((option) => (
                    <button
                      key={option.method}
                      type="button"
                      onClick={() => {
                        setMethod(option);
                        setStep('pay');
                      }}
                      className="flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors hover:border-primary hover:bg-accent"
                    >
                      <Smartphone className="h-5 w-5 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{option.label}</p>
                        <p className="truncate text-xs text-muted-foreground">Send to {option.accountNumber}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>
            )}

            {step === 'wallet' && (
              <div className="space-y-4">
                <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Wallet balance</span>
                    <span className="tabular font-medium">{formatMoney(balanceMinor, currency)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{plan?.name} plan</span>
                    <span className="tabular font-medium text-destructive">−{formatMoney(priceMinor, currency)}</span>
                  </div>
                  <div className="flex items-center justify-between border-t pt-2">
                    <span className="font-medium">Balance after</span>
                    <span className="tabular font-semibold">{formatMoney(balanceMinor - priceMinor, currency)}</span>
                  </div>
                </div>

                <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
                  <p className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      This is settled money, so <strong>{plan?.name} activates straight away</strong> — no waiting for manual verification.
                    </span>
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>Note (optional)</Label>
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>
            )}

            {step === 'pay' && method && (
              <div className="space-y-4">
                <div className="rounded-md border bg-muted/40 p-3">
                  <p className="text-sm font-medium">{method.label} instructions</p>
                  <div className="mt-2 flex items-center justify-between rounded bg-background px-3 py-2">
                    <span className="text-xs text-muted-foreground">Send exactly</span>
                    <span className="tabular text-sm font-semibold">{formatMoney(priceMinor, currency)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between rounded bg-background px-3 py-2">
                    <span className="text-xs text-muted-foreground">To</span>
                    <span className="font-mono text-sm font-semibold">{method.accountNumber}</span>
                  </div>
                  {method.accountName && <p className="mt-1 text-xs text-muted-foreground">Account name: {method.accountName}</p>}
                  <ol className="mt-2 list-inside list-decimal space-y-0.5 text-xs text-muted-foreground">
                    {method.steps.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ol>
                </div>

                <div className="space-y-1.5">
                  <Label>Your {method.label} number</Label>
                  <Input inputMode="tel" value={senderNumber} onChange={(e) => setSenderNumber(e.target.value)} placeholder="01XXXXXXXXX" />
                  {senderNumber.length > 0 && !senderValid && <p className="text-xs text-destructive">Enter the number you paid from</p>}
                </div>

                <div className="space-y-1.5">
                  <Label>Transaction ID</Label>
                  <Input
                    value={transactionId}
                    onChange={(e) => setTransactionId(e.target.value.toUpperCase())}
                    placeholder="e.g. 9F2K1LM8QP"
                    className={cn('font-mono', transactionId && transactionId.trim().length < 4 && 'border-destructive')}
                  />
                  <p className="text-xs text-muted-foreground">
                    The reference from your payment confirmation message. We verify this before activating your plan.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>Note (optional)</Label>
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>
            )}

            <DialogFooter>
              {step === 'wallet' ? (
                <>
                  <Button variant="outline" onClick={() => setStep('method')}>
                    Back
                  </Button>
                  <Button disabled={!walletCovers || walletFrozen} loading={payFromWallet.isPending} onClick={() => payFromWallet.mutate()}>
                    Pay {formatMoney(priceMinor, currency)} from wallet
                  </Button>
                </>
              ) : step === 'pay' ? (
                <>
                  <Button variant="outline" onClick={() => setStep('method')}>
                    Back
                  </Button>
                  <Button disabled={!canSubmit} loading={submit.isPending} onClick={() => submit.mutate()}>
                    Submit payment request
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
