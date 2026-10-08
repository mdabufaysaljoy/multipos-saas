import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, CreditCard, HandCoins, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';
import { cn } from '@/lib/utils';

/**
 * How customers are allowed to pay.
 *
 * Two independent switches, because they answer different questions. ZiniPay
 * verifies a payment with the gateway and credits the wallet or opens the
 * subscription immediately. Manual transfers need a platform admin to confirm
 * each one by hand, which is the right fallback when a gateway is down and the
 * wrong thing to leave visible when one is working.
 *
 * The API key is write-only: the server returns whether one is stored, never
 * the key. Leaving the box empty keeps the stored key, exactly as the SMTP
 * password and SMS key already behave - otherwise re-saving this form to flip
 * a switch would wipe the credentials.
 */
export function PaymentGatewayCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['platform', 'integrations'], queryFn: platformApi.integrations });

  const [manualEnabled, setManualEnabled] = React.useState(true);
  const [zini, setZini] = React.useState({ apiKey: '', baseUrl: '', enabled: false });

  React.useEffect(() => {
    if (!data?.payments) return;
    const payments = data.payments as {
      manualEnabled?: boolean;
      zinipay?: { baseUrl?: string; enabled?: boolean; apiKeySet?: boolean; fromEnvironment?: boolean };
    };
    setManualEnabled(payments.manualEnabled !== false);
    setZini({
      // Never populated from the server - the key is write-only.
      apiKey: '',
      baseUrl: payments.zinipay?.baseUrl ?? 'https://api.zinipay.com',
      enabled: Boolean(payments.zinipay?.enabled),
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      platformApi.updateSettings({
        payments: {
          manualEnabled,
          zinipay: {
            // An empty box means "leave the stored key alone", not "delete it".
            ...(zini.apiKey.trim() ? { apiKey: zini.apiKey.trim() } : {}),
            baseUrl: zini.baseUrl.trim() || 'https://api.zinipay.com',
            enabled: zini.enabled,
          },
        },
      }),
    onSuccess: () => {
      toast.success('Payment settings saved');
      setZini((current) => ({ ...current, apiKey: '' }));
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save'),
  });

  if (isLoading || !data) return <LoadingState label="Loading payment settings…" />;

  const zinipay = (data.payments as { zinipay?: { apiKeySet?: boolean; fromEnvironment?: boolean } } | undefined)?.zinipay;
  const keyStored = Boolean(zinipay?.apiKeySet);
  const fromEnv = Boolean(zinipay?.fromEnvironment);
  // Switching the gateway on without a key would show customers an option that
  // cannot open a checkout, so the switch stays locked until there is one.
  const canEnableZini = keyStored || zini.apiKey.trim().length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            ZiniPay
          </CardTitle>
          <CardDescription>
            Customers pay on ZiniPay's page and come straight back. The payment is confirmed with ZiniPay, so the wallet
            is credited and a subscription opens immediately — nobody has to approve it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label
            className={cn(
              'flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3',
              zini.enabled ? 'border-primary/40 bg-primary/5' : 'border-border',
            )}
          >
            <span className="text-sm">
              <span className="font-medium">Accept payments through ZiniPay</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {canEnableZini
                  ? 'Offered on wallet top-ups and subscription purchases.'
                  : 'Add an API key first — without one the option cannot open a checkout.'}
              </span>
            </span>
            <Switch
              checked={zini.enabled}
              disabled={!canEnableZini}
              onCheckedChange={(checked) => setZini((current) => ({ ...current, enabled: checked }))}
            />
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="zini-key" className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              API key
            </Label>
            <Input
              id="zini-key"
              type="password"
              autoComplete="off"
              value={zini.apiKey}
              placeholder={keyStored ? 'A key is saved — type a new one to replace it' : 'Paste your ZiniPay API key'}
              onChange={(event) => setZini((current) => ({ ...current, apiKey: event.target.value }))}
            />
            {keyStored ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {fromEnvironment(fromEnv)}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Dashboard → Menu → Brands → Brand Key.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="zini-base">API address</Label>
            <Input
              id="zini-base"
              value={zini.baseUrl}
              placeholder="https://api.zinipay.com"
              onChange={(event) => setZini((current) => ({ ...current, baseUrl: event.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Leave as it is unless ZiniPay tells you otherwise.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="h-4 w-4" />
            Manual transfers
          </CardTitle>
          <CardDescription>
            The customer sends money to your bKash, Nagad or bank account and you confirm it by hand. Slower, and it
            needs somebody watching — useful as a fallback, worth switching off once a gateway is live.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label
            className={cn(
              'flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3',
              manualEnabled ? 'border-border' : 'border-amber-500/40 bg-amber-500/5',
            )}
          >
            <span className="text-sm">
              <span className="font-medium">Offer manual transfers</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {manualEnabled
                  ? 'Customers can send money and wait for someone to confirm it.'
                  : 'Hidden from customers. Anyone mid-transfer should still be confirmed as usual.'}
              </span>
            </span>
            <Switch checked={manualEnabled} onCheckedChange={setManualEnabled} />
          </label>

          {!manualEnabled && !zini.enabled && (
            // Saving this leaves customers no way to pay at all, which is worth
            // saying out loud rather than discovering from a support ticket.
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
              Both ways of paying are switched off. Customers will not be able to top up their wallet or buy a
              subscription until you turn one back on.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save payment settings
        </Button>
      </div>
    </div>
  );
}

/** Says where the working key came from, because "it works but I never typed one" is confusing. */
function fromEnvironment(fromEnv: boolean): string {
  return fromEnv
    ? 'Using the key from this server’s environment. Saving one here replaces it.'
    : 'A key is saved. The box stays empty so saving this form cannot wipe it.';
}
