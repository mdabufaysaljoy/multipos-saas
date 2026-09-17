import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { PERMISSION_CATALOG } from '../../config/permissions';
import { RoleModel } from '../../models/Role';
import { UserModel } from '../../models/User';
import { WorkspaceMemberModel } from '../../models/WorkspaceMember';
import { assertWithinAuthority } from '../../services/staff/grantAuthority';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, params } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import type { CreateRoleInput, UpdateRoleInput } from './roles.validators';

/** The permission catalogue that drives the role editor UI. */
export const catalog = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, PERMISSION_CATALOG);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const roles = await RoleModel.find({ tenantId: ctx.tenantId }).sort({ isSystem: -1, name: 1 }).lean();

  const counts = await UserModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { tenantId: ctx.tenantId, deletedAt: null, roleId: { $ne: null } } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  const countByRole = new Map(counts.map((c) => [String(c._id), c.count]));

  ok(res, roles.map((role) => ({ ...role, staffCount: countByRole.get(String(role._id)) ?? 0 })));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CreateRoleInput>(req);
  assertWithinAuthority(ctx, input.permissions, 'create a role');

  const duplicate = await RoleModel.findOne({ tenantId: ctx.tenantId, name: input.name }).select('_id').lean();
  if (duplicate) throw ApiError.conflict('A role with this name already exists');

  const role = await RoleModel.create({ ...input, tenantId: ctx.tenantId, isSystem: false });
  created(res, role.toObject());
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<UpdateRoleInput>(req);

  const role = await RoleModel.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!role) throw ApiError.notFound('Role not found');

  // A role that grants more than you hold is not yours to change - not even its
  // name or active flag - and no edit may push a role beyond what you hold.
  assertWithinAuthority(ctx, role.permissions, 'edit a role');
  if (input.permissions !== undefined) assertWithinAuthority(ctx, input.permissions, 'edit a role');

  if (input.name && input.name !== role.name) {
    const duplicate = await RoleModel.findOne({ tenantId: ctx.tenantId, name: input.name, _id: { $ne: id } })
      .select('_id')
      .lean();
    if (duplicate) throw ApiError.conflict('A role with this name already exists');
    role.name = input.name;
  }

  if (input.description !== undefined) role.description = input.description;
  if (input.permissions !== undefined) role.permissions = input.permissions;
  if (input.isActive !== undefined) role.isActive = input.isActive;

  await role.save();

  // Force every holder's next request to re-read permissions.
  await UserModel.updateMany({ tenantId: ctx.tenantId, roleId: id }, { $inc: { permissionVersion: 1 } });

  ok(res, role.toObject());
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);

  const role = await RoleModel.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!role) throw ApiError.notFound('Role not found');
  // Authority first: someone who may not touch this role learns nothing more about it.
  assertWithinAuthority(ctx, role.permissions, 'delete a role');
  if (role.isSystem) throw ApiError.badRequest('Built-in roles cannot be deleted. Deactivate it instead.');

  const inUse =
    (await UserModel.countDocuments({ tenantId: ctx.tenantId, roleId: id, deletedAt: null })) +
    (await WorkspaceMemberModel.countDocuments({ tenantId: ctx.tenantId, roleId: id, status: { $ne: 'removed' } }));
  if (inUse > 0) {
    throw ApiError.conflict(`${inUse} staff member(s) still use this role. Reassign them first.`);
  }

  await RoleModel.deleteOne({ _id: id, tenantId: ctx.tenantId });
  ok(res, { id, deleted: true });
});
