import { z } from 'zod';
import { ALL_PERMISSIONS } from '../../config/permissions';

const permissionKey = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'Role name is required').max(80),
  description: z.string().trim().max(300).optional().default(''),
  permissions: z.array(permissionKey).max(60).default([]),
  isActive: z.boolean().default(true),
});

export const updateRoleSchema = createRoleSchema.partial();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
