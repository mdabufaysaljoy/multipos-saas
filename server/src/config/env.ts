import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the server folder first, then fall back to the repo root so a
// single root-level .env can drive the whole monorepo during development.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(10),

  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  STORAGE_DRIVER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('uploads'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),

  DEFAULT_CURRENCY: z.string().length(3).default('BDT'),
  TRIAL_DAYS: z.coerce.number().int().min(0).default(14),

  SEED_PLATFORM_ADMIN_EMAIL: z.string().email().default('platform@pos.dev'),
  SEED_PLATFORM_ADMIN_PASSWORD: z.string().default('Platform@123'),
  SEED_TENANT_ADMIN_EMAIL: z.string().email().default('admin@demostore.dev'),
  SEED_TENANT_ADMIN_PASSWORD: z.string().default('Admin@123'),
  SEED_STAFF_EMAIL: z.string().email().default('cashier@demostore.dev'),
  SEED_STAFF_PASSWORD: z.string().default('Cashier@123'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast: a half-configured server is worse than one that refuses to boot.
  throw new Error(`Invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the values.`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
