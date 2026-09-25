import { useAuth } from '@/hooks/useAuth';

/** The POS types whose tills run the loyalty program. Mirrors the server's entitlement. */
const LOYALTY_VERTICALS = ['clothing', 'supershop'];

/** Whether this POS type has a card program at all: navigation and settings ask. */
export const isLoyaltyVertical = (vertical: string | null | undefined) => LOYALTY_VERTICALS.includes(vertical ?? 'clothing');

/**
 * What the loyalty UI may show. For display only: every loyalty API checks the
 * plan entitlement and the permission again on the server.
 */
export function useLoyaltyAccess() {
  const { session, can } = useAuth();
  const vertical = session?.tenant?.vertical ?? 'clothing';
  // The server's entitlement is the gate; this only decides what to render.
  const inPlan = isLoyaltyVertical(vertical) && session?.entitlement?.features?.loyaltyProgram === true;
  return {
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
