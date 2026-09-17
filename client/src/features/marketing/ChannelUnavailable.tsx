import { Link } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Shown in place of a composer when the PLAN does not include a channel.
 *
 * A disabled form tells the reader nothing: they cannot see whether the field
 * is broken, still loading, or something they need to pay for. If a feature is
 * not theirs, say so and show the way to it.
 */
export function ChannelUnavailable({
  channel,
  planName,
}: {
  channel: 'SMS' | 'Email';
  planName: string | null;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Lock className="h-5 w-5" />
        </div>
        <div>
          <p className="font-semibold">{channel} marketing is not part of {planName ?? 'your plan'}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Upgrade to Professional or Enterprise to reach your customers by {channel === 'SMS' ? 'SMS' : 'email'}. Messages
            are charged per send from your wallet, so you only pay for what you use.
          </p>
        </div>
        <Button asChild>
          <Link to="/subscription">
            See plans
            <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
