import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Mail, Smartphone } from 'lucide-react';
import { ApiError } from '@/api/client';
import { verificationApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import type { VerificationStatus } from '@/types/api';

/**
 * Proving one contact detail with a six-digit code.
 *
 * Either channel is enough, so the card offers whichever the account has and
 * stops asking the moment one succeeds. The server sends, checks and rate
 * limits; this only collects the code.
 */
export function VerifyContactCard({ onVerified, className }: { onVerified?: (status: VerificationStatus) => void; className?: string }) {
  const { session, refresh } = useAuth();
  const status = session?.user.verification;

  const [channel, setChannel] = React.useState<'email' | 'phone' | null>(null);
  const [code, setCode] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const send = useMutation({
    mutationFn: (next: 'email' | 'phone') => verificationApi.send(next),
    onSuccess: (result) => {
      setChannel(result.channel);
      setSentTo(result.masked);
      setCooldown(result.resendAfterSeconds);
      setCode('');
      toast.success(`Code sent to ${result.masked}`, {
        // Development servers usually have no SMTP or SMS gateway; the server
        // only returns this outside production.
        description: result.devCode ? `Development code: ${result.devCode}` : 'It expires in 10 minutes.',
        duration: result.devCode ? 30_000 : 5_000,
      });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not send the code'),
  });

  const confirm = useMutation({
    mutationFn: () => verificationApi.confirm(channel as 'email' | 'phone', code.trim()),
    onSuccess: async (result) => {
      toast.success(channel === 'email' ? 'Email address verified' : 'Phone number verified');
      setCode('');
      // The session carries the verification status, so it has to be reloaded.
      await refresh();
      onVerified?.(result);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not verify the code'),
  });

  if (!status) return null;

  if (status.anyVerified) {
    return (
      <div className={cn('flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm', className)}>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <span>
          Verified: {status.email.verified ? status.email.masked : status.phone.masked}
          {status.email.verified && status.phone.verified && ` and ${status.phone.masked}`}
        </span>
      </div>
    );
  }

  const options = [
    { key: 'email' as const, icon: Mail, label: 'Email', value: status.email.masked, available: Boolean(status.email.destination) },
    { key: 'phone' as const, icon: Smartphone, label: 'Phone', value: status.phone.masked, available: Boolean(status.phone.destination) },
  ].filter((option) => option.available);

  return (
    <div className={cn('space-y-4', className)}>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => send.mutate(option.key)}
            disabled={send.isPending || (channel === option.key && cooldown > 0)}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60',
              channel === option.key && 'border-primary',
            )}
          >
            <option.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{option.value}</span>
            </span>
            <span className="ml-auto shrink-0 text-xs font-medium text-primary">
              {channel === option.key ? (cooldown > 0 ? `${cooldown}s` : 'Resend') : 'Send code'}
            </span>
          </button>
        ))}
      </div>

      {options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          There is no email address or phone number on this account. Add one in Settings before verifying.
        </p>
      )}

      {channel && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim().length === 6) confirm.mutate();
          }}
        >
          <Label htmlFor="verification-code">Enter the 6-digit code sent to {sentTo}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="verification-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              className="w-40 tracking-[0.4em]"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <Button type="submit" loading={confirm.isPending} disabled={code.trim().length !== 6 || confirm.isPending}>
              Verify
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
