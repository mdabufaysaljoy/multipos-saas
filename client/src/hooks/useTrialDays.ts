import { useQuery } from '@tanstack/react-query';
import { billingApi } from '@/api/endpoints';

/**
 * How long the free trial lasts, read from the plans the server publishes.
 *
 * Marketing copy must never hardcode this: the trial length is a platform
 * setting a admin can change at runtime, and a printed "7 days" that disagrees
 * with what signup actually grants is worse than no number at all.
 *
 * Shares the `['public','plans']` cache with the pricing page, so quoting the
 * number costs no extra request.
 */
export function useTrialDays(): number | null {
  return useTrialOffer().days;
}

/**
 * The plan the free trial runs on, and how long it lasts.
 *
 * `trialDays > 0` is exactly the rule the server uses to decide eligibility
 * (see `findTrialPlan`), so the marketing copy cannot promise a trial on a plan
 * signup would not actually grant.
 */
export function useTrialOffer(): { days: number | null; planName: string | null } {
  const { data } = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: billingApi.plans,
    staleTime: 5 * 60 * 1000,
  });

  const eligible = (data ?? []).filter((plan) => plan.trialDays > 0).sort((a, b) => a.tier - b.tier);
  const plan = eligible[0];
  if (!plan) return { days: null, planName: null };

  return { days: plan.trialDays, planName: plan.name.replace(/ Annual$/, '') };
}
