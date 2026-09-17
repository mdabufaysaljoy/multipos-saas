import type { ClientSession, Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { AccountModel } from '../../models/Account';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';

/**
 * Returns the account owned by `ownerUserId`, creating it on first use.
 *
 * The owner comes from the server (the user being registered, or the tenant's
 * stored owner) - never from a request body - so a caller cannot attach a
 * workspace to someone else's account.
 *
 * Atomic upsert on the unique `ownerUserId` index. If two calls race, one
 * insert loses with a duplicate-key error and simply reads the winner's row.
 */
export async function ensureAccountForOwner(
  ownerUserId: Types.ObjectId,
  details: { name: string; contactEmail?: string; contactPhone?: string; country?: string },
  session?: ClientSession,
): Promise<Types.ObjectId> {
  try {
    const account = await AccountModel.findOneAndUpdate(
      { ownerUserId },
      {
        $setOnInsert: {
          name: details.name,
          contactEmail: details.contactEmail ?? '',
          contactPhone: details.contactPhone ?? '',
          country: details.country || 'BD',
          status: 'active',
        },
      },
      { upsert: true, new: true, session },
    )
      .select('_id')
      .lean();
    return account!._id;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await AccountModel.findOne({ ownerUserId })
      .select('_id')
      .session(session ?? null)
      .lean();
    if (!existing) throw error;
    return existing._id;
  }
}

/**
 * The account the AUTHENTICATED user owns, or a 403.
 *
 * The only way the API learns "which account is this?": derived from the
 * signed-in user id, never from a body, query, header or token claim. Only a
 * workspace administrator can own an account; staff and platform admins cannot.
 *
 * An owner whose home workspace predates the account backfill is linked here on
 * first use (the same rule the `migrate:accounts` backfill applies).
 */
export async function accountForUser(userId: Types.ObjectId, refusal = 'Only the account owner can do this') {
  const user = await UserModel.findOne({ _id: userId, deletedAt: null })
    .select('_id role tenantId name email isActive')
    .lean();
  if (!user || !user.isActive) throw ApiError.unauthorized();

  const refuse = () => ApiError.forbidden(refusal);
  if (user.role !== ROLES.ADMIN || !user.tenantId) throw refuse();

  let account = await AccountModel.findOne({ ownerUserId: user._id }).lean();
  if (!account) {
    const home = await TenantModel.findById(user.tenantId)
      .select('_id name ownerUserId accountId contactEmail contactPhone country')
      .lean();
    // Only the workspace's recorded owner, and only while it is still unlinked.
    if (!home || !home.ownerUserId.equals(user._id) || home.accountId) throw refuse();
    const accountId = await ensureAccountForOwner(user._id, {
      name: home.name,
      contactEmail: home.contactEmail,
      contactPhone: home.contactPhone,
      country: home.country,
    });
    await TenantModel.updateOne({ _id: home._id, accountId: null }, { $set: { accountId } });
    account = await AccountModel.findById(accountId).lean();
  }
  if (!account) throw refuse();
  return { user, account };
}

/**
 * Whether a user owns a customer account - or will on first use: the recorded
 * owner of a home workspace not yet linked to an account (see `accountForUser`).
 * Drives what the client shows; every account route still checks for itself.
 */
export async function ownsAccount(user: { _id: Types.ObjectId; role: string; tenantId?: Types.ObjectId | null; isActive?: boolean }) {
  if (!user.isActive || user.role !== ROLES.ADMIN || !user.tenantId) return false;
  if (await AccountModel.exists({ ownerUserId: user._id })) return true;
  const home = await TenantModel.findById(user.tenantId).select('ownerUserId accountId').lean();
  return Boolean(home && home.ownerUserId.equals(user._id) && !home.accountId);
}
