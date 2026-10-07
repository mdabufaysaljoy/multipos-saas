import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env, isProd } from '../../config/env';
import { PasswordResetCodeModel, type PasswordResetCodeDoc } from '../../models/PasswordResetCode';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { RefreshTokenModel } from '../../models/RefreshToken';
import { UserModel, hashPassword } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { emailService } from '../email';
import { passwordResetEmail } from '../email/templates/securityEmails';
import { maskDestination } from './verification.service';

/**
 * Resetting a forgotten password.
 *
 * Shared by every POS: it works on the `User` record, which is the one identity
 * all four verticals authenticate against, so nothing here knows or cares which
 * POS a workspace runs.
 *
 * Three steps, because the person has to be told the code was wrong before they
 * are asked to invent a password:
 *
 *   1. `request(email)`  - sends a six-digit code, and says the same thing
 *                          whether or not the address exists.
 *   2. `verify(email, code)` - checks the code and hands back a short-lived
 *                          ticket. The code is marked verified, not consumed.
 *   3. `reset(ticket, password)` - sets the new password and consumes the row.
 *
 * The code is stored only as an HMAC, expires in minutes, allows a handful of
 * guesses and dies on use. The ticket is a signed token with its own derived
 * secret and its own audience, so it can never be presented as an access token
 * (nor an access token as a ticket), and it carries the ROW id rather than a
 * user id - it proves "this code was answered", nothing more.
 *
 * Nothing in here is ever logged: not the code, not the ticket, not a password.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 15;
/** Wrong guesses allowed per code, after which it must be re-sent. */
const MAX_ATTEMPTS = 5;
/** How soon another code may be sent to the same address. */
const RESEND_COOLDOWN_SECONDS = 60;
/** Codes per address per hour - a cap on what one request can make us send. */
const MAX_SENDS_PER_HOUR = 5;
/** How long the "code was answered" ticket is good for. */
const TICKET_TTL_SECONDS = 10 * 60;
const TICKET_AUDIENCE = 'password-reset-ticket';
/**
 * How many identities one address may reset at once.
 *
 * `User` is unique on tenant + email, so one address can own accounts in
 * several workspaces, and sign-in already treats them as one person choosing
 * between their own shops. A reset therefore covers all of them - otherwise the
 * person would end up with a different password per workspace and no way to
 * tell which. The cap matches sign-in's own candidate cap.
 */
const MAX_IDENTITIES = 10;

/**
 * The one answer the request step ever gives.
 *
 * Saying "no such account" here would turn the endpoint into a register of who
 * banks with us. The wording is deliberately about what WILL happen, not about
 * what was found.
 */
const GENERIC_REQUEST_MESSAGE = 'If the account exists, a verification code has been sent.';

export interface RequestResetResult {
  message: string;
  /** Minutes the code is good for, so the screen can say so without guessing. */
  expiresInMinutes: number;
  resendAfterSeconds: number;
  codeLength: number;
  /**
   * The code itself, OUTSIDE production only, and only when the address really
   * exists.
   *
   * Development and test installations rarely have SMTP configured, and a
   * reset nobody can complete would make the flow untestable. `isProd` gates
   * it, so a real deployment never returns a code to anyone.
   */
  devCode?: string;
}

export interface VerifyResetResult {
  /** Proof the code was answered. Spent by `reset`. */
  resetTicket: string;
  expiresInSeconds: number;
  /** `r****m@example.com` - enough to show which mailbox, not enough to publish. */
  maskedEmail: string;
}

/**
 * Derived from, but never equal to, the access-token secret, and bound to the
 * row AND the address so a ticket cannot be moved to another reset.
 */
const codeHash = (email: string, code: string) =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(`password-reset:${email}:${code}`).digest('hex');

const ticketSecret = () => createHmac('sha256', env.JWT_ACCESS_SECRET).update(TICKET_AUDIENCE).digest('hex');

const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

