import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import type { UserRole } from '../config/constants';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  tenantId: string | null;
  storeId: string | null;
  /** Bumped whenever permissions change so stale tokens can be detected. */
  pv: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL } as SignOptions);

export const signRefreshToken = (payload: RefreshTokenPayload): string =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.REFRESH_TOKEN_TTL } as SignOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload =>
  jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;

export const verifyRefreshToken = (token: string): RefreshTokenPayload =>
  jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;

export const newTokenId = (): string => crypto.randomUUID();

/** Refresh tokens are stored as digests so a database leak cannot mint sessions. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

/** Rough ms conversion for "15m" / "7d" style TTL strings. */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}
