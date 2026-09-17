import { Types } from 'mongoose';
import { env } from '../../config/env';
import { DEFAULT_POS_VERTICAL, type PosVertical } from '../../config/verticals';
import { posCatalogService } from '../../services/posCatalog/posCatalog.service';
import { AccountModel } from '../../models/Account';
import { RoleModel } from '../../models/Role';
import { SubscriptionModel } from '../../models/Subscription';
import { DEFAULT_WORKSPACE_SETTINGS, TenantModel, type TenantDoc } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { uniqueSlug } from '../../utils/slug';
import { accountForUser } from '../../services/account/account.service';
import { resolvePlanForVertical } from '../../services/subscription/planEntitlements';
import { findTrialPlan, startTrialSubscription } from '../../services/subscription/provisioning.service';
import { TRIAL_LENGTH_DAYS } from '../../services/subscription/trialPolicy';
import { createSystemRoles } from '../roles/roles.defaults';
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspaces.validators';

export type WorkspaceRecord = TenantDoc & { _id: Types.ObjectId };

/**
 * The Workspace view of a tenant. `businessName`/`businessType` are the
 * account-level names for the stored `name`/`vertical`, which stay as they are
 * so every existing reader keeps working; both spellings are returned.
 * Owner user id and subscription internals are not exposed.
 */
