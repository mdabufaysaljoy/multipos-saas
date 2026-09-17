import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError } from '@/components/FieldError';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';

type Method = 'bkash' | 'nagad' | 'bank';

interface Instruction {
  method: Method;
  label: string;
  accountNumber: string;
  accountName: string;
  steps: string[];
  isActive: boolean;
}

const BLANK: Instruction = {
  method: 'bkash',
  label: 'bKash',
  accountNumber: '',
  accountName: '',
  steps: [],
  isActive: true,
};

/**
 * The accounts customers actually send money to.
 *
 * These drive the payment screens shown to every store owner during an upgrade
 * or wallet top-up. They were editable through the API and set by the seed, but
 * had no interface at all - so changing a receiving number meant editing the
 * database by hand. Account numbers change; this has to be a screen.
 */
export function PaymentInstructionsCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['platform', 'settings'], queryFn: platformApi.settings });

  const [rows, setRows] = React.useState<Instruction[]>([]);
  const [support, setSupport] = React.useState({ email: '', phone: '' });
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (!data || loaded) return;
    setRows(
      ((data.paymentInstructions as Instruction[]) ?? []).map((row) => ({
        ...BLANK,
        ...row,
        steps: row.steps ?? [],
      })),
    );
    setSupport({ email: data.supportEmail ?? '', phone: data.supportPhone ?? '' });
    setLoaded(true);
  }, [data, loaded]);

  const patch = (index: number, changes: Partial<Instruction>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  // Every active method must carry an account number, or a customer is shown a
  // payment screen with nowhere to send the money.
  const errorFor = (row: Instruction) => {
    if (!row.isActive) return undefined;
    if (row.accountNumber.trim().length < 3) return 'An active method needs an account number';
    if (row.label.trim().length < 1) return 'Give this method a label';
    return undefined;
  };
  const invalid = rows.some((row) => errorFor(row) !== undefined);

  const save = useMutation({
    mutationFn: () =>
      platformApi.updateSettings({
        paymentInstructions: rows.map((row) => ({
          method: row.method,
          label: row.label.trim(),
          accountNumber: row.accountNumber.trim(),
          accountName: row.accountName.trim(),
          steps: row.steps.map((s) => s.trim()).filter(Boolean).slice(0, 8),
          isActive: row.isActive,
        })),
        supportEmail: support.email.trim(),
        supportPhone: support.phone.trim(),
      }),
    onSuccess: () => {
      toast.success('Payment details saved');
      void queryClient.invalidateQueries({ queryKey: ['platform', 'settings'] });
      void queryClient.invalidateQueries({ queryKey: ['payment-instructions'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Payment receiving accounts</CardTitle>
        <CardDescription>
          Shown to store owners when they pay for a subscription or top up their wallet. Up to six methods.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {rows.length === 0 && (
          <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
            No payment methods are configured, so customers have no way to pay by transfer.
          </p>
        )}

        {rows.map((row, index) => (
          <div key={index} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Select value={row.method} onValueChange={(v) => patch(index, { method: v as Method })}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bkash">bKash</SelectItem>
                    <SelectItem value="nagad">Nagad</SelectItem>
                    <SelectItem value="bank">Bank</SelectItem>
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={row.isActive} onCheckedChange={(v) => patch(index, { isActive: v })} />
                  <span className="text-muted-foreground">{row.isActive ? 'Shown' : 'Hidden'}</span>
                </label>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove method"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              >
                <Trash2 className="text-destructive" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Label</Label>
                <Input value={row.label} onChange={(e) => patch(index, { label: e.target.value })} placeholder="bKash" />
              </div>
              <div className="space-y-1.5">
                <Label>Receiving number / account</Label>
                <Input
                  inputMode="tel"
                  value={row.accountNumber}
                  onChange={(e) => patch(index, { accountNumber: e.target.value })}
                  placeholder="01700-000000"
                />
                <FieldError message={errorFor(row)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Account name</Label>
                <Input
                  value={row.accountName}
                  onChange={(e) => patch(index, { accountName: e.target.value })}
                  placeholder="Clothing POS Ltd"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Steps for the customer (one per line)</Label>
                <Textarea
                  rows={3}
                  value={row.steps.join('\n')}
                  onChange={(e) => patch(index, { steps: e.target.value.split('\n') })}
                  placeholder={'Open bKash and choose Send Money.\nSend the exact amount to the number above.'}
                />
              </div>
            </div>
          </div>
        ))}

        {rows.length < 6 && (
          <Button variant="outline" className="w-full" onClick={() => setRows((prev) => [...prev, { ...BLANK }])}>
            <Plus />
            Add a payment method
          </Button>
        )}

        <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Support email</Label>
            <Input
              inputMode="email"
              value={support.email}
              onChange={(e) => setSupport((s) => ({ ...s, email: e.target.value }))}
              placeholder="support@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Support phone</Label>
            <Input
              inputMode="tel"
              value={support.phone}
              onChange={(e) => setSupport((s) => ({ ...s, phone: e.target.value }))}
              placeholder="+880 1700-000000"
            />
          </div>
        </div>

        <Button className="w-full" disabled={invalid} loading={save.isPending} onClick={() => save.mutate()}>
          Save payment details
        </Button>
      </CardContent>
    </Card>
  );
}
