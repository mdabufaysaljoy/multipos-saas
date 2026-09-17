/**
 * Introduces workspace-level subscription fields and the one-primary rule.
 *
 *   - Every subscription gets `accountId` (from its workspace), `posProductCode`
 *     and `posProductId` (snapshot vertical, else the workspace's POS type),
 *     `billingCycle`, `priceMinor` and `currency` (from its frozen plan snapshot,
 *     so historical prices are copied, never recalculated) and `trialStartAt`
 *     for trials. Only missing values are filled; `updatedAt` is not touched.
 *   - Each workspace with no primary subscription gets its most recent one
 *     marked primary. Older records stay exactly as they are - nothing is deleted.
 *   - Workspaces with more than one subscription still running are REPORTED,
 *     not changed.
 *   - Finally the unique "one primary per workspace" index is built.
 *
 * Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:workspace-subscriptions -w server
 */
import mongoose, { type Types } from 'mongoose';
import { env } from '../config/env';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { SUBSCRIPTION_STATUS } from '../config/constants';
import { logger } from '../utils/logger';
import { PosProductModel } from '../models/PosProduct';
import { SubscriptionModel } from '../models/Subscription';
import { TenantModel } from '../models/Tenant';

const CLOSED = [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELLED];

export async function backfillWorkspaceSubscriptions(): Promise<{
  workspaces: number;
  subscriptionsUpdated: number;
  primariesAssigned: number;
  workspacesWithSeveralLive: number;
}> {
  const products = await PosProductModel.find().select('_id code').lean();
  const tenantIds = (await SubscriptionModel.collection.distinct('tenantId')) as Types.ObjectId[];

  let subscriptionsUpdated = 0;
  let primariesAssigned = 0;
  let workspacesWithSeveralLive = 0;
  const now = new Date();

  for (const tenantId of tenantIds) {
    const workspace = await TenantModel.findById(tenantId).select('accountId vertical').lean();
    const code = { $ifNull: ['$posProductCode', { $ifNull: ['$planSnapshot.vertical', workspace?.vertical ?? DEFAULT_POS_VERTICAL] }] };

    // A pipeline update, so each record is filled from its OWN snapshot.
    const filled = await SubscriptionModel.collection.updateMany({ tenantId }, [
      {
        $set: {
          accountId: { $ifNull: ['$accountId', workspace?.accountId ?? null] },
          posProductCode: code,
          billingCycle: { $ifNull: ['$billingCycle', { $cond: [{ $eq: ['$planSnapshot.interval', 'yearly'] }, 'annual', 'monthly'] }] },
          priceMinor: { $ifNull: ['$priceMinor', { $ifNull: ['$planSnapshot.priceMinor', null] }] },
          currency: { $ifNull: ['$currency', { $ifNull: ['$planSnapshot.currency', null] }] },
          trialStartAt: { $ifNull: ['$trialStartAt', { $cond: [{ $gt: ['$trialEndsAt', null] }, '$currentPeriodStart', null] }] },
          isPrimary: { $ifNull: ['$isPrimary', false] },
        },
      },
      {
        $set: {
          posProductId: {
            $ifNull: [
              '$posProductId',
              { $switch: { branches: products.map((product) => ({ case: { $eq: ['$posProductCode', product.code] }, then: product._id })), default: null } },
            ],
          },
        },
      },
    ]);
    subscriptionsUpdated += filled.modifiedCount;

    if (!(await SubscriptionModel.exists({ tenantId, isPrimary: true }))) {
      const latest = await SubscriptionModel.findOne({ tenantId }).sort({ createdAt: -1, _id: -1 }).select('_id').lean();
      if (latest) {
        await SubscriptionModel.collection.updateOne({ _id: latest._id }, { $set: { isPrimary: true } });
        primariesAssigned += 1;
      }
    }

    const live = await SubscriptionModel.countDocuments({ tenantId, status: { $nin: CLOSED }, currentPeriodEnd: { $gt: now } });
    if (live > 1) {
      workspacesWithSeveralLive += 1;
      logger.warn('Workspace has more than one running subscription; left unchanged for review', { tenantId: String(tenantId), live });
    }
  }

  return { workspaces: tenantIds.length, subscriptionsUpdated, primariesAssigned, workspacesWithSeveralLive };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await backfillWorkspaceSubscriptions();
  // Built only after every workspace has at most one primary.
  await SubscriptionModel.syncIndexes();
  logger.info('Workspace subscription backfill complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillWorkspaceSubscriptions')) {
  main().catch((error) => {
    logger.error('Workspace subscription backfill failed', { error: String(error) });
    process.exit(1);
  });
}
