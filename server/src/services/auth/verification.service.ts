import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Types } from 'mongoose';
import { BRANDING } from '../../config/branding';
import { env, isProd } from '../../config/env';
import { UserModel, type UserDoc } from '../../models/User';
import { VerificationCodeModel, type VerificationChannel } from '../../models/VerificationCode';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { emailService } from '../email';
import { smsRegistry } from '../sms/registry';

/**
 * Verifying that a person really owns the email address or phone number they
 * signed up with.
 *
 * A six-digit code is sent to one of them and typed back. The code is stored
 * only as an HMAC, expires in minutes, allows a handful of attempts and is
 * consumed on success - so an old message, a database dump or a patient
 * guesser gets nobody in.
 *
 * Sending goes straight through the platform's email or SMS provider, NOT
 * through the wallet-billed messaging service: this is the platform verifying
 * its own customer, not the customer sending a message, so nobody's balance is
 * touched.
 */

const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
/** Wrong guesses allowed per code, after which it must be re-sent. */
const MAX_ATTEMPTS = 5;
/** How soon another code may be sent to the same channel. */
const RESEND_COOLDOWN_SECONDS = 60;
/** Codes per channel per hour - a cap on what one account can make us send. */
const MAX_SENDS_PER_HOUR = 5;
/** The billing-test double. It never contacts a network, so it never verifies anything. */
const MOCK_SMS_PROVIDER = 'mock';

export type { VerificationChannel };

export interface VerificationStatus {
  email: { destination: string; masked: string; verified: boolean };
  phone: { destination: string; masked: string; verified: boolean };
  /** The whole point: at least one contact is proven. */
  anyVerified: boolean;
}

export interface SendResult {
  channel: VerificationChannel;
  masked: string;
  expiresAt: Date;
  resendAfterSeconds: number;
  /**
   * Whether a real message actually went out. False when no gateway is
   * configured, when the gateway refused, or when the only provider available
   * is the test double - the UI must not promise a message that is not coming.
   */
  delivered: boolean;
  /** Why nothing was delivered, in words a shop owner can act on. */
  deliveryNote?: string;
  /**
   * The code itself, OUTSIDE production only.
   *
   * Development and test installations rarely have SMTP or an SMS gateway
   * configured, and a verification step nobody can complete would make the
   * whole app untestable. `isProd` gates it, so a real deployment never
   * returns a code to anyone.
   */
  devCode?: string;
}

/** `r****m@example.com`, `01711****11` - enough to recognise, not enough to publish. */
export function maskDestination(channel: VerificationChannel, value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  if (channel === 'email') {
    const [local, domain] = trimmed.split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    const tail = local.length > 1 ? local.slice(-1) : '';
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}${tail}@${domain}`;
  }
  const digits = trimmed.replace(/\s+/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(1, digits.length - 5))}${digits.slice(-2)}`;
}

