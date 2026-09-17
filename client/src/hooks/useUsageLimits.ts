import { useQuery } from '@tanstack/react-query';
import { billingApi } from '@/api/endpoints';
import { evaluateUsage, usageLimitsFor, type UsageStatus } from '@/lib/usageLimits';
import { useAuth } from '@/hooks/useAuth';
import { formatBytes } from '@/lib/planCatalog';

/**
 * Live usage against plan limits.
 *
 * Reads the same `/subscriptions/current` payload the subscription page uses,
 * so a contextual warning on the products page costs no extra request.
 */
export function useUsageLimits() {
  const { session } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['subscription', 'current'],
    queryFn: billingApi.current,
    staleTime: 30_000,
  });
  const vertical = data?.usage.vertical ?? session?.tenant?.vertical ?? 'clothing';

  const statuses: UsageStatus[] = data
    ? usageLimitsFor(vertical).map((definition) =>
        evaluateUsage(
          definition,
          (data.usage as unknown as Record<string, number>)[definition.usage] ?? 0,
          (data.entitlement.limits as Record<string, number>)[definition.limit] ?? -1,
        ),
      )
    : [];

  // Plans as THIS vertical buys them, so "Professional includes N menu items"
  // quotes the Restaurant allowance, not the Clothing one.
  const { data: plans } = useQuery({
    queryKey: ['plans', 'vertical', vertical],
    queryFn: () => billingApi.plansFor(vertical),
    staleTime: 5 * 60 * 1000,
  });

  /**
   * The cheapest plan that actually offers MORE of this resource.
   *
   * Selected on price and allowance rather than tier. Tier looked obvious, but
   * a workspace on a private plan a platform admin created is not in the public
   * list at all, so its tier reads as 0 and every plan looks like an upgrade -
   * which produced "upgrade to Starter" for a workspace that already had more.
   * "Cheapest way to get more of this" needs no tier and is what the customer
   * is actually asking.
   */
  const nextPlanFor = (status: UsageStatus): { name: string; allowance: string } | null => {
    if (status.unlimited) return null;

    const better = (plans ?? [])
      .filter((plan) => plan.interval === 'monthly' && plan.code !== data?.entitlement.planCode)
      .sort((a, b) => a.priceMinor - b.priceMinor)
      .find((plan) => {
        const value = (plan.limits as Record<string, number>)[status.limit];
        return value === -1 || value > status.max;
      });

    if (!better) return null;
    const value = (better.limits as Record<string, number>)[status.limit];

    return {
      name: better.name.replace(/ Annual$/, ''),
      allowance:
        value === -1
          ? 'unlimited'
          : status.format === 'bytes'
            ? formatBytes(value)
            : value.toLocaleString(),
    };
  };

  return {
    isLoading,
    statuses,
    planName: data?.entitlement.planName ?? null,
    nextPlanFor,
    /** One limit by its `usage` key, e.g. 'products'. */
    forResource: (usageKey: string) => statuses.find((s) => s.usage === usageKey) ?? null,
  };
}
