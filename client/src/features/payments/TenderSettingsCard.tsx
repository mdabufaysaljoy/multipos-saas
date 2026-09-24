import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/api/client';
import { paymentMethodApi } from '@/api/endpoints';
import type { CustomPaymentMethod, TenderOption } from '@/types/domain';

interface TenderSettingsCardProps {
  /** The keys this branch takes. */
  enabled: string[];
  readOnly: boolean;
  onChange: (enabled: string[]) => void;
}

type TenderRow = TenderOption & { _id?: string };

/**
 * Which tenders this branch takes, and what this workspace calls them.
 *
 * The six built-ins exist everywhere and cannot be removed - a sale that says
 * "cash" has to mean cash in every workspace. A shop can add its own (a local
 * wallet, a meal voucher); switching one off takes it off every till at once,
 * and every sale already taken keeps the name it was taken under.
 */
export function TenderSettingsCard({ enabled, readOnly, onChange }: TenderSettingsCardProps) {
  const queryClient = useQueryClient();
  const [label, setLabel] = React.useState('');

  const { data: tenders } = useQuery({ queryKey: ['payment-methods'], queryFn: paymentMethodApi.list });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
    void queryClient.invalidateQueries({ queryKey: ['store', 'pos-config'] });
  };
  const fail = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback);

  const create = useMutation({
    mutationFn: () => paymentMethodApi.create({ label: label.trim() }),
    onSuccess: (method: CustomPaymentMethod) => {
      toast.success(`${method.label} added`, { description: 'Switch it on below to take it at this branch.' });
      setLabel('');
      refresh();
    },
    onError: (err) => fail(err, 'Could not add that payment method'),
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => paymentMethodApi.update(id, { isActive }),
    onSuccess: (method: CustomPaymentMethod) => {
      if (!method.isActive) onChange(enabled.filter((key) => key !== method.key));
      refresh();
    },
    onError: (err) => fail(err, 'Could not change that payment method'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => paymentMethodApi.remove(id),
    onSuccess: () => {
      toast.success('Payment method removed');
      refresh();
    },
    onError: (err) => fail(err, 'Could not remove that payment method'),
  });

  const rows: TenderRow[] = tenders ?? [];
  const custom = rows.filter((tender) => !tender.isBuiltIn);
  const toggle = (key: string, on: boolean) => onChange(on ? [...enabled, key] : enabled.filter((entry) => entry !== key));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Payment methods</CardTitle>
        <CardDescription>Which tenders this branch offers at checkout, and what they are called here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {rows
            .filter((tender) => tender.isActive !== false)
            .map((tender) => {
              const on = enabled.includes(tender.key);
              return (
                <div key={tender.key} className="flex items-center justify-between rounded-md border p-3">
                  <Label>{tender.label}</Label>
                  <Switch
                    checked={on}
                    // A branch has to take something; the last one cannot be switched off.
                    disabled={readOnly || (on && enabled.length === 1)}
                    onCheckedChange={(checked: boolean) => toggle(tender.key, checked)}
                  />
                </div>
              );
            })}
        </div>

        {custom.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your own methods</p>
            {custom.map((tender) => (
              <div key={tender.key} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {tender.label} <span className="font-mono text-xs text-muted-foreground">{tender.key}</span>
                </span>
                {tender.isActive === false && <Badge variant="secondary">Off</Badge>}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly || setActive.isPending || !tender._id}
                  onClick={() => tender._id && setActive.mutate({ id: tender._id, isActive: tender.isActive === false })}
                >
                  {tender.isActive === false ? 'Switch on' : 'Switch off'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={readOnly || remove.isPending || !tender._id}
                  onClick={() => tender._id && remove.mutate(tender._id)}
                  aria-label={`Remove ${tender.label}`}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}

        {!readOnly && (
          <form
            className="flex items-end gap-2 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim().length >= 2) create.mutate();
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="tender-label" className="text-xs">
                Add your own
              </Label>
              <Input id="tender-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Meal voucher" maxLength={40} />
            </div>
            <Button type="submit" variant="outline" disabled={label.trim().length < 2} loading={create.isPending}>
              <Plus />
              Add
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
