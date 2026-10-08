import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, CreditCard } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { ApiError } from '@/api/client';
import type { PaymentProviderOption } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';

export interface TopUpInstruction {
  method: string;
  label: string;
  accountNumber: string;
  steps: string[];
}

export interface TopUpSubmission {
  amountMinor: number;
  paymentMethod: string;
  senderNumber: string;
  transactionId: string;
  workspaceId?: string;
}

/**
 * Adding money to the wallet, either way the platform offers.
 *
 * Paying a gateway is instant: the customer is sent to the provider's checkout
 * and the balance moves when the provider confirms the payment, with nobody in
 * the loop. Declaring a transfer credits nothing here - it records what the
 * customer says they sent, and a platform admin verifies it.
 *
 * Which of the two appear is the server's decision, not this component's: a
 * gateway shows up because the server listed it as usable, and the manual form
 * because there are instructions to follow. When the platform admin has
 * switched everything off, the dialog says so rather than showing a form that
 * cannot be submitted.
 */
export function TopUpDialog({
  open,
  onOpenChange,
  instructions,
  providers = [],
  workspaces,
  submit,
  startOnline,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instructions: TopUpInstruction[];
  /** Gateways the server says may be used right now; only hosted ones are offered here. */
  providers?: PaymentProviderOption[];
  /** When given, the owner picks which workspace the request is filed under. */
  workspaces?: { id: string; name: string }[];
  submit: (body: TopUpSubmission) => Promise<unknown>;
  /** Opens a gateway checkout and returns where to send the customer. Omitted where unsupported. */
  startOnline?: (body: { amountMinor: number; provider: string }) => Promise<{ redirectUrl: string | null }>;
  onDone: () => void;
}) {
  const [amountMinor, setAmountMinor] = React.useState<number | null>(null);
  const [method, setMethod] = React.useState('bkash');
  const [senderNumber, setSenderNumber] = React.useState('');
  const [transactionId, setTransactionId] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState('');

  const gateways = React.useMemo(() => (startOnline ? providers.filter((provider) => provider.kind === 'hosted') : []), [providers, startOnline]);

  React.useEffect(() => {
    if (open) {
      setAmountMinor(null);
      setSenderNumber('');
      setTransactionId('');
      setMethod(instructions[0]?.method ?? 'bkash');
      setWorkspaceId(workspaces?.[0]?.id ?? '');
    }
  }, [open, instructions, workspaces]);

  const selected = instructions.find((instruction) => instruction.method === method);
  const amountValid = amountMinor !== null && amountMinor > 0;

  const request = useMutation({
    mutationFn: () =>
      submit({
        amountMinor: amountMinor ?? 0,
        paymentMethod: method,
        senderNumber,
        transactionId: transactionId.trim(),
        ...(workspaces && workspaceId ? { workspaceId } : {}),
      }),
    onSuccess: () => {
      toast.success('Top-up submitted', { description: 'Your balance updates once we verify the payment.' });
      onOpenChange(false);
      onDone();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not submit the top-up'),
  });

  const payOnline = useMutation({
    mutationFn: (provider: string) => startOnline!({ amountMinor: amountMinor ?? 0, provider }),
    onSuccess: (result) => {
      if (!result.redirectUrl) {
        toast.error('The payment page could not be opened. Please try again.');
        return;
      }
      // The balance moves when the provider confirms the payment, never because
      // the browser came back.
      window.location.assign(result.redirectUrl);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not open the payment page'),
  });

  // The server enforces the same rules.
  const senderDigits = senderNumber.replace(/\D/g, '').length;
  const senderValid = senderDigits >= 6 && /^[+()\-\s\d.]*$/.test(senderNumber.trim());
  const txValid = transactionId.trim().length >= 4;
  const valid = amountValid && senderValid && txValid && (!workspaces || Boolean(workspaceId));
  const busy = request.isPending || payOnline.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add money to your wallet</DialogTitle>
          <DialogDescription>
            {gateways.length > 0
              ? 'Pay online and your balance updates as soon as the payment is confirmed.'
              : 'Send the amount, then enter the transaction ID. We verify it before crediting your balance.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {workspaces && workspaces.length > 1 && (
            <div className="space-y-1.5">
              <Label>Requested from</Label>
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger aria-label="Workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">The money goes into the one account wallet all your workspaces share.</p>
            </div>
          )}

          {/* One amount for both ways of paying, so choosing one does not mean retyping it. */}
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <MoneyInput value={amountMinor} onChange={setAmountMinor} ariaLabel="Top-up amount" />
          </div>

          {gateways.map((gateway) => (
            <button
              key={gateway.name}
              type="button"
              disabled={!amountValid || busy}
              onClick={() => payOnline.mutate(gateway.name)}
              className="flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-start transition-colors hover:border-primary hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CreditCard className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium">
                  Pay with {gateway.displayName}
                  <Badge variant="success">Instant</Badge>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {payOnline.isPending
                    ? `Opening ${gateway.displayName}…`
                    : amountValid
                      ? `You pay ${formatMoney(amountMinor!)} on ${gateway.displayName}; your balance updates once it is confirmed`
                      : 'Enter an amount first'}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}

          {gateways.length > 0 && instructions.length > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or send the money yourself</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          {instructions.length > 0 ? (
            <>
              <div className="space-y-1.5">
                <Label>Payment method</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger aria-label="Payment method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {instructions.map((option) => (
                      <SelectItem key={option.method} value={option.method}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selected && (
                <div className="rounded-md border bg-muted/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Send to</span>
                    <span className="font-mono text-sm font-semibold">{selected.accountNumber}</span>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Your number (required)</Label>
                <Input inputMode="tel" value={senderNumber} onChange={(event) => setSenderNumber(event.target.value)} placeholder="01XXXXXXXXX" />
                {senderNumber.length > 0 && !senderValid && <p className="text-xs text-destructive">Enter the phone or account number you paid from</p>}
              </div>

              <div className="space-y-1.5">
                <Label>Transaction ID</Label>
                <Input
                  value={transactionId}
                  onChange={(event) => setTransactionId(event.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="e.g. 9F2K1LM8QP"
                />
              </div>
            </>
          ) : (
            gateways.length === 0 && (
              <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                No way of adding money is switched on right now. Please contact support.
              </p>
            )
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {instructions.length > 0 && (
            <Button disabled={!valid} loading={request.isPending} onClick={() => request.mutate()}>
              Submit top-up
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
