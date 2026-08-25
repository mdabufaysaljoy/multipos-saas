import { z } from 'zod';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

const email = z.string().trim().toLowerCase().email('Enter a valid email address');

export const registerSchema = z.object({
  businessName: z.string().trim().min(2, 'Business name is required').max(160),
  name: z.string().trim().min(2, 'Your name is required').max(120),
  email,
  phone: z.string().trim().max(32).optional().default(''),
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
