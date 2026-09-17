import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { ApiError } from '@/api/client';

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
 * Filing a wallet top-up claim: where to send money, then the amount, the
 * sending number and the transaction ID. Nothing is credited here - the server
 * waits for a platform admin to verify the payment. Used inside a workspace and
 * from the account's Billing page (which also picks the workspace).
 */
export function TopUpDialog({
  open,
  onOpenChange,
  instructions,
  workspaces,
  submit,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instructions: TopUpInstruction[];
  /** When given, the owner picks which workspace the request is filed under. */
  workspaces?: { id: string; name: string }[];
  submit: (body: TopUpSubmission) => Promise<unknown>;
  onDone: () => void;
}) {
  const [amountMinor, setAmountMinor] = React.useState<number | null>(null);
  const [method, setMethod] = React.useState('bkash');
  const [senderNumber, setSenderNumber] = React.useState('');
  const [transactionId, setTransactionId] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState('');

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

  // The server enforces the same rules.
  const senderDigits = senderNumber.replace(/\D/g, '').length;
  const senderValid = senderDigits >= 6 && /^[+()\-\s\d.]*$/.test(senderNumber.trim());
  const txValid = transactionId.trim().length >= 4;
  const valid = amountMinor !== null && amountMinor > 0 && senderValid && txValid && (!workspaces || Boolean(workspaceId));

  return (
    <Dialog open={open} onOpenChange={(next) => !request.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add money to your wallet</DialogTitle>
          <DialogDescription>Send the amount, then enter the transaction ID. We verify it before crediting your balance.</DialogDescription>
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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Amount sent</Label>
              <MoneyInput value={amountMinor} onChange={setAmountMinor} ariaLabel="Top-up amount" />
            </div>
            <div className="space-y-1.5">
              <Label>Your number (required)</Label>
              <Input inputMode="tel" value={senderNumber} onChange={(event) => setSenderNumber(event.target.value)} placeholder="01XXXXXXXXX" />
              {senderNumber.length > 0 && !senderValid && <p className="text-xs text-destructive">Enter the phone or account number you paid from</p>}
            </div>
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={request.isPending} onClick={() => request.mutate()}>
            Submit top-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
