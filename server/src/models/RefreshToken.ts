import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One row per issued refresh token. Tokens are stored hashed and rotated on
 * every use; reusing a revoked token revokes the whole family.
 */
export interface RefreshTokenDoc extends BaseDoc {
  userId: Types.ObjectId;
  tenantId: Types.ObjectId | null;
  jti: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByJti: string | null;
  userAgent: string;
  ip: string;
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    jti: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByJti: { type: String, default: null },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ jti: 1 }, { unique: true });
// Expired sessions clean themselves up.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model<RefreshTokenDoc>('RefreshToken', refreshTokenSchema);
