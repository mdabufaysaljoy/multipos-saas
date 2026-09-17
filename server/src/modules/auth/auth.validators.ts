import { POS_PRODUCT_CODE_PATTERN } from '../../config/verticals';
import { z } from 'zod';
import { emailAddress, objectId, optionalPhoneNumber, passwordCheck } from '../common/common.validators';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

const email = emailAddress;

export const registerSchema = z.object({
  businessName: z.string().trim().min(2, 'Business name is required').max(160),
  name: z.string().trim().min(2, 'Your name is required').max(120),
  email,
  phone: optionalPhoneNumber,
  password,
  /** The POS the customer wants first. Checked against the ACTIVE platform catalog in the service; Clothing when omitted. */
  vertical: z.string().trim().regex(POS_PRODUCT_CODE_PATTERN, 'Unknown POS type').optional(),
});

export const loginSchema = z.object({
  email,
  password: passwordCheck,
});

/** Completes a sign-in that matched several identities. Only the choice comes from the client. */
export const selectLoginSchema = z
  .object({
    selectionToken: z.string().min(20).max(4096),
    userId: objectId,
  })
  .strict();

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: passwordCheck,
    newPassword: password,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });

/**
 * Only the target is taken from the client. Whether the user may act there is
 * decided on the server from account ownership.
 */
export const switchWorkspaceSchema = z.object({
  workspaceId: objectId,
  /** For non-browser clients; browsers send the httpOnly cookie instead. */
  refreshToken: z.string().min(10).max(4096).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SelectLoginInput = z.infer<typeof selectLoginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
