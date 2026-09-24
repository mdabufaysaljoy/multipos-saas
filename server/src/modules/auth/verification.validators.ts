import { z } from 'zod';
import { VERIFICATION_CHANNELS } from '../../models/VerificationCode';

export const sendCodeSchema = z.object({ channel: z.enum(VERIFICATION_CHANNELS) }).strict();

export const confirmCodeSchema = z
  .object({
    channel: z.enum(VERIFICATION_CHANNELS),
    // Digits only: the code is generated as six digits and nothing else is a code.
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();

export type SendCodeInput = z.infer<typeof sendCodeSchema>;
export type ConfirmCodeInput = z.infer<typeof confirmCodeSchema>;
