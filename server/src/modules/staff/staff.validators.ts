import { z } from 'zod';
import { ALL_PERMISSIONS } from '../../config/permissions';
import { objectId, searchSchema, emailAddress, optionalPhoneNumber } from '../common/common.validators';

const permissionKey = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

export const createStaffSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(120),
    email: emailAddress,
    phone: optionalPhoneNumber,
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    roleId: objectId.nullable().optional(),
    /** Grants layered on top of the role. */
    extraPermissions: z.array(permissionKey).max(60).default([]),
    /** Denials that win over the role's grants. */
    deniedPermissions: z.array(permissionKey).max(60).default([]),
    /** Home branch. Defaults to the branch the admin is currently working in. */
    storeId: objectId.nullable().optional(),
    /** Additional branches this staff member may work in. */
    storeAccess: z.array(objectId).max(20).default([]),
    isActive: z.boolean().default(true),
  })
  // A role, workspace or privilege named in the body is refused, not quietly
  // ignored: the role a staff member gets is decided on the server.
  .strict();

export const updateStaffSchema = createStaffSchema.omit({ password: true, email: true }).partial();

export const resetStaffPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const listStaffSchema = searchSchema.extend({
  includeInactive: z.coerce.boolean().default(false),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordSchema>;
export type ListStaffInput = z.infer<typeof listStaffSchema>;
