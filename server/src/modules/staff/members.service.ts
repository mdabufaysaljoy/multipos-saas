import type { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { AccountModel } from '../../models/Account';
import { RoleModel } from '../../models/Role';
import { StoreModel } from '../../models/Store';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { WorkspaceMemberModel, type WorkspaceMemberDoc } from '../../models/WorkspaceMember';
import { ApiError } from '../../utils/ApiError';
import { entitlementService } from '../../services/subscription/entitlement.service';
import {
  assertBranchesWithinAuthority,
  assertCanManage,
  assertWithinAuthority,
  effectivePermissions,
} from '../../services/staff/grantAuthority';
import type { TenantContext } from '../../types/express';
import type { AddMemberInput, UpdateMemberInput } from './members.validators';

type MemberRecord = WorkspaceMemberDoc & { _id: Types.ObjectId };

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * People from other workspaces of the same account, working in this one.
 *
 * Every lookup is scoped to the ACTIVE workspace (`ctx.tenantId`), and adding
 * someone searches only the caller's own account, so a membership can never
 * reach across accounts or be addressed from another workspace by id.
 */
class MemberService {
  async list(ctx: TenantContext) {
    const members = await WorkspaceMemberModel.find({ tenantId: ctx.tenantId, status: { $ne: 'removed' } })
      .sort({ createdAt: -1 })
      .lean<MemberRecord[]>();
    return Promise.all(members.map((member) => this.present(ctx, member)));
  }

  async get(ctx: TenantContext, id: Types.ObjectId) {
    return this.present(ctx, await this.find(ctx, id));
  }

  async add(ctx: TenantContext, input: AddMemberInput) {
    // Only the account owner sees across workspaces, so only they may bring someone over.
    const ownerOnly = ApiError.forbidden('Only the account owner can add people from other workspaces');
    if (!ctx.isAdmin) throw ownerOnly;
    const tenant = await TenantModel.findById(ctx.tenantId).select('accountId').lean();
    if (!tenant?.accountId) throw ApiError.badRequest('This workspace is not linked to an account yet');
    const owns = await AccountModel.exists({ _id: tenant.accountId, ownerUserId: ctx.userId, status: 'active' });
    if (!owns) throw ownerOnly;

    const siblings = await TenantModel.find({ accountId: tenant.accountId, _id: { $ne: ctx.tenantId } }).distinct('_id');
    const candidates = await UserModel.find({ email: input.email, tenantId: { $in: siblings }, role: ROLES.STAFF, deletedAt: null })
      .select('_id isActive')
      .lean();
    if (candidates.length === 0) {
      // Same answer whether the email exists elsewhere on the platform or not.
      throw ApiError.notFound('No staff member with that email works in another workspace of this account');
    }
    if (candidates.length > 1) {
      throw ApiError.conflict('That email belongs to staff in more than one of your workspaces. Use a unique email for each person.');
    }
    const person = candidates[0];
    if (!person.isActive) throw ApiError.badRequest('That staff account is deactivated in its own workspace');

    const grant = { roleId: input.roleId ?? null, extraPermissions: input.extraPermissions, deniedPermissions: input.deniedPermissions };
    const storeId = input.storeId ?? ctx.storeId;
    assertWithinAuthority(ctx, await effectivePermissions(ctx, grant), 'add a member');
    assertBranchesWithinAuthority(ctx, [storeId, ...input.storeAccess]);
    if (input.roleId) await this.assertRoleExists(ctx, input.roleId);
    await this.assertStoresBelongToTenant(ctx, [storeId, ...input.storeAccess]);

    const existing = await WorkspaceMemberModel.findOne({ tenantId: ctx.tenantId, userId: person._id });
    if (existing && existing.status !== 'removed') {
      throw ApiError.conflict('This person is already a member of this workspace');
    }

    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddStaff(ctx.tenantId, entitlement);

    const fields = {
      ...grant,
      storeId,
      storeAccess: input.storeAccess,
      status: 'active' as const,
      addedBy: ctx.userId,
      addedByNameSnapshot: ctx.userName,
      removedAt: null,
    };

    let member;
    if (existing) {
      // A removed membership is reactivated rather than duplicated.
      existing.set(fields);
      member = await existing.save();
    } else {
      try {
        member = await WorkspaceMemberModel.create({ tenantId: ctx.tenantId, userId: person._id, ...fields });
      } catch (error) {
        if (isDuplicateKey(error)) throw ApiError.conflict('This person is already a member of this workspace');
        throw error;
      }
      // The seat check above is not atomic; confirm by ordinal and undo if over.
      const ordinal = await entitlementService.countStaffUpTo(ctx.tenantId, member._id);
      try {
        entitlementService.assertOrdinalWithinLimit(entitlement, 'maxStaff', ordinal, 'staff accounts');
      } catch (error) {
        await WorkspaceMemberModel.deleteOne({ _id: member._id, tenantId: ctx.tenantId });
        throw error;
      }
    }

    return this.get(ctx, member._id);
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateMemberInput) {
    const member = await WorkspaceMemberModel.findOne({ _id: id, tenantId: ctx.tenantId, status: { $ne: 'removed' } });
    if (!member) throw ApiError.notFound('Member not found');
    if (member.userId.equals(ctx.userId)) throw ApiError.forbidden('You cannot change your own access. Ask the workspace owner.');

    await assertCanManage(ctx, member, 'this member');
    assertWithinAuthority(
      ctx,
      await effectivePermissions(ctx, {
        roleId: input.roleId !== undefined ? input.roleId : member.roleId,
        extraPermissions: input.extraPermissions ?? member.extraPermissions,
        deniedPermissions: input.deniedPermissions ?? member.deniedPermissions,
      }),
      'grant access',
    );
    assertBranchesWithinAuthority(ctx, [input.storeId, ...(input.storeAccess ?? [])]);
    if (input.roleId) await this.assertRoleExists(ctx, input.roleId);
    await this.assertStoresBelongToTenant(ctx, [input.storeId ?? null, ...(input.storeAccess ?? [])]);

    if (input.isActive === true && member.status === 'inactive') {
      // Reactivating takes a seat back.
      const entitlement = await entitlementService.forTenant(ctx.tenantId);
      entitlementService.assertUsable(entitlement);
      await entitlementService.assertCanAddStaff(ctx.tenantId, entitlement);
    }

    if (input.roleId !== undefined) member.roleId = input.roleId;
    if (input.extraPermissions !== undefined) member.extraPermissions = input.extraPermissions;
    if (input.deniedPermissions !== undefined) member.deniedPermissions = input.deniedPermissions;
    if (input.storeId !== undefined) member.storeId = input.storeId;
    if (input.storeAccess !== undefined) member.storeAccess = input.storeAccess;
    if (input.isActive !== undefined) member.status = input.isActive ? 'active' : 'inactive';
    await member.save();

    return this.get(ctx, id);
  }

  /** Ends access to this workspace. Their home workspace is untouched. */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const member = await WorkspaceMemberModel.findOne({ _id: id, tenantId: ctx.tenantId, status: { $ne: 'removed' } });
    if (!member) throw ApiError.notFound('Member not found');
    if (member.userId.equals(ctx.userId)) throw ApiError.badRequest('You cannot remove yourself');
    await assertCanManage(ctx, member, 'this member');

    member.status = 'removed';
    member.removedAt = new Date();
    await member.save();
    return { id, removed: true };
  }

  // ----------------------------------------------------------------------

  private async find(ctx: TenantContext, id: Types.ObjectId) {
    const member = await WorkspaceMemberModel.findOne({ _id: id, tenantId: ctx.tenantId, status: { $ne: 'removed' } }).lean<MemberRecord>();
    if (!member) throw ApiError.notFound('Member not found');
    return member;
  }

  private async present(ctx: TenantContext, member: MemberRecord) {
    const [user, role] = await Promise.all([
      UserModel.findById(member.userId).select('name email phone tenantId isActive lastLoginAt').lean(),
      member.roleId ? RoleModel.findOne({ _id: member.roleId, tenantId: ctx.tenantId }).select('name').lean() : null,
    ]);
    const home = user?.tenantId ? await TenantModel.findById(user.tenantId).select('name').lean() : null;
    return {
      id: member._id,
      userId: member.userId,
      name: user?.name ?? 'Unknown',
      email: user?.email ?? '',
      phone: user?.phone ?? '',
      homeWorkspace: home ? { id: home._id, name: home.name } : null,
      roleId: member.roleId,
      roleName: role?.name ?? null,
      storeId: member.storeId,
      storeAccess: member.storeAccess ?? [],
      extraPermissions: member.extraPermissions,
      deniedPermissions: member.deniedPermissions,
      isActive: member.status === 'active',
      /** A deactivated home account cannot sign in, whatever this membership says. */
      accountActive: Boolean(user?.isActive),
      lastLoginAt: user?.lastLoginAt ?? null,
      addedByNameSnapshot: member.addedByNameSnapshot,
      createdAt: member.createdAt,
      effectivePermissions: await effectivePermissions(ctx, member),
    };
  }

  private async assertRoleExists(ctx: TenantContext, roleId: Types.ObjectId) {
    const role = await RoleModel.findOne({ _id: roleId, tenantId: ctx.tenantId, isActive: true }).select('_id').lean();
    if (!role) throw ApiError.badRequest('The selected role does not exist');
  }

  private async assertStoresBelongToTenant(ctx: TenantContext, storeIds: (Types.ObjectId | null)[]) {
    const ids = storeIds.filter((id): id is Types.ObjectId => Boolean(id));
    if (ids.length === 0) return;
    const found = await StoreModel.countDocuments({ _id: { $in: ids }, tenantId: ctx.tenantId, deletedAt: null });
    if (found !== new Set(ids.map(String)).size) {
      throw ApiError.badRequest('One of the selected branches does not belong to this workspace');
    }
  }
}

export const memberService = new MemberService();
