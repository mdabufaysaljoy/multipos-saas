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

  /**
   * How many reverse proxies sit in front of the API.
   *
   * This decides what `req.ip` is, and `req.ip` is the identity nearly every
   * rate limiter counts against - so a wrong value is a security setting, not a
   * cosmetic one. Express takes the hop-th address from the RIGHT of
   * `X-Forwarded-For`, counting the proxies it trusts:
   *
   *   1 (default) - one proxy, e.g. Nginx terminating TLS. Correct today.
   *   2           - two, e.g. Cloudflare in front of Nginx.
   *   0           - no proxy; the socket address is used and XFF is ignored.
   *
   * TOO HIGH and a client can spoof its own address by sending its own
   * `X-Forwarded-For`, giving every attacker a fresh rate-limit bucket. TOO LOW
   * and every request appears to come from the proxy, so one shared bucket
   * throttles the whole internet together. Re-check this whenever the number of
   * proxies changes.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  /**
   * QZ Tray request signing (direct thermal printing). SERVER ONLY - the
   * private key never reaches the browser and is never committed. Provide
   * either a file path or the PEM text (with \n escapes). Unset in development
   * means QZ Tray runs unsigned and asks the user to allow the site.
   */
  QZ_CERTIFICATE_PATH: z.string().trim().optional(),
  QZ_PRIVATE_KEY_PATH: z.string().trim().optional(),
  QZ_CERTIFICATE: z.string().optional(),
  QZ_PRIVATE_KEY: z.string().optional(),

  /**
   * Redis connection string - `redis://host:port`, or `rediss://` when the
   * provider terminates TLS (ioredis enables TLS from the scheme, so a managed
   * Redis needs no extra configuration here).
   *
   * OPTIONAL, deliberately. Nothing in the application requires Redis yet: this
   * is the Phase 1 foundation, and an unset value simply means the shared
   * client is never opened (see `config/redis.ts`). An unreachable Redis does
   * not stop the server either - but a MALFORMED value does, because a typo in
   * a connection string is a misconfiguration, not an absence, and a server
   * that quietly ran without the cache it was told to use would be worse.
   */
  REDIS_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .trim()
      .refine((value) => /^rediss?:\/\//.test(value), 'REDIS_URL must start with redis:// or rediss://')
      .optional(),
  ),
  /**
   * Namespace prefixed to every key the application writes. Defaults to
   * `retailersuites:<NODE_ENV>:`, so a staging process pointed at a production
   * Redis by accident cannot read or overwrite its keys.
   */
  REDIS_KEY_PREFIX: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().max(64).optional(),
  ),

  STORAGE_DRIVER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('uploads'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),

  DEFAULT_CURRENCY: z.string().length(3).default('BDT'),
  /** Shown as the issuer on subscription invoices. Not secrets. */
  INVOICE_ISSUER_NAME: z.string().max(120).default('POS Platform'),
  INVOICE_ISSUER_ADDRESS: z.string().max(300).default(''),
  TRIAL_DAYS: z.coerce.number().int().min(0).default(7),
  /** Brand shown in transactional emails. Not secrets. */
  BRAND_NAME: z.string().trim().min(1).max(60).default('RetailSuite'),
  BRAND_WEBSITE_URL: z.string().trim().url().default('https://retailersuites.com'),
  BRAND_PRIMARY_COLOR: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2056d5'),
  ),
  /** Timezone dates are shown in to customers (subscription periods are stored as exact instants). */
  BUSINESS_TIMEZONE: z.string().trim().default('Asia/Dhaka'),
  /** Self-serve ceiling on POS workspaces per platform account. */
  MAX_WORKSPACES_PER_ACCOUNT: z.coerce.number().int().min(1).max(100).default(10),

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
