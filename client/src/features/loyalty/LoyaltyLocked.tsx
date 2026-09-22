import { Link } from 'react-router-dom';
import { Gift, Lock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';

/** Shown in place of loyalty screens on plans without the loyalty program. No loyalty request is made. */
export function LoyaltyLocked({ compact = false }: { compact?: boolean }) {
  const { can } = useAuth();
  return (
    <Card className={compact ? '' : 'mx-auto max-w-xl'}>
      <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
        <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Gift className="h-6 w-6" />
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background">
            <Lock className="h-3 w-3" />
          </span>
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Loyalty Program</h2>
          <p className="text-sm text-muted-foreground">
            Available with Professional and Enterprise plans: membership cards with barcodes, points on every purchase, and points as a discount.
          </p>
        </div>
        {can('subscription.view') ? (
          <Button asChild>
            <Link to="/subscription">
              <Sparkles />
              Upgrade
            </Link>
          </Button>
        ) : (
          <p className="text-sm font-medium">Ask your store owner to upgrade the subscription.</p>
        )}
      </CardContent>
    </Card>
  );
}