const hashCode = (code: string, userId: Types.ObjectId, channel: VerificationChannel) =>
  createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${userId}:${channel}:${code}`).digest('hex');

const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

class VerificationService {
  status(user: Pick<UserDoc, 'email' | 'phone' | 'emailVerifiedAt' | 'phoneVerifiedAt'>): VerificationStatus {
    const email = (user.email ?? '').trim();
    const phone = (user.phone ?? '').trim();
    const emailVerified = Boolean(user.emailVerifiedAt);
    const phoneVerified = Boolean(user.phoneVerifiedAt);
    return {
      email: { destination: email, masked: maskDestination('email', email), verified: emailVerified },
      phone: { destination: phone, masked: maskDestination('phone', phone), verified: phoneVerified },
      anyVerified: emailVerified || phoneVerified,
    };
  }

  /** Sends a fresh code, refusing politely when one was just sent. */
  async send(userId: Types.ObjectId, channel: VerificationChannel): Promise<SendResult> {
    const user = await UserModel.findById(userId).select('email phone emailVerifiedAt phoneVerifiedAt').lean();
    if (!user) throw ApiError.unauthorized();

    const destination = (channel === 'email' ? user.email : user.phone)?.trim() ?? '';
    if (!destination) {
      throw ApiError.badRequest(
        channel === 'email' ? 'There is no email address on this account.' : 'Add a phone number to your account first.',
      );
    }
    if (channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt) {
      throw ApiError.badRequest(channel === 'email' ? 'That email address is already verified.' : 'That phone number is already verified.');
    }

    const now = Date.now();
    const recent = await VerificationCodeModel.find({ userId, channel, createdAt: { $gte: new Date(now - 60 * 60 * 1000) } })
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
      throw ApiError.tooManyRequests('Too many codes requested. Try again in an hour, or use your other contact.');
    }

    // Cryptographically random, not Math.random: a guessable code is no check at all.
    const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

    // The previous code for this channel stops working the moment a new one is sent.
    await VerificationCodeModel.updateMany({ userId, channel, consumedAt: null }, { $set: { consumedAt: new Date() } });
    await VerificationCodeModel.create({ userId, channel, destination, codeHash: hashCode(code, userId, channel), expiresAt });

    const delivery = await this.deliver(channel, destination, code);

    return {
      channel,
      masked: maskDestination(channel, destination),
      expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
      delivered: delivery.delivered,
      ...(delivery.note ? { deliveryNote: delivery.note } : {}),
      ...(isProd ? {} : { devCode: code }),
    };
  }

  /**
   * Hands the code to the provider, and says whether it really went out.
   *
   * Credentials live in platform settings and are editable by a platform admin,
   * so BOTH providers are reloaded before sending - reading whatever was loaded
   * at boot would send through a stale (or absent) gateway. The SMS test double
   * is explicitly not a delivery: it exists for the billing tests and never
   * contacts a network, so a code "sent" through it is reported as undelivered
   * rather than promised to the customer.
   *
   * In production a failure is an error - telling someone "code sent" when
   * nothing was sent leaves them waiting for a message that is never coming.
   * Elsewhere it is reported honestly alongside the development code, so a
   * machine without SMTP or an SMS gateway can still be worked on.
   */
  private async deliver(channel: VerificationChannel, destination: string, code: string): Promise<{ delivered: boolean; note?: string }> {
    const minutes = CODE_TTL_MINUTES;
    const message = `${code} is your ${BRANDING.productName} verification code. It expires in ${minutes} minutes.`;
    try {
      if (channel === 'email') {
        // `provider()` reloads the SMTP credentials from platform settings.
        const provider = await emailService.provider();
        if (!provider.isConfigured()) return this.undelivered(channel, 'No email gateway is configured.');
        const result = await provider.send({
          to: destination,
          subject: `${code} is your ${BRANDING.productName} verification code`,
          html: `<p>Your ${BRANDING.productName} verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.</p>`,
          text: message,
        });
        if (result && result.success === false) return this.undelivered(channel, 'The email gateway refused the message.');
        return { delivered: true };
      }

      // activeAsync() reloads the gateway credentials first: they live in the
      // database, and the copy held since boot is usually empty.
      const provider = await smsRegistry.activeAsync();
      if (!provider?.isConfigured()) return this.undelivered(channel, 'No SMS gateway is configured.');
      if (provider.name === MOCK_SMS_PROVIDER) {
        return this.undelivered(channel, 'Only the SMS test double is available on this server, and it does not deliver messages.');
      }
      const result = await provider.send({ to: destination, message });
      if (!result.success) return this.undelivered(channel, 'The SMS gateway refused the message.');
      return { delivered: true };
    } catch (error) {
      // Never log the code, and never leak the provider's internals outward.
      logger.warn('Verification code could not be delivered', { channel, error: String(error) });
      return this.undelivered(channel, channel === 'email' ? 'The email gateway could not be reached.' : 'The SMS gateway could not be reached.');
    }
  }

  /** One place to decide what an undelivered code means for the caller. */
  private undelivered(channel: VerificationChannel, note: string): { delivered: boolean; note: string } {
    logger.warn('Verification code was not delivered', { channel, note });
    if (isProd) {
      throw ApiError.badRequest(
        `${note} ${channel === 'email' ? 'Try your phone number instead, or try again shortly.' : 'Try your email address instead, or try again shortly.'}`,
      );
    }
    return { delivered: false, note };
  }

  /** Checks a code and, on success, marks the contact verified. */
  async confirm(userId: Types.ObjectId, channel: VerificationChannel, code: string): Promise<VerificationStatus> {
    const user = await UserModel.findById(userId).select('email phone emailVerifiedAt phoneVerifiedAt');
    if (!user) throw ApiError.unauthorized();
    if (channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt) return this.status(user);

    const record = await VerificationCodeModel.findOne({ userId, channel, consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!record) throw ApiError.badRequest('That code has expired. Ask for a new one.');

    // The address must still be the one the code was sent to.
    const destination = (channel === 'email' ? user.email : user.phone)?.trim() ?? '';
    if (record.destination !== destination) {
      record.consumedAt = new Date();
      await record.save();
      throw ApiError.badRequest('Your contact details changed. Ask for a new code.');
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      throw ApiError.badRequest('Too many incorrect attempts. Ask for a new code.');
    }

    if (!sameHash(record.codeHash, hashCode(code, userId, channel))) {
      record.attempts += 1;
      await record.save();
      const left = Math.max(0, MAX_ATTEMPTS - record.attempts);
      throw ApiError.badRequest(left > 0 ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Ask for a new code.');
    }

    record.consumedAt = new Date();
    await record.save();
    if (channel === 'email') user.emailVerifiedAt = new Date();
    else user.phoneVerifiedAt = new Date();
    await user.save();

    return this.status(user);
  }

  /**
   * Whether this user has proven at least one contact. The single question the
   * purchase paths ask.
   */
  async hasVerifiedContact(userId: Types.ObjectId): Promise<boolean> {
    const user = await UserModel.findById(userId).select('emailVerifiedAt phoneVerifiedAt').lean();
    return Boolean(user?.emailVerifiedAt || user?.phoneVerifiedAt);
  }
}

export const verificationService = new VerificationService();
export const VERIFICATION_LIMITS = { codeLength: CODE_LENGTH, ttlMinutes: CODE_TTL_MINUTES, maxAttempts: MAX_ATTEMPTS, resendCooldownSeconds: RESEND_COOLDOWN_SECONDS };
