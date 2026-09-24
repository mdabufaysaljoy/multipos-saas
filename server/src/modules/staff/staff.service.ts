import { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { RefreshTokenModel } from '../../models/RefreshToken';
import { RoleModel } from '../../models/Role';
import { StoreModel } from '../../models/Store';
import { UserModel, hashPassword } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { resolvePermissions } from '../../middleware/auth';
import { assertEmailUnused } from '../../services/auth/identity.service';
import {
  assertBranchesWithinAuthority,
  assertCanManage,
  assertWithinAuthority,
  changesAccess,
  effectivePermissions,
} from '../../services/staff/grantAuthority';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type { TenantContext } from '../../types/express';
import type { CreateStaffInput, ListStaffInput, ResetStaffPasswordInput, UpdateStaffInput } from './staff.validators';

class StaffService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  async list(ctx: TenantContext, input: ListStaffInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx), role: { $in: [ROLES.STAFF, ROLES.ADMIN] } };
    if (!input.includeInactive) filter.isActive = true;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }

    const [users, total] = await Promise.all([
      UserModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      UserModel.countDocuments(filter),
    ]);

    const roles = await RoleModel.find({ tenantId: ctx.tenantId }).select('_id name').lean();
    const roleById = new Map(roles.map((r) => [String(r._id), r.name]));

    const items = await Promise.all(
      users.map(async (user) => ({
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        roleId: user.roleId,
        roleName: user.roleId ? roleById.get(String(user.roleId)) ?? null : null,
        storeId: user.storeId,
        storeAccess: user.storeAccess ?? [],
        extraPermissions: user.extraPermissions,
        deniedPermissions: user.deniedPermissions,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        // The set actually enforced, after role + grants + denials are merged.
        effectivePermissions: await resolvePermissions(user),
      })),
    );

    return { items, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    const user = await UserModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!user) throw ApiError.notFound('Staff member not found');
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      roleId: user.roleId,
      storeId: user.storeId,
      storeAccess: user.storeAccess ?? [],
      extraPermissions: user.extraPermissions,
      deniedPermissions: user.deniedPermissions,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      effectivePermissions: await resolvePermissions(user),
    };
  }

  async create(ctx: TenantContext, input: CreateStaffInput) {
    // Authority first, so a refusal never depends on whether a seat is free.
    assertWithinAuthority(
      ctx,
      await effectivePermissions(ctx, {
        roleId: input.roleId ?? null,
        extraPermissions: input.extraPermissions,
        deniedPermissions: input.deniedPermissions,
      }),
      'create a staff account',
    );
    assertBranchesWithinAuthority(ctx, [input.storeId ?? ctx.storeId, ...input.storeAccess]);
    // Who, before capacity: one login per email across the platform.
    await assertEmailUnused(input.email, { tenantId: ctx.tenantId });

    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddStaff(ctx.tenantId, entitlement);

    if (input.roleId) await this.assertRoleExists(ctx, input.roleId);

    // Branch assignment is validated against the tenant's own branches.
    const homeStoreId = input.storeId ?? ctx.storeId;
    await this.assertStoresBelongToTenant(ctx, [homeStoreId, ...input.storeAccess]);

    const user = await UserModel.create({
      tenantId: ctx.tenantId,
      storeId: homeStoreId,
      storeAccess: input.storeAccess,
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: await hashPassword(input.password),
      // New accounts are always staff; admin rights are never granted this way.
      role: ROLES.STAFF,
      roleId: input.roleId ?? null,
      extraPermissions: input.extraPermissions,
      deniedPermissions: input.deniedPermissions,
      isActive: input.isActive,
    });

    // Ordinal confirmation, because the pre-flight count is not atomic.
    // Two creations racing with one email: the earlier record keeps it.
    const earlier = await UserModel.exists({ email: input.email, deletedAt: null, _id: { $lt: user._id } });
    if (earlier) {
      await UserModel.deleteOne({ _id: user._id, tenantId: ctx.tenantId });
      throw ApiError.conflict('This email already has a login. Use a different email address.');
    }

    const ordinal = await entitlementService.countStaffUpTo(ctx.tenantId, user._id);
    try {
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxStaff', ordinal, 'staff accounts');
    } catch (error) {
      // Hard delete: this account never legitimately existed and has no history.
      await UserModel.deleteOne({ _id: user._id, tenantId: ctx.tenantId });
      throw error;
    }

    return this.getById(ctx, user._id);
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateStaffInput) {
    const user = await UserModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!user) throw ApiError.notFound('Staff member not found');

    if (user.role === ROLES.ADMIN && String(user._id) !== String(ctx.userId)) {
      throw ApiError.forbidden('Another administrator account cannot be edited here');
    }

    const isSelf = String(user._id) === String(ctx.userId);
    const touchesAccess = changesAccess(input as Record<string, unknown>);
    if (isSelf && touchesAccess && !ctx.isAdmin) {
      throw ApiError.forbidden('You cannot change your own access. Ask the workspace owner.');
    }
    if (!isSelf) await assertCanManage(ctx, user);
    if (touchesAccess) {
      assertWithinAuthority(
        ctx,
        await effectivePermissions(ctx, {
          roleId: input.roleId !== undefined ? input.roleId ?? null : user.roleId,
          extraPermissions: input.extraPermissions ?? user.extraPermissions,
          deniedPermissions: input.deniedPermissions ?? user.deniedPermissions,
        }),
        'grant access',
      );
      assertBranchesWithinAuthority(ctx, [input.storeId, ...(input.storeAccess ?? [])]);
    }

    if (input.roleId !== undefined) {
      if (input.roleId) await this.assertRoleExists(ctx, input.roleId);
      user.roleId = input.roleId ?? null;
    }

    if (input.name !== undefined) user.name = input.name;
    if (input.phone !== undefined && input.phone !== user.phone) {
      // A new number is an unproven number: whatever was verified was verified
      // about the old one.
      user.phone = input.phone;
      user.phoneVerifiedAt = null;
    }

    if (input.storeId !== undefined && input.storeId) {
      await this.assertStoresBelongToTenant(ctx, [input.storeId]);
      user.storeId = input.storeId;
    }
    if (input.storeAccess !== undefined) {
      await this.assertStoresBelongToTenant(ctx, input.storeAccess);
      user.storeAccess = input.storeAccess;
    }
    if (input.extraPermissions !== undefined) user.extraPermissions = input.extraPermissions;
    if (input.deniedPermissions !== undefined) user.deniedPermissions = input.deniedPermissions;

    if (input.isActive !== undefined) {
      if (!input.isActive && String(user._id) === String(ctx.userId)) {
        throw ApiError.badRequest('You cannot deactivate your own account');
      }
      user.isActive = input.isActive;
    }

    // Invalidate cached permissions on any issued token.
    user.permissionVersion += 1;
    await user.save();

    // A deactivated account must lose its live sessions immediately.
    if (input.isActive === false) {
      await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }

    return this.getById(ctx, id);
  }

  async resetPassword(ctx: TenantContext, id: Types.ObjectId, input: ResetStaffPasswordInput) {
    const user = await UserModel.findOne({ _id: id, ...this.scope(ctx), role: ROLES.STAFF });
    if (!user) throw ApiError.notFound('Staff member not found');
    // Resetting skips the current password, so it is never a way to change your own.
    if (String(user._id) === String(ctx.userId)) throw ApiError.badRequest('Use Change password to set your own password');
    await assertCanManage(ctx, user);

    user.passwordHash = await hashPassword(input.newPassword);
    user.permissionVersion += 1;
    await user.save();

    await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { id, message: 'Password reset. The staff member must sign in again.' };
  }

  /** Soft delete: sales reference the cashier, so the record is kept. */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    if (String(id) === String(ctx.userId)) throw ApiError.badRequest('You cannot delete your own account');

    const user = await UserModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!user) throw ApiError.notFound('Staff member not found');
    if (user.role === ROLES.ADMIN) throw ApiError.forbidden('The workspace owner cannot be deleted');
    await assertCanManage(ctx, user);

    user.deletedAt = new Date();
    user.isActive = false;
    await user.save();

    await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { id, softDeleted: true };
  }

  /** Refuses branch ids belonging to another tenant. */
  private async assertStoresBelongToTenant(ctx: TenantContext, storeIds: (Types.ObjectId | null)[]) {
    const ids = storeIds.filter((id): id is Types.ObjectId => Boolean(id));
    if (ids.length === 0) return;
    const found = await StoreModel.countDocuments({ _id: { $in: ids }, tenantId: ctx.tenantId, deletedAt: null });
    if (found !== new Set(ids.map(String)).size) {
      throw ApiError.badRequest('One of the selected branches does not belong to your workspace');
    }
  }

  private async assertRoleExists(ctx: TenantContext, roleId: Types.ObjectId) {
    const role = await RoleModel.findOne({ _id: roleId, tenantId: ctx.tenantId, isActive: true }).select('_id').lean();
    if (!role) throw ApiError.badRequest('The selected role does not exist');
  }
}

export const staffService = new StaffService();
