import mongoose, { Types } from 'mongoose';
import { AccountModel } from '../../models/Account';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { WorkspaceMemberModel } from '../../models/WorkspaceMember';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';

/**
 * Deleting a workspace and everything that belonged to it.
 *
 * This is the real thing - rows leave the database - so it is built to be
 * boring and total rather than clever.
 *
 * WHAT SURVIVES, and why. The account, its wallet and the financial record
 * stay. Money that moved really moved: an invoice that was issued, a receipt
 * that was given and a wallet ledger that was posted are the shop's accounting
 * history and the platform's, and they are immutable by model hook besides
 * (see CLAUDE.md rule 9). A workspace is one POS inside an account; deleting it
 * is not a reason to erase what was paid. Everything else tenant-scoped goes.
 *
 * HOW THE LIST IS BUILT. Not by hand. Fifty-odd models carry a `tenantId`, and
 * a hand-kept list would silently stop covering the one somebody adds next
 * month - the exact failure that leaves orphans nobody notices for a year.
 * Instead every registered model that HAS a `tenantId` path is cleared, minus
 * the few named below. A new tenant-scoped model is therefore covered the day
 * it is written, and anything that must survive has to be named deliberately.
 */

/**
 * Models a workspace delete must not touch.
 *
 * `Account` and `Wallet` are account-scoped: one account can run several
 * workspaces, and the wallet may hold a real balance. The four financial
 * records are kept for accounting. `User` and `Tenant` are not here because
 * they are not simply spared - they are handled explicitly below.
 */
const KEEP = new Set([
  'Account',
  'Wallet',
  'WalletTransaction',
  'WalletReceipt',
  'Invoice',
  'Payment',
]);

/** Handled by hand further down rather than by the sweep. */
const HANDLED_SEPARATELY = new Set(['User', 'Tenant']);

export interface WorkspaceDeletionPlan {
  tenantId: Types.ObjectId;
  name: string;
  vertical: string;
  /** Other workspaces the same account still runs. */
  siblingWorkspaces: number;
  /** Rows that will be removed, by model, largest first. Only non-zero entries. */
  willDelete: { model: string; count: number }[];
  totalRows: number;
  /** Rows deliberately left alone, by model. */
  willKeep: { model: string; count: number }[];
  /** True when this is the last workspace the owning account has. */
  isLastWorkspace: boolean;
}

export interface WorkspaceDeletionResult {
  tenantId: string;
  name: string;
  deletedRows: number;
  deletedByModel: { model: string; count: number }[];
  keptRows: number;
  /** What happened to the owner: moved to another workspace, or retired. */
  owner: 'moved' | 'retired' | 'untouched';
}

/** Every registered model that carries a `tenantId`, minus the ones we spare. */
const tenantScopedModels = () =>
  Object.keys(mongoose.models)
    .filter((name) => !KEEP.has(name) && !HANDLED_SEPARATELY.has(name))
    .filter((name) => Boolean(mongoose.models[name].schema.path('tenantId')))
    .sort();

const keptModels = () => [...KEEP].filter((name) => Boolean(mongoose.models[name]?.schema.path('tenantId'))).sort();

class WorkspaceDeletionService {
  /**
   * What a delete WOULD remove, without removing anything.
   *
   * The panel shows this before asking for confirmation, because "this deletes
   * 4,812 rows including 3,106 sales" is a different decision from "this
   * deletes an empty workspace somebody opened by mistake".
   */
  async plan(tenantId: Types.ObjectId): Promise<WorkspaceDeletionPlan> {
    const tenant = await TenantModel.findById(tenantId).lean();
    if (!tenant) throw ApiError.notFound('Workspace not found');

    const siblings = await TenantModel.countDocuments({ accountId: tenant.accountId, _id: { $ne: tenant._id } });

    const counts = await Promise.all(
      tenantScopedModels().map(async (model) => ({
        model,
        count: await mongoose.models[model].countDocuments({ tenantId }),
      })),
    );
    const users = await UserModel.countDocuments({ tenantId });
    const willDelete = [...counts, { model: 'User', count: users }]
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count);

    const kept = await Promise.all(
      keptModels().map(async (model) => ({
        model,
        count: await mongoose.models[model].countDocuments({ tenantId }),
      })),
    );

