import type { Types } from 'mongoose';
import { PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { PRIMARY_FIRST, SubscriptionModel } from '../../models/Subscription';

const MINUTE_MS = 60_000;

/** Statuses whose paid period still has value. A trial never does. */
const PAID_RUNNING = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAST_DUE] as string[];

export interface ProrationCredit {
  subscriptionId: Types.ObjectId;
  planCode: string;
  /** What the current period was worth: amount paid plus credit rolled into it, less refunds. */
  paidMinor: number;
  periodMinutes: number;
  remainingMinutes: number;
  creditMinor: number;
}

/**
 * The unused part of a paid period, in whole minutes and integer minor units:
 *   credit = floor(paid × remainingMinutes ÷ periodMinutes)
 * Deterministic and never more than what was paid. A period that has not
 * started yet (renewed early) is fully unused; one that has ended is worth 0.
 * Products stay far inside safe-integer range (paid ≤ 1e9, minutes ≤ 527 040).
 */
export function prorate(paidMinor: number, periodStart: Date, periodEnd: Date, now: Date) {
  const periodMinutes = Math.max(1, Math.floor((periodEnd.getTime() - periodStart.getTime()) / MINUTE_MS));
  const remainingMinutes = Math.min(
    periodMinutes,
    Math.max(0, Math.floor((periodEnd.getTime() - Math.max(now.getTime(), periodStart.getTime())) / MINUTE_MS)),
  );
  return { periodMinutes, remainingMinutes, creditMinor: Math.floor((paidMinor * remainingMinutes) / periodMinutes) };
}

/**
 * Credit for the time left on the workspace's current PAID period, when it
 * moves to another plan before the period ends. Nothing for trials, periods a
 * platform admin granted without a recorded payment, refunded payments, or a
 * period that is over.
 */
export async function prorationFor(tenantId: Types.ObjectId, now = new Date()): Promise<ProrationCredit | null> {
  const live = await SubscriptionModel.findOne({ tenantId }).sort(PRIMARY_FIRST).lean();
  if (!live || !PAID_RUNNING.includes(live.status) || live.trialEndsAt || !live.lastPaymentId) return null;
  if (live.currentPeriodEnd.getTime() <= now.getTime()) return null;

  const payment = await PaymentModel.findOne({ _id: live.lastPaymentId, tenantId, status: PAYMENT_STATUS.PAID })
    .select('amountMinor refundedMinor metadata')
    .lean();
  if (!payment) return null;

  const rolledCredit = Number((payment.metadata as { prorationCreditAppliedMinor?: unknown } | undefined)?.prorationCreditAppliedMinor ?? 0);
  const worth = payment.amountMinor + (Number.isSafeInteger(rolledCredit) && rolledCredit > 0 ? rolledCredit : 0) - (payment.refundedMinor ?? 0);
  const paidMinor = Math.max(0, Math.min(worth, live.planSnapshot?.priceMinor ?? worth));
  if (paidMinor <= 0) return null;

  const math = prorate(paidMinor, live.currentPeriodStart, live.currentPeriodEnd, now);
  if (math.creditMinor <= 0) return null;
  return { subscriptionId: live._id, planCode: live.planSnapshot?.code ?? '', paidMinor, ...math };
}
