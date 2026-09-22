import { useAuth } from '@/hooks/useAuth';

/**
 * What the loyalty UI may show. For display only: every loyalty API checks the
 * plan entitlement and the permission again on the server.
 */
export function useLoyaltyAccess() {
  const { session, can } = useAuth();
  const isClothing = (session?.tenant?.vertical ?? 'clothing') === 'clothing';
  const inPlan = isClothing && session?.entitlement?.features?.loyaltyProgram === true;
  return {
    isClothing,
    inPlan,
    canView: inPlan && can('loyalty.view'),
    canManage: inPlan && can('loyalty.manage'),
    canRedeem: inPlan && can('loyalty.redeem'),
  };
}

/** A fresh request key: a retried request with the same key never repeats its effect. */
export const newRequestKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const LOYALTY_TX_LABELS: Record<string, string> = {
  earn: 'Earned',
  redeem: 'Redeemed',
  redeem_reversed: 'Redemption undone',
  earn_reversed: 'Earned points returned',
  redeem_restored: 'Redeemed points given back',
  adjustment: 'Manual adjustment',
};