    return {
      tenantId: tenant._id,
      name: tenant.name,
      vertical: tenant.vertical,
      siblingWorkspaces: siblings,
      willDelete,
      totalRows: willDelete.reduce((sum, row) => sum + row.count, 0),
      willKeep: kept.filter((row) => row.count > 0).sort((a, b) => b.count - a.count),
      isLastWorkspace: siblings === 0,
    };
  }

  /**
   * Removes the workspace.
   *
   * `confirmName` must be the workspace's own name, checked HERE and not only
   * in a dialog: this is the one call in the platform panel that cannot be
   * undone, and the client is not the thing standing between a mis-click and a
   * shop's data.
   *
   * There is no transaction - this deployment runs standalone MongoDB - so the
   * order matters. The tenant row goes LAST: while it exists, `resolveTenant`
   * still resolves and a half-deleted workspace reads as a workspace with less
   * in it, which is recoverable. Were it deleted first, every surviving row
   * would be unreachable orphan.
   */
  async remove(tenantId: Types.ObjectId, confirmName: string, actor: { id: Types.ObjectId | null; name: string }): Promise<WorkspaceDeletionResult> {
    const tenant = await TenantModel.findById(tenantId).lean();
    if (!tenant) throw ApiError.notFound('Workspace not found');

    if (confirmName.trim() !== tenant.name.trim()) {
      throw ApiError.badRequest('Type the workspace name exactly to confirm the deletion.', { reason: 'NAME_MISMATCH' });
    }

    const siblings = await TenantModel.find({ accountId: tenant.accountId, _id: { $ne: tenant._id } })
      .select('_id')
      .lean();

    // ---- the owner ----------------------------------------------------------
    // An owner reaches the rest of their account through `Account.ownerUserId`,
    // but `resolveActor` gives up the moment their own `tenantId` is empty. So
    // an owner whose HOME workspace is the one being deleted has to be moved to
    // another of theirs, or they would still own workspaces they could no
    // longer open. With nothing left to move them to, the login is retired
    // rather than left pointing at a workspace that is gone - the account, its
    // wallet and its invoices all stay, so nothing financial is lost.
    const account = await AccountModel.findById(tenant.accountId).select('ownerUserId').lean();
    let ownerOutcome: WorkspaceDeletionResult['owner'] = 'untouched';
    if (account?.ownerUserId) {
      const owner = await UserModel.findById(account.ownerUserId).select('tenantId isActive deletedAt');
      if (owner && owner.tenantId && owner.tenantId.equals(tenantId)) {
        if (siblings.length > 0) {
          owner.tenantId = siblings[0]._id;
          await owner.save();
          ownerOutcome = 'moved';
        } else {
          owner.isActive = false;
          owner.deletedAt = new Date();
          await owner.save();
          ownerOutcome = 'retired';
        }
      }
    }

    // ---- everything the workspace owned -------------------------------------
    const deletedByModel: { model: string; count: number }[] = [];
    for (const model of tenantScopedModels()) {
      const result = await mongoose.models[model].deleteMany({ tenantId });
      if (result.deletedCount) deletedByModel.push({ model, count: result.deletedCount });
    }

    // Memberships are keyed by tenant too, but a membership row for a user who
    // belongs to other workspaces must not take the user with it.
    await WorkspaceMemberModel.deleteMany({ tenantId });

    // Staff of this workspace, and the owner when they were not moved. The
    // account owner who WAS moved keeps their login, so they are spared here.
    const staffFilter: Record<string, unknown> = { tenantId };
    if (ownerOutcome === 'moved' && account?.ownerUserId) staffFilter._id = { $ne: account.ownerUserId };
    const users = await UserModel.deleteMany(staffFilter);
    if (users.deletedCount) deletedByModel.push({ model: 'User', count: users.deletedCount });

    // ---- and finally the workspace itself -----------------------------------
    await TenantModel.deleteOne({ _id: tenantId });
    deletedByModel.push({ model: 'Tenant', count: 1 });

    const kept = await Promise.all(
      keptModels().map(async (model) => ({ model, count: await mongoose.models[model].countDocuments({ tenantId }) })),
    );

    const deletedRows = deletedByModel.reduce((sum, row) => sum + row.count, 0);
    logger.info('Workspace deleted', {
      tenantId: String(tenantId),
      name: tenant.name,
      deletedRows,
      owner: ownerOutcome,
      by: actor.name,
    });

    return {
      tenantId: String(tenantId),
      name: tenant.name,
      deletedRows,
      deletedByModel: deletedByModel.sort((a, b) => b.count - a.count),
      keptRows: kept.reduce((sum, row) => sum + row.count, 0),
      owner: ownerOutcome,
    };
  }
}

export const workspaceDeletionService = new WorkspaceDeletionService();
export const WORKSPACE_DELETION_KEEPS = [...KEEP];
