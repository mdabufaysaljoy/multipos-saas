import { Gift, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/money';
import type { LoyaltyLookup } from '@/types/domain';

interface LoyaltyStripProps {
  member: LoyaltyLookup;
  currency: string;
  canRedeem: boolean;
  redeemPoints: number | null;
  maxRedeemable: number;
  pointsToEarn: number;
  onRedeemChange: (points: number | null) => void;
  onRemove: () => void;
}

/**
 * The scanned member, compact enough for a 13-inch till: who, which card, the
 * balance and its value, plus an explicit "points to redeem" field. Nothing is
 * redeemed unless the cashier enters it; the server checks it again.
 */
export function LoyaltyStrip({ member, currency, canRedeem, redeemPoints, maxRedeemable, pointsToEarn, onRedeemChange, onRemove }: LoyaltyStripProps) {
  const tooMany = (redeemPoints ?? 0) > maxRedeemable;
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <Gift className="h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {member.customer?.name ?? 'Loyalty member'} <span className="font-normal text-muted-foreground">· {member.cardNumber}</span>
          </p>
          <p className="truncate text-muted-foreground">
            {member.customer?.phone}
            {member.customer?.email ? ` · ${member.customer.email}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular font-semibold">{member.pointsBalance.toLocaleString()} pts</p>
          <p className="tabular text-muted-foreground">{formatMoney(member.valueMinor, currency)}</p>
        </div>
        <Button variant="ghost" size="icon-sm" className="-mr-1 shrink-0" onClick={onRemove} aria-label="Remove loyalty card">
          <X />
        </Button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {canRedeem ? (
          <>
            <label htmlFor="pos-redeem-points" className="text-muted-foreground">
              Redeem
            </label>
            <Input
              id="pos-redeem-points"
              inputMode="numeric"
              className="tabular h-7 w-20 px-2 text-right text-xs"
              value={redeemPoints ?? ''}
              placeholder="0"
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (raw === '') return onRedeemChange(null);
                if (/^\d{1,9}$/.test(raw)) onRedeemChange(Number(raw));
              }}
              aria-label="Points to redeem"
            />
            <span className="text-muted-foreground">pts</span>
            <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={maxRedeemable === 0} onClick={() => onRedeemChange(maxRedeemable)}>
              Max {maxRedeemable}
            </Button>
            {(redeemPoints ?? 0) > 0 && !tooMany && (
              <span className="tabular font-medium text-success">-{formatMoney((redeemPoints ?? 0) * member.pointValueMinor, currency)}</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">You cannot redeem points.</span>
        )}
        {pointsToEarn > 0 && <span className="ml-auto text-muted-foreground">Earns {pointsToEarn} pts</span>}
      </div>
      {tooMany && <p className="mt-0.5 font-medium text-destructive">At most {maxRedeemable} points can be used on this sale.</p>}
    </div>
  );
}