interface TicketPayload {
  typ: 'password_reset';
  /** The code row this ticket was issued for. */
  rid: string;
  email: string;
}

class PasswordResetService {
  /**
   * Step 1. Always answers the same way.
   *
   * An unknown address is not an error and leaves no row: it simply does the
   * same amount of nothing, and says the same sentence. A known address that is
   * asking too often IS told to wait - a cooldown is about this mailbox, which
   * the person asking already controls, so it reveals nothing they do not know.
   */
  async request(rawEmail: string, meta: { ip?: string } = {}): Promise<RequestResetResult> {
    const email = rawEmail.trim().toLowerCase();
    const shape: RequestResetResult = {
      message: GENERIC_REQUEST_MESSAGE,
      expiresInMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
      codeLength: CODE_LENGTH,
    };

    // A deactivated or deleted identity cannot be signed into, so resetting its
    // password would be pointless; if EVERY identity on the address is in that
    // state the address behaves, correctly, like one that does not exist.
    const identities = await UserModel.find({ email, deletedAt: null, isActive: true }).select('_id').limit(MAX_IDENTITIES).lean();
    if (identities.length === 0) return shape;

    const now = Date.now();
    const recent = await PasswordResetCodeModel.find({ email, createdAt: { $gte: new Date(now - 60 * 60 * 1000) } })
      .select('createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const last = recent[0];
    if (last) {
      const waited = (now - new Date(last.createdAt).getTime()) / 1000;
      if (waited < RESEND_COOLDOWN_SECONDS) {
        throw ApiError.tooManyRequests(`Wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - waited)} seconds before asking for another code.`);
      }
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw ApiError.tooManyRequests('Too many reset codes requested for this address. Try again in an hour.');
    }

    // Cryptographically random, not Math.random: a guessable code is no check at all.
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

    // Any earlier code for this address stops working the moment a new one is sent.
    await PasswordResetCodeModel.updateMany({ email, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await PasswordResetCodeModel.create({
      email,
      codeHash: codeHash(email, code),
      expiresAt,
      requestedFromIp: (meta.ip ?? '').slice(0, 64),
    });

    await this.deliver(email, code);
    return { ...shape, ...(isProd ? {} : { devCode: code }) };
  }

  /**
   * Hands the code to the email provider.
   *
   * A delivery failure is logged and swallowed. The caller must not learn
   * whether sending worked, because "the gateway refused" for one address and
   * silence for another is exactly the existence oracle the generic response
   * exists to prevent. The code expires on its own if it never arrives, and the
   * person can ask again after the cooldown.
   */
  private async deliver(email: string, code: string): Promise<void> {
    try {
      // `provider()` reloads the SMTP credentials from platform settings.
      const provider = await emailService.provider();
      if (!provider.isConfigured()) {
        logger.warn('Password reset code not delivered', { reason: 'No email gateway is configured.' });
        return;
      }
      const settings = await getPlatformSettings();
      const support = typeof settings?.supportEmail === 'string' && settings.supportEmail.includes('@') ? settings.supportEmail : undefined;
      const message = passwordResetEmail({
        code,
        expiresInMinutes: CODE_TTL_MINUTES,
        ...(support ? { supportEmail: support } : {}),
      });
      const result = await provider.send({ to: email, subject: message.subject, html: message.html, text: message.text });
      if (result && result.success === false) {
        logger.warn('Password reset code not delivered', { reason: 'The email gateway refused the message.' });
      }
    } catch (error) {
      // Never log the code, and never leak the provider's internals outward.
      logger.warn('Password reset code could not be delivered', { error: String(error) });
    }
  }

  /**
   * Step 2. Checks the code and hands back a ticket.
   *
   * The row is marked verified rather than consumed, so the ticket can be spent
   * once in step 3 and the row still blocks a second use. An unknown address
   * gets the same message as a wrong code - this step must not become the
   * oracle step 1 refused to be.
   */
  async verify(rawEmail: string, code: string): Promise<VerifyResetResult> {
    const email = rawEmail.trim().toLowerCase();
    const wrong = ApiError.badRequest('That code is not right, or it has expired. Ask for a new one.');

    const record = await PasswordResetCodeModel.findOne({ email, consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!record) throw wrong;

    if (record.attempts >= MAX_ATTEMPTS) {
      throw ApiError.badRequest('Too many incorrect attempts. Ask for a new code.');
    }

    if (!sameHash(record.codeHash, codeHash(email, code))) {
      record.attempts += 1;
      await record.save();
      const left = Math.max(0, MAX_ATTEMPTS - record.attempts);
      throw ApiError.badRequest(
        left > 0 ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Ask for a new code.',
      );
    }

    // Right code. Record the moment, and stop further guessing against the row.
    record.verifiedAt = record.verifiedAt ?? new Date();
    record.attempts = 0;
    await record.save();

    return {
      resetTicket: this.signTicket(record),
      expiresInSeconds: TICKET_TTL_SECONDS,
      maskedEmail: maskDestination('email', email),
    };
  }

  /**
   * Step 3. Sets the new password on every identity the address owns.
   *
   * `permissionVersion` is bumped and every refresh token revoked, exactly as
   * `changePassword` does, so sessions opened with the old password stop
   * working. Only identities on THIS address are touched.
   *
   * The row is consumed FIRST, with a guarded update: two requests racing the
   * same ticket mean only one matches, so a replay cannot set a second password
   * or re-revoke somebody's fresh session.
   */
  async reset(ticket: string, newPassword: string): Promise<{ identities: number }> {
    const payload = this.verifyTicket(ticket);
    const expired = ApiError.badRequest('This reset has expired. Start again from "Forgot password".');

    const spent = await PasswordResetCodeModel.findOneAndUpdate(
      { _id: payload.rid, email: payload.email, consumedAt: null, verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { new: true },
    ).lean();
    if (!spent) throw expired;

    const users = await UserModel.find({ email: payload.email, deletedAt: null, isActive: true })
      .select('_id passwordHash permissionVersion')
      .limit(MAX_IDENTITIES);
    if (users.length === 0) throw expired;

    const passwordHash = await hashPassword(newPassword);
    const ids: Types.ObjectId[] = [];
    for (const user of users) {
      user.passwordHash = passwordHash;
      user.permissionVersion += 1;
      await user.save();
      ids.push(user._id);
    }

    // Setting a password ends every session that was opened with the old one.
    await RefreshTokenModel.updateMany({ userId: { $in: ids }, revokedAt: null }, { $set: { revokedAt: new Date() } });

    logger.info('Password reset completed', { identities: ids.length });
    return { identities: ids.length };
  }

  private signTicket(record: Pick<PasswordResetCodeDoc, '_id' | 'email'>) {
    const payload: TicketPayload = { typ: 'password_reset', rid: String(record._id), email: record.email };
    return jwt.sign(payload, ticketSecret(), { expiresIn: TICKET_TTL_SECONDS, audience: TICKET_AUDIENCE });
  }

  private verifyTicket(token: string): TicketPayload {
    const expired = ApiError.badRequest('This reset has expired. Start again from "Forgot password".');
    try {
      const payload = jwt.verify(token, ticketSecret(), { audience: TICKET_AUDIENCE }) as Partial<TicketPayload>;
      if (payload.typ !== 'password_reset' || typeof payload.rid !== 'string' || typeof payload.email !== 'string') throw expired;
      return payload as TicketPayload;
    } catch {
      throw expired;
    }
  }
}

export const passwordResetService = new PasswordResetService();
export const PASSWORD_RESET_LIMITS = {
  codeLength: CODE_LENGTH,
  ttlMinutes: CODE_TTL_MINUTES,
  maxAttempts: MAX_ATTEMPTS,
  resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  maxSendsPerHour: MAX_SENDS_PER_HOUR,
  ticketTtlSeconds: TICKET_TTL_SECONDS,
};
