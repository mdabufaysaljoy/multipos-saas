import { z } from 'zod';
import { emailAddress } from '../common/common.validators';
import { newPassword } from './auth.validators';

/**
 * The three steps of a forgotten-password reset.
 *
 * `newPassword` is imported, not restated: the policy lives in one place and
 * applies to registration, the signed-in password change and this equally.
 */

export const forgotPasswordSchema = z.object({ email: emailAddress }).strict();

export const verifyResetCodeSchema = z
  .object({
    email: emailAddress,
    // Digits only: the code is generated as six digits and nothing else is a code.
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    /** Proof that the code was answered. Never the code itself, never a user id. */
    resetTicket: z.string().min(20).max(4096),
    newPassword,
  })
  .strict();

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type VerifyResetCodeInput = z.infer<typeof verifyResetCodeSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
