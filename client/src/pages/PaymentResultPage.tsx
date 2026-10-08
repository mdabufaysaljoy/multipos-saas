import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError } from '@/api/client';
import { billingApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Where a gateway sends the customer back to.
 *
 * A hosted checkout chooses between exactly two URLs and knows nothing else,
 * so which one it picked is only ever a HINT - and a URL anybody can type.
 * It decides nothing here. The page asks the server to confirm the payment,
 * the server asks the gateway, and what comes back is what is shown. Someone
 * opening /payment/success by hand therefore sees the truth about their
 * payment, not a success message.
 *
 * `outcome=pending` and `outcome=failed` come from our own callback, which has
 * already confirmed the payment; they only make the first paint honest while
 * the confirmation below repeats it.
 */

type Outcome = 'checking' | 'paid' | 'pending' | 'failed' | 'cancelled';

const COPY: Record<Exclude<Outcome, 'checking'>, { title: string; body: string }> = {
  paid: { title: 'Payment confirmed', body: 'Thank you. Your payment went through.' },
  pending: {
    title: 'Payment not confirmed yet',
    body: 'The gateway has not confirmed this payment. If money left your account it will be applied automatically, usually within a few minutes.',
  },
  failed: { title: 'Payment was not accepted', body: 'Nothing was charged. You can try again, or use another way to pay.' },
  cancelled: { title: 'Payment cancelled', body: 'You cancelled before paying, so nothing was charged.' },
};

/** The success URL a gateway is given. */
export function PaymentResultPage() {
  return <PaymentResult cancelled={false} />;
}

/** The cancel URL, which a gateway also uses when a payment fails. */
export function PaymentCancelPage() {
  return <PaymentResult cancelled />;
}

function PaymentResult({ cancelled }: { cancelled: boolean }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const reference = params.get('ref');

  const [outcome, setOutcome] = React.useState<Outcome>(reference ? 'checking' : cancelled ? 'cancelled' : 'pending');
  const [amount, setAmount] = React.useState<{ minor: number; currency: string } | null>(null);
  const [purpose, setPurpose] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const asked = React.useRef(false);

  React.useEffect(() => {
    if (!reference || asked.current) return;
    asked.current = true;

    void billingApi
      .confirmPayment(reference)
      .then((payment) => {
        setPurpose(payment.purpose);
        if (payment.amountMinor !== null) setAmount({ minor: payment.amountMinor, currency: payment.currency ?? 'BDT' });
        if (payment.status === 'paid') {
          setOutcome('paid');
          // The plan or the balance has changed, so nothing cached survives.
          void queryClient.invalidateQueries();
          void refresh();
          return;
        }
        // A cancelled checkout that really is unpaid should say so plainly
        // rather than leaving someone waiting for a payment they never made.
        setOutcome(payment.status === 'pending' ? (cancelled ? 'cancelled' : 'pending') : 'failed');
      })
      .catch((error) => {
        setProblem(error instanceof ApiError ? error.message : 'We could not reach the server to confirm this payment.');
        setOutcome(cancelled ? 'cancelled' : 'pending');
      });
  }, [reference, cancelled, queryClient, refresh]);

  const isWallet = purpose === 'wallet_topup';
  const backTo = isWallet ? '/wallet' : '/subscription';
  const backLabel = isWallet ? 'Go to your wallet' : 'Go to your subscription';

  if (outcome === 'checking') {
    return (
      <Shell>
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        <h1 className="text-xl font-semibold">Confirming your payment…</h1>
        <p className="text-sm text-muted-foreground">Checking with the payment gateway. This only takes a moment.</p>
      </Shell>
    );
  }

  const copy = COPY[outcome];
  const tone =
    outcome === 'paid'
      ? { ring: 'bg-success/12 text-success', Icon: CheckCircle2 }
      : outcome === 'failed'
        ? { ring: 'bg-destructive/12 text-destructive', Icon: XCircle }
        : { ring: 'bg-warning/12 text-warning', Icon: Clock };

  return (
    <Shell>
      <span className={cn('flex h-14 w-14 items-center justify-center rounded-full', tone.ring)}>
        <tone.Icon className="h-7 w-7" />
      </span>
      <h1 className="text-xl font-semibold">{copy.title}</h1>

      {amount && outcome === 'paid' && (
        <p className="tabular text-3xl font-bold">{formatMoney(amount.minor, amount.currency)}</p>
      )}
      <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>

      {outcome === 'paid' && (
        <p className="text-sm text-muted-foreground">
          {isWallet ? 'It has been added to your wallet balance.' : 'Your plan is active.'}
        </p>
      )}

      {problem && <p className="max-w-sm text-xs text-muted-foreground">{problem}</p>}

      <div className="flex w-full flex-col gap-2 pt-2 sm:w-auto sm:flex-row">
        {outcome !== 'paid' && (
          <Button variant="outline" onClick={() => navigate(backTo)}>
            Try again
          </Button>
        )}
        <Button asChild>
          <Link to={backTo}>
            {backLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">{children}</CardContent>
      </Card>
    </div>
  );
}
