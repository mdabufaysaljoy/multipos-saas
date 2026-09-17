import type { Types } from 'mongoose';
import { PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { PaymentModel } from '../../models/Payment';
import { PosProductModel } from '../../models/PosProduct';
import { SubscriptionModel } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { ApiError } from '../../utils/ApiError';

/** Subscriptions that still give a workspace access (a cancelled one runs to its period end). */
const RUNNING_STATUSES = [
  SUBSCRIPTION_STATUS.TRIAL,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.CANCELLED,
];

export interface PlanScopeInput {
  posProductCode: string | null;
  verticalOverrides: { vertical: string }[];
}

/**
 * The rules for which POS type a plan is sold to, checked on every plan create
 * and update by a platform admin:
 *
 *   - the POS type must exist in the platform POS catalog (it may be inactive,
 *     so pricing can be prepared before a POS type launches);
 *   - a POS-specific plan may only carry per-vertical settings for its own type;
 *   - a plan cannot be narrowed to a POS type while a workspace of ANOTHER type
 *     is running on it, or is paying for it (pending payment or upgrade
 *     request). Otherwise that customer could not renew or finish paying.
 *     Widening a plan to every POS type (`null`) is always allowed.
 */
export async function assertPlanScope(
  next: PlanScopeInput,
  existing?: { _id: Types.ObjectId; posProductCode?: string | null },
): Promise<void> {
  const code = next.posProductCode ?? null;

  if (code) {
    if (!(await PosProductModel.exists({ code }))) {
      throw ApiError.validation('Unknown POS type', { posProductCode: code });
    }
    const foreign = next.verticalOverrides.map((entry) => entry.vertical).filter((vertical) => vertical !== code);
    if (foreign.length > 0) {
      throw ApiError.validation(`A plan sold to ${code} can only carry settings for ${code}`, { verticals: foreign });
    }
  }

  if (!existing || !code || (existing.posProductCode ?? null) === code) return;

  const planId = existing._id;
  const [running, paying, requesting] = await Promise.all([
    SubscriptionModel.distinct('tenantId', { planId, status: { $in: RUNNING_STATUSES } }),
    PaymentModel.distinct('tenantId', { planId, status: PAYMENT_STATUS.PENDING }),
    UpgradeRequestModel.distinct('tenantId', { planId, status: 'pending' }),
  ]);
  const tenantIds = [...running, ...paying, ...requesting];
  if (tenantIds.length === 0) return;

  // Workspaces with no POS type stored predate verticals and are Clothing.
  const ofAnotherType =
    code === DEFAULT_POS_VERTICAL ? { vertical: { $nin: [code, null] } } : { vertical: { $ne: code } };
  const affected = await TenantModel.countDocuments({ _id: { $in: tenantIds }, ...ofAnotherType });
  if (affected > 0) {
    throw ApiError.conflict(
      `This plan is in use by ${affected} workspace(s) of another POS type, so it cannot be limited to ${code}. Create a separate plan instead.`,
      { affectedWorkspaces: affected, posProductCode: code },
    );
  }
}
