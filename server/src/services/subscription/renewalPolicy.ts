/**
 * Renewal and plan-change timing rules, in one place.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The same plan can be renewed (continuing from the period end) this close to the end. */
export const RENEWAL_WINDOW_MS = 7 * DAY_MS;
/** Automatic wallet renewal keeps trying this long after the period ended. */
export const RENEWAL_GRACE_MS = 3 * DAY_MS;
/** At most one automatic attempt per subscription in this long. */
export const RENEWAL_RETRY_MS = 20 * HOUR_MS;
/** After this many failed automatic attempts the subscription ends and auto-renewal switches off. */
export const RENEWAL_MAX_ATTEMPTS = 3;
/** A renewal later than this after the period end starts a fresh period now instead of back-dating it. */
export const LATE_RENEWAL_RESTART_MS = HOUR_MS;
/** The owner is warned this long before an automatic renewal the wallet cannot cover. */
export const RENEWAL_REMINDER_LEAD_MS = 3 * DAY_MS;

export const isWithinRenewalWindow = (periodEnd: Date, now = new Date()) =>
  periodEnd.getTime() > now.getTime() && periodEnd.getTime() - now.getTime() <= RENEWAL_WINDOW_MS;

export interface GraceCandidate {
  status: string;
  autoRenew: boolean;
  renewWith?: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt?: Date | null;
  failedPaymentCount?: number;
  currentPeriodEnd: Date;
}

/**
 * The grace period: a PAID subscription set to renew automatically from the
 * wallet keeps working for RENEWAL_GRACE_MS after its period ends while renewal
 * is still being attempted. Never for a trial, a cancelled subscription, one
 * whose automatic renewal is off or has failed for the last time, or one that
 * nothing can charge automatically.
 *
 * Returns when the grace ends, or null when there is none.
 */
export function renewalGraceEndsAt(subscription: GraceCandidate, now = new Date()): Date | null {
  const end = subscription.currentPeriodEnd.getTime();
  if (end > now.getTime()) return null;
  const eligible =
    (subscription.status === 'active' || subscription.status === 'past_due') &&
    subscription.autoRenew &&
    subscription.renewWith === 'wallet' &&
    !subscription.cancelAtPeriodEnd &&
    !subscription.trialEndsAt &&
    (subscription.failedPaymentCount ?? 0) < RENEWAL_MAX_ATTEMPTS;
  if (!eligible || now.getTime() >= end + RENEWAL_GRACE_MS) return null;
  return new Date(end + RENEWAL_GRACE_MS);
}
