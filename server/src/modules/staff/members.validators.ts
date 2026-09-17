import { z } from 'zod';
import { ALL_PERMISSIONS } from '../../config/permissions';
import { emailAddress, objectId } from '../common/common.validators';

const permissionKey = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

/**
 * Adding someone from another workspace of the account. The person is named by
 * email only; `userId`, `tenantId`, `accountId`, `status` or a role like
 * `admin` are rejected - who they are and where they come from is resolved on
 * the server, within the caller's own account.
 */
export const addMemberSchema = z
  .object({
    email: emailAddress,
    roleId: objectId.nullable().optional(),
    extraPermissions: z.array(permissionKey).max(60).default([]),
    deniedPermissions: z.array(permissionKey).max(60).default([]),
    /** Default branch here. Defaults to the branch the owner is working in. */
    storeId: objectId.nullable().optional(),
    storeAccess: z.array(objectId).max(20).default([]),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    roleId: objectId.nullable(),
    extraPermissions: z.array(permissionKey).max(60),
    deniedPermissions: z.array(permissionKey).max(60),
    storeId: objectId,
    storeAccess: z.array(objectId).max(20),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const memberParams = z.object({ memberId: objectId });

export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