export function presentWorkspace(workspace: WorkspaceRecord) {
  const vertical = workspace.vertical ?? DEFAULT_POS_VERTICAL;
  return {
    id: workspace._id,
    accountId: workspace.accountId,
    businessName: workspace.name,
    businessType: vertical,
    name: workspace.name,
    vertical,
    /** The platform POS product code this workspace runs (same value as `vertical`). */
    posType: vertical,
    status: workspace.status,
    contactEmail: workspace.contactEmail ?? '',
    contactPhone: workspace.contactPhone ?? '',
    country: workspace.country ?? 'BD',
    settings: {
      timezone: workspace.settings?.timezone ?? DEFAULT_WORKSPACE_SETTINGS.timezone,
      locale: workspace.settings?.locale ?? DEFAULT_WORKSPACE_SETTINGS.locale,
    },
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export type TrialOutcome =
  | { started: true; days: number }
  | { started: false; reason: 'already_used' | 'not_offered' | 'no_trial_plan' };

/**
 * Self-serve workspace creation by an account owner.
 *
 *   - Only the OWNER of the account may create; staff and platform admins may not.
 *   - Only an ACTIVE product in the platform POS catalog that also has a POS
 *     module can be chosen (`posCatalogService.resolveForNewWorkspace`).
 *   - ONE free trial per ACCOUNT, not per workspace, so opening workspaces
 *     cannot be used to collect trials. Claimed with an atomic marker.
 *   - At most `MAX_WORKSPACES_PER_ACCOUNT`, held under concurrent requests by a
 *     post-insert position check.
 *
 * The new workspace starts with no store (the existing onboarding creates it)
 * and, without a trial, no plan: it is bought from the Subscription page and
 * paid from the shared account wallet.
 */
class WorkspaceService {
  verticalOptions() {
    return posCatalogService.customerOptions();
  }

  async create(userId: Types.ObjectId, input: CreateWorkspaceInput) {
    // Checked against the platform catalog: active, and backed by a POS module.
    const vertical = await posCatalogService.resolveForNewWorkspace(input.vertical);

    const { user, account } = await this.ownedAccount(userId);
    if (account.status === 'suspended') {
      throw ApiError.forbidden('This account is suspended. Please contact support.');
    }

    const max = env.MAX_WORKSPACES_PER_ACCOUNT;
    const limitError = () =>
      ApiError.conflict(`An account can have up to ${max} workspaces.`, { maxWorkspaces: max });
    // Cheap early answer; the post-insert check below is what holds under races.
    if ((await TenantModel.countDocuments({ accountId: account._id })) >= max) throw limitError();

    const tenantId = new Types.ObjectId();
    await TenantModel.create({
      _id: tenantId,
      accountId: account._id,
      vertical,
      name: input.businessName,
      slug: uniqueSlug(input.businessName),
      ownerUserId: user._id,
      status: 'active',
      contactEmail: input.contactEmail || account.contactEmail || user.email,
      contactPhone: input.contactPhone ?? '',
    });

    try {
      // Ids grow with creation time, so a racer that lands beyond the limit
      // counts more than `max` workspaces at or below its own id.
      const position = await TenantModel.countDocuments({ accountId: account._id, _id: { $lte: tenantId } });
      if (position > max) throw limitError();
      await createSystemRoles(tenantId);
    } catch (error) {
      // Only the empty workspace this request just created is removed.
      await Promise.all([TenantModel.deleteOne({ _id: tenantId }), RoleModel.deleteMany({ tenantId })]);
      throw error;
    }

    const trial = await this.maybeStartTrial(account._id, tenantId, vertical);

    return {
      workspace: {
        id: tenantId,
        name: input.businessName,
        vertical,
        posType: vertical,
        status: 'active',
        isHome: false,
        isActive: false,
      },
      trial,
    };
  }

  /** Every workspace the account owns, oldest first. */
  async list(accountId: Types.ObjectId) {
    const workspaces = await TenantModel.find({ accountId }).sort({ createdAt: 1 }).lean<WorkspaceRecord[]>();
    return workspaces.map(presentWorkspace);
  }

  /**
   * Owner edits to a workspace's profile. The caller has already proven
   * ownership (`requireWorkspaceAccess`); the write is ALSO filtered by the
   * owning account, so it cannot land on a workspace that changed hands.
   */
  async update(workspace: WorkspaceRecord, input: UpdateWorkspaceInput) {
    const set: Record<string, unknown> = {};
    if (input.businessName !== undefined) set.name = input.businessName;
    if (input.contactEmail !== undefined) set.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) set.contactPhone = input.contactPhone;
    if (input.settings?.timezone !== undefined) set['settings.timezone'] = input.settings.timezone;
    if (input.settings?.locale !== undefined) set['settings.locale'] = input.settings.locale;
    if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

    const updated = await TenantModel.findOneAndUpdate(
      { _id: workspace._id, accountId: workspace.accountId },
      { $set: set },
      { new: true, runValidators: true },
    ).lean<WorkspaceRecord>();
    if (!updated) throw ApiError.notFound('Workspace not found');
    return presentWorkspace(updated);
  }

  /** The account this user owns, or a refusal. Never read from the request. */
  private ownedAccount(userId: Types.ObjectId) {
    return accountForUser(userId, 'Only the account owner can create workspaces');
  }

  private async maybeStartTrial(
    accountId: Types.ObjectId,
    tenantId: Types.ObjectId,
    vertical: PosVertical,
  ): Promise<TrialOutcome> {
    const plan = await findTrialPlan(vertical);
    if (!plan) return { started: false, reason: 'no_trial_plan' };
    if (!resolvePlanForVertical(plan, vertical).isAvailable) return { started: false, reason: 'not_offered' };

    // History first: an account from before the marker existed may already
    // have had its trial on another workspace.
    const otherWorkspaces = await TenantModel.find({ accountId, _id: { $ne: tenantId } }).distinct('_id');
    const hadTrial = await SubscriptionModel.exists({ tenantId: { $in: otherWorkspaces }, trialEndsAt: { $ne: null } });
    if (hadTrial) {
      await AccountModel.updateOne({ _id: accountId, trialUsedAt: null }, { $set: { trialUsedAt: new Date() } });
      return { started: false, reason: 'already_used' };
    }

    // Atomic claim: of any number of concurrent creations, exactly one wins.
    const claimed = await AccountModel.findOneAndUpdate(
      { _id: accountId, trialUsedAt: null },
      { $set: { trialUsedAt: new Date() } },
      { new: true },
    ).lean();
    if (!claimed) return { started: false, reason: 'already_used' };

    const subscriptionId = await startTrialSubscription(tenantId);
    if (!subscriptionId) {
      // Nothing was granted, so the account keeps its trial.
      await AccountModel.updateOne({ _id: accountId }, { $set: { trialUsedAt: null } });
      return { started: false, reason: 'not_offered' };
    }
    return { started: true, days: TRIAL_LENGTH_DAYS };
  }
}

export const workspaceService = new WorkspaceService();
