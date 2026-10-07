import { Schema, model, type Types } from 'mongoose';

/**
 * A one-time code that lets somebody who has lost their password prove they
 * read the mailbox the account was registered with.
 *
 * Deliberately NOT a row in `VerificationCode`, and deliberately keyed by
 * EMAIL rather than by user:
 *
 *  - A contact-verification code and a password-reset code must never be
 *    interchangeable. Separate collections make that impossible by
 *    construction rather than by a `purpose` filter every query has to
 *    remember.
 *  - The person asking is not signed in, so there is no user to key on. One
 *    email can also own accounts in several workspaces (`User` is unique on
 *    tenant + email), and a single code covers the identity, not one of them.
 *
 * The code itself is NEVER stored - only an HMAC of it - so a database leak
 * cannot be replayed into somebody's account. A row is short-lived (the TTL
 * index removes it), counts its own wrong guesses, records the moment the code
 * was accepted and is consumed for good once the password is set.
 */
export interface PasswordResetCodeDoc {
  _id: Types.ObjectId;
  /** Lowercased, as `User.email` is stored. Never a user id. */
  email: string;
  codeHash: string;
  expiresAt: Date;
  /** Wrong guesses so far. */
  attempts: number;
  /** When the right code was typed. Null until then. */
  verifiedAt: Date | null;
  /** When the password was actually changed with it. Null until then. */
  consumedAt: Date | null;
  /** Coarse request provenance, for rate-limit forensics. Never a credential. */
  requestedFromIp: string;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetCodeSchema = new Schema<PasswordResetCodeDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 200 },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    requestedFromIp: { type: String, default: '', maxlength: 64 },
  },
  { timestamps: true },
);

// The live code for an address, and the per-hour send count, both read this.
passwordResetCodeSchema.index({ email: 1, createdAt: -1 });
// Expired rows remove themselves; nothing has to sweep them.
passwordResetCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetCodeModel = model<PasswordResetCodeDoc>('PasswordResetCode', passwordResetCodeSchema);
