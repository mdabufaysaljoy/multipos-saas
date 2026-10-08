import { Router } from 'express';
import { createRateLimiter, hashIdentity } from '../../middleware/rateLimit';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { confirmCodeSchema, sendCodeSchema } from './verification.validators';
import * as controller from './auth.controller';
import { changePasswordSchema, loginSchema, registerSchema, selectLoginSchema, switchWorkspaceSchema } from './auth.validators';
import { forgotPasswordSchema, resetPasswordSchema, verifyResetCodeSchema } from './passwordReset.validators';

const router = Router();

/**
 * Credential endpoints are rate limited to blunt brute-force attempts.
 * The limit is relaxed in development so the end-to-end suite - which signs in
 * as several accounts on every run - is not throttled. Production keeps the
 * strict window.
 */
const credentialLimiter = createRateLimiter({
  name: 'auth-credentials',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  devLimit: 5_000,
  // Degraded rather than closed: nobody should be unable to sign in to a till
  // because a cache is down, and 20 per replica is still brute-force proof.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' } },
});

/**
 * Per-ACCOUNT login protection, on top of the per-IP limit above.
 *
 * The IP limit alone cannot stop credential stuffing: a thousand hosts each
 * making one attempt against one account never trips it. This counts attempts
 * against the ADDRESS SOMEONE TYPED instead, so one account cannot be guessed
 * at from everywhere at once.
 *
 * Only FAILED attempts count (`skipSuccessfulRequests`), so a busy till that
 * signs in repeatedly is never locked out by its own success.
 *
 * The identifier is normalised and then HASHED: Redis never holds the address,
 * every key is the same small size, and nothing identifying reaches the logs.
 * A missing or implausible identifier falls back to the IP, so the limiter
 * cannot be skipped by omitting the field.
 *
 * On key growth: an attacker can mint one key per address they guess, but each
 * is a few dozen bytes with a fifteen-minute expiry, and the rate they can be
 * created is itself bounded by the per-IP limiter that runs first - which is
 * why the order below matters.
 */
const loginAccountLimiter = createRateLimiter({
  name: 'auth-login-account',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  devLimit: 5_000,
  // Degraded, not closed: a cache outage must not lock every shop out of its
  // own till, and ten failures per replica is still a brick wall for guessing.
  fallback: 'memory',
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // This runs BEFORE validation, so the body is untrusted and may be anything.
    const raw = (req.body as { email?: unknown } | undefined)?.email;
    const email = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : '';
    return email.includes('@') ? `e:${hashIdentity(email)}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' } },
});

/**
 * Refresh mints a new token pair and, on reuse, revokes a whole chain - so it
 * is worth a policy of its own rather than only the global one.
 *
 * Generous on purpose: an access token lives fifteen minutes, so a shop with
 * ten tills refreshes roughly forty times an hour from one office address, and
 * a reconnecting client may retry. This bounds abuse without touching normal
 * multi-device use.
 */
const refreshLimiter = createRateLimiter({
  name: 'auth-refresh',
  windowMs: 15 * 60 * 1000,
  limit: 120,
  devLimit: 10_000,
  // Refusing a refresh signs a working till out mid-shift.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many token refreshes. Try again in a few minutes.' } },
});

/** Signing out is cheap, but it should not be an unmetered endpoint either. */
const logoutLimiter = createRateLimiter({
  name: 'auth-logout',
  windowMs: 15 * 60 * 1000,
  limit: 60,
  devLimit: 10_000,
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Try again in a few minutes.' } },
});

router.post('/register', credentialLimiter, validate({ body: registerSchema }), controller.register);
// Per-IP first, then per-account: the IP limit is what bounds how many distinct
// account keys one attacker can create.
router.post('/login', credentialLimiter, loginAccountLimiter, validate({ body: loginSchema }), controller.login);
router.post('/login/select', credentialLimiter, validate({ body: selectLoginSchema }), controller.selectLogin);
router.post('/refresh', refreshLimiter, controller.refresh);
router.post('/logout', logoutLimiter, controller.logout);

router.get('/me', authenticate, controller.me);

/**
 * Forgotten password: public, because the person cannot sign in.
 *
 * Two limiters, because the two halves are abused differently. Asking for a
 * code costs the platform an email, so sending is capped tightly per IP on top
 * of the per-address cooldown and hourly cap in the service. Answering a code
 * is a guessing game, so it gets its own window - the per-code attempt counter
 * stops five wrong guesses against one code, and this stops somebody cycling
 * through fresh codes to keep guessing. Development is relaxed so the
 * end-to-end suite, which runs the whole flow several times, is not throttled
 * into looking like a product failure.
 */
const forgotPasswordLimiter = createRateLimiter({
  name: 'auth-password-forgot',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  devLimit: 5_000,
  // Account recovery must keep working during a cache outage.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many password reset requests. Try again in a few minutes.' } },
});
const resetAttemptLimiter = createRateLimiter({
  name: 'auth-password-reset',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  devLimit: 5_000,
  // As above - and the per-code attempt counter in the service is a second,
  // database-backed bound that does not depend on Redis at all.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' } },
});

router.post('/password/forgot', forgotPasswordLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/password/verify-code', resetAttemptLimiter, validate({ body: verifyResetCodeSchema }), controller.verifyPasswordResetCode);
router.post('/password/reset', resetAttemptLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword);

/**
 * Switching mints a new token pair, so it is throttled like other token
 * issuance - loosely enough for a person hopping between their shops.
 */
const switchLimiter = createRateLimiter({
  name: 'auth-switch-workspace',
  windowMs: 60 * 1000,
  limit: 30,
  devLimit: 2_000,
  // Ordinary navigation for an owner with several shops.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many workspace switches. Try again in a minute.' } },
});

router.get('/workspaces', authenticate, controller.workspaces);
router.post('/switch-workspace', switchLimiter, authenticate, validate({ body: switchWorkspaceSchema }), controller.switchWorkspace);
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

// Email / phone verification. Sending costs the platform a message, so it is
// rate limited here as well as by the per-user cooldown in the service.
const verificationLimiter = createRateLimiter({
  name: 'auth-verification',
  windowMs: 60_000,
  limit: 6,
  devLimit: 10_000,
  // Sending costs a message, but blocking it blocks onboarding entirely; the
  // per-user cooldown in the service also survives a Redis outage.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many verification attempts. Wait a minute and try again.' } },
});
router.get('/verification', authenticate, controller.verificationStatus);
router.post('/verification/send', authenticate, verificationLimiter, validate({ body: sendCodeSchema }), controller.sendVerificationCode);
router.post('/verification/confirm', authenticate, verificationLimiter, validate({ body: confirmCodeSchema }), controller.confirmVerificationCode);

export default router;
