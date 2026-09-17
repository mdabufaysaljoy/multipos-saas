import type { ClientSession, Types } from 'mongoose';
import { SubscriptionModel } from '../../models/Subscription';
import { ApiError } from '../../utils/ApiError';

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

/**
 * Makes a subscription its workspace's ONE primary subscription.
 *
 * A unique partial index (`tenantId` where `isPrimary`) guarantees a workspace
 * never has two. The newest subscription always wins: older primaries are
 * demoted first, and if a NEWER subscription was promoted concurrently this
 * one gives way. Returns false when it lost to a newer one.
 *
 * Inside a transaction a duplicate key aborts the transaction, so there is no
 * retry: the error propagates and the whole transaction is rolled back.
 */
export async function promoteToPrimary(
  tenantId: Types.ObjectId,
  subscriptionId: Types.ObjectId,
  session?: ClientSession | null,
): Promise<boolean> {
  const attempts = session ? 1 : 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await SubscriptionModel.updateMany(
      { tenantId, isPrimary: true, _id: { $lt: subscriptionId } },
      { $set: { isPrimary: false } },
      { timestamps: false, session: session ?? undefined },
    );
    try {
      await SubscriptionModel.updateOne(
        { _id: subscriptionId, tenantId },
        { $set: { isPrimary: true } },
        { timestamps: false, session: session ?? undefined },
      );
      return true;
    } catch (error) {
      if (session || !isDuplicateKey(error)) throw error;
      // Someone else holds the slot. A newer subscription keeps it; an older one is demoted on the next pass.
      if (await SubscriptionModel.exists({ tenantId, isPrimary: true, _id: { $gt: subscriptionId } })) return false;
    }
  }
  throw ApiError.conflict('Another subscription change for this workspace was in progress. Please try again.');
}
