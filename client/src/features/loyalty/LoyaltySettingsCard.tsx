import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { storeApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MoneyInput } from '@/components/MoneyInput';
import { formatMoney } from '@/lib/money';
import type { LoyaltySettings } from '@/types/domain';
import { LoyaltyLocked } from './LoyaltyLocked';
import { useLoyaltyAccess } from './useLoyaltyAccess';

const DEFAULTS: LoyaltySettings = { enabled: false, earnSpendMinor: 10_000, pointValueMinor: 100, membershipFeeMinor: 0 };

/**
 * Loyalty rules for this branch. Saved on its own, so a plan without loyalty
 * never blocks saving the rest of the settings. The server validates every value.
 */
export function LoyaltySettingsCard({ value, currency, readOnly }: { value: LoyaltySettings | undefined; currency: string; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { inPlan } = useLoyaltyAccess();
  const [draft, setDraft] = React.useState<{ enabled: boolean; earnSpendMinor: number | null; pointValueMinor: number | null; membershipFeeMinor: number | null }>({
    ...DEFAULTS,
    ...value,
  });
  React.useEffect(() => setDraft({ ...DEFAULTS, ...value }), [value]);

  const earn = draft.earnSpendMinor;
  const point = draft.pointValueMinor;
  const issues = [
    earn === null || earn < 100 ? 'Spend per point must be at least ৳1.' : null,
    point === null || point < 1 ? 'Point value must be more than ৳0.' : null,
    draft.membershipFeeMinor === null ? 'Enter a membership fee (0 for free cards).' : null,
  ].filter(Boolean) as string[];

  const save = useMutation({
    mutationFn: () =>
      storeApi.updateCurrent({
        loyalty: { enabled: draft.enabled, earnSpendMinor: earn, pointValueMinor: point, membershipFeeMinor: draft.membershipFeeMinor },
      }),
    onSuccess: () => {
      toast.success('Loyalty settings saved');
      void queryClient.invalidateQueries({ queryKey: ['store'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save loyalty settings'),
  });

  if (!inPlan) return <LoyaltyLocked compact />;

  return (
    <Card className="max-w-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Loyalty Program</CardTitle>
        <CardDescription>Customers earn points only with a membership card scanned at the till - never by phone number.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label>Enable loyalty program</Label>
            <p className="text-xs text-muted-foreground">Issue cards, earn and redeem points in this branch.</p>
          </div>
          <Switch checked={draft.enabled} disabled={readOnly} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Spend that earns 1 point</Label>
            <MoneyInput value={earn} onChange={(v) => setDraft({ ...draft, earnSpendMinor: v })} ariaLabel="Spend per point" className={readOnly ? 'pointer-events-none opacity-60' : ''} />
            <p className="text-xs text-muted-foreground">Default ৳100 = 1 point. VAT added on top never earns points.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Value of 1 point</Label>
            <MoneyInput value={point} onChange={(v) => setDraft({ ...draft, pointValueMinor: v })} ariaLabel="Point value" className={readOnly ? 'pointer-events-none opacity-60' : ''} />
            <p className="text-xs text-muted-foreground">Default 1 point = ৳1 of discount.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Membership card fee</Label>
            <MoneyInput value={draft.membershipFeeMinor} onChange={(v) => setDraft({ ...draft, membershipFeeMinor: v })} ariaLabel="Membership fee" className={readOnly ? 'pointer-events-none opacity-60' : ''} />
            <p className="text-xs text-muted-foreground">0 issues cards free. The fee is taken when the card is issued.</p>
          </div>
        </div>

        {issues.length === 0 && earn !== null && point !== null && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
            Example: a {formatMoney(earn * 10, currency)} purchase earns 10 points, worth {formatMoney(point * 10, currency)} off a later purchase.
          </p>
        )}
        {issues.length > 0 && <p className="text-xs font-medium text-destructive">{issues[0]}</p>}

        {!readOnly && (
          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={issues.length > 0} loading={save.isPending}>
              <Save />
              Save loyalty settings
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
