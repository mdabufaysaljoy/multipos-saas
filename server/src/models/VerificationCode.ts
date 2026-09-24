import { Schema, model, type Types } from 'mongoose';

export const VERIFICATION_CHANNELS = ['email', 'phone'] as const;
export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number];

/**
 * A one-time code sent to a person's email address or phone number.
 *
 * The code itself is NEVER stored: only an HMAC of it, so a database leak
 * cannot be replayed into someone's account. A row is short-lived (the TTL
 * index removes it), counts its own attempts, and is consumed the moment it
 * succeeds.
 */
export interface VerificationCodeDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  channel: VerificationChannel;
  /** The address or number it was sent to, so a later change invalidates it. */
  destination: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const verificationCodeSchema = new Schema<VerificationCodeDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: VERIFICATION_CHANNELS, required: true },
    destination: { type: String, required: true, trim: true, maxlength: 200 },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The live code for a channel: at most one is ever current.
verificationCodeSchema.index({ userId: 1, channel: 1, createdAt: -1 });
// Expired rows remove themselves; nothing has to sweep them.
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VerificationCodeModel = model<VerificationCodeDoc>('VerificationCode', verificationCodeSchema);
