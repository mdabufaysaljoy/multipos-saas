import { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import { RefreshTokenModel } from '../../models/RefreshToken';
import { RoleModel } from '../../models/Role';
import { UserModel, hashPassword } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { resolvePermissions } from '../../middleware/auth';
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
      extraPermissions: user.extraPermissions,
      deniedPermissions: user.deniedPermissions,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      effectivePermissions: await resolvePermissions(user),
    };
  }

  async create(ctx: TenantContext, input: CreateStaffInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddStaff(ctx.tenantId, entitlement);

    const duplicate = await UserModel.findOne({ tenantId: ctx.tenantId, email: input.email, deletedAt: null })
      .select('_id')
      .lean();
    if (duplicate) throw ApiError.conflict('Someone in your workspace already uses this email address');

    if (input.roleId) await this.assertRoleExists(ctx, input.roleId);

    const user = await UserModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
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

    return this.getById(ctx, user._id);
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateStaffInput) {
    const user = await UserModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!user) throw ApiError.notFound('Staff member not found');

    if (user.role === ROLES.ADMIN && String(user._id) !== String(ctx.userId)) {
      throw ApiError.forbidden('Another administrator account cannot be edited here');
    }

    if (input.roleId !== undefined) {
      if (input.roleId) await this.assertRoleExists(ctx, input.roleId);
      user.roleId = input.roleId ?? null;
    }

    if (input.name !== undefined) user.name = input.name;
    if (input.phone !== undefined) user.phone = input.phone;
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

    user.deletedAt = new Date();
    user.isActive = false;
    await user.save();

    await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { id, softDeleted: true };
  }

  private async assertRoleExists(ctx: TenantContext, roleId: Types.ObjectId) {
    const role = await RoleModel.findOne({ _id: roleId, tenantId: ctx.tenantId, isActive: true }).select('_id').lean();
    if (!role) throw ApiError.badRequest('The selected role does not exist');
  }
}

export const staffService = new StaffService();
