import crypto from 'crypto';
import rateLimit, { MemoryStore, type Options, type Store, type ClientRateLimitInfo } from 'express-rate-limit';
import type { RequestHandler, Request } from 'express';
import { getRedis, redisConfig } from '../config/redis';
import { isProd } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Rate limiting, shared across every API replica.
 *
 * WHY THIS EXISTS. Every limiter used `express-rate-limit`'s default
 * `MemoryStore`, which counts inside one process. With N replicas behind a load
 * balancer the real limit is therefore N times the configured one: a login
 * limit of 20 per quarter hour becomes 60 across three replicas, and the limit
 * an operator reads in the code is not the limit an attacker meets. The counter
 * has to live where every replica can see it.
 *
 * WHAT CHANGED AND WHAT DID NOT. Only the STORAGE. Every policy - window,
 * limit, key, status code, headers, message - is preserved exactly; the
 * limiters below are the same `express-rate-limit` middleware they always were,
 * handed a different store. Nothing about an allowed request changes.
 *
 * ONE REDIS CONNECTION, AND IT IS THE ONE PHASE 1 ALREADY OPENS. This reuses
 * the shared application client from `config/redis.ts` - not the BullMQ
 * connection, which is configured for queues, and not a new one. Nothing is
 * created per request. The Phase 1 client's defaults are exactly what a limiter
 * needs: `enableOfflineQueue: false` and a bounded `maxRetriesPerRequest`, so a
 * command issued while Redis is away fails in milliseconds instead of holding
 * a request open, which is what makes the fallback below usable.
 */

/**
 * What a limiter does when Redis cannot be reached.
 *
 * There is no single right answer, so this is decided per policy:
 *
 * - `memory` - fall back to a per-process counter. The configured limit still
 *   applies, just once per replica, so protection degrades from "N" to
 *   "N x replicas" rather than disappearing. **This is not fail-open.** It is
 *   the right choice wherever availability matters more than exactness: a till
 *   that cannot sign in cannot sell, and a cache outage must not become a
 *   trading outage.
 *
 * - `closed` - refuse the request. Reserved for limiters that guard SPENDING on
 *   the customer's behalf, or the API's own capacity, where a runaway client is
 *   the actual threat and a temporary refusal costs nothing but a retry.
 *   Letting every replica independently allow the limit is the outcome worth
 *   preventing there.
 *
 * ONE IMPORTANT DISTINCTION. `closed` means "refuse while a Redis we were told
 * to use is unreachable". It does NOT mean "refuse because no Redis was ever
 * configured". Phase 1 made Redis optional for the API deliberately, and a
 * deployment that has none must keep behaving as it did before distributed
 * limiting existed - otherwise this phase would silently turn Redis into a hard
 * dependency and take whole features away with it. So when `REDIS_URL` is
 * unset, EVERY policy uses the per-process counter, which is exactly the
 * behaviour that shipped before.
 */
export type RateLimitFallback = 'memory' | 'closed';

export interface RateLimitPolicy {
  /** Short, stable name. Becomes part of the Redis key, so it must not change casually. */
  name: string;
  windowMs: number;
  /** The production limit. */
  limit: number;
  /**
   * The development and test limit. The end-to-end suite makes several thousand
   * calls per run and signs in as dozens of accounts; throttling it would look
   * like a product failure. Production always uses `limit`.
   */
  devLimit: number;
  fallback: RateLimitFallback;
  /** Message body, kept identical to what each route returned before. */
  message?: unknown;
  /** Identity to count against. Defaults to the client IP, via Express. */
  keyGenerator?: (req: Request) => string;
  /** When true, a 2xx/3xx response does not count - used for failed-login counting. */
  skipSuccessfulRequests?: boolean;
  /**
   * Test seam. Production always uses the shared Phase 1 client; this lets a
   * test drive the same middleware and the same store against a command
   * executor it controls.
   */
  store?: Store;
}

/**
 * The counter, in one atomic step.
 *
 * `INCR` creates the key at 1 when it does not exist, so the window starts on
 * the first request of it. The expiry is set in the SAME script, so a counter
 * key can never outlive its window - and the `ttl < 0` branch repairs a key
 * that somehow exists without one, which is the only way an unbounded counter
 * could otherwise appear.
 *
 * One round trip, no read-then-write, so concurrent requests - on one replica
 * or across all of them - cannot both see "under the limit" and both proceed.
 *
 * KEYS[1] the counter key   ARGV[1] window in milliseconds
 * returns { hits, ttlMs }
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/** Exposed so a test can assert the script is atomic rather than a read-then-write. */
export const incrementScript = INCREMENT_SCRIPT;

/** The minimum of ioredis this store uses. Narrowed so it can be driven in tests. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  decr(key: string): Promise<unknown>;
}

export class RedisUnavailableError extends Error {
  constructor() {
    super('Rate limiting is unavailable');
    this.name = 'RedisUnavailableError';
  }
}

/**
 * Keys look like `rl:<policy>:<identity>`, and the Phase 1 client prefixes them
 * with the environment namespace (`retailersuites:<env>:`), so two deployments
 * sharing a Redis cannot share counters. ioredis applies that prefix to `EVAL`
 * keys too, which is why the key passed here is deliberately bare.
 *
 * An identity is never a credential. It is an IP, a workspace id, or a HASH of
 * a submitted identifier - never a password, a token, or an Authorization
 * header, and never anything that is logged.
 */
export const rateLimitKey = (policy: string, identity: string) => `rl:${policy}:${identity}`;

/** Hashed so a submitted email is never stored in Redis, and so key size is fixed. */
export const hashIdentity = (value: string) =>
  crypto.createHash('sha256').update(value).digest('base64url').slice(0, 24);

/**
 * How often a limiter may say out loud that Redis is missing. Once per minute
 * per policy: enough to notice in the log, not enough to bury it.
 */
const OUTAGE_LOG_INTERVAL_MS = 60_000;
const lastOutageLog = new Map<string, number>();

function reportOutage(policy: string, fallback: RateLimitFallback, error: unknown): void {
  const now = Date.now();
  const last = lastOutageLog.get(policy) ?? 0;
  if (now - last < OUTAGE_LOG_INTERVAL_MS) return;
  lastOutageLog.set(policy, now);
  logger.warn('Rate limiting could not reach Redis', {
    policy,
    fallback: fallback === 'closed' ? 'refusing requests' : 'per-process counter',
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Test seam: forget the log cool-off so outage logging is assertable. */
export const resetRateLimitOutageLog = () => lastOutageLog.clear();

/**
 * An `express-rate-limit` store backed by Redis, with a declared fallback.
 *
 * `localKeys` is false because keys really are shared, which is what tells
 * `express-rate-limit` not to warn about double counting.
 */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  private windowMs = 60_000;
  private readonly memory = new MemoryStore();

  constructor(
    private readonly policy: string,
    private readonly fallback: RateLimitFallback,
    private readonly client: () => RateLimitRedis | null = getRedis,
    /** Whether a Redis was configured at all. Separates "absent" from "down". */
    private readonly configured: () => boolean = () => redisConfig() !== null,
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redis = this.client();

    // No Redis was configured: a supported deployment, not an outage. Count in
    // process, exactly as the application did before this phase, and say
    // nothing - there is nothing wrong to report.
    if (!redis && !this.configured()) return this.memory.increment(key);

    if (redis) {
      try {
        const reply = (await redis.eval(INCREMENT_SCRIPT, 1, rateLimitKey(this.policy, key), this.windowMs)) as [
          number,
          number,
        ];
        const hits = Number(reply?.[0] ?? 1);
        const ttlMs = Number(reply?.[1] ?? this.windowMs);
        return { totalHits: hits, resetTime: new Date(Date.now() + Math.max(0, ttlMs)) };
      } catch (error) {
        reportOutage(this.policy, this.fallback, error);
      }
    } else {
      reportOutage(this.policy, this.fallback, new RedisUnavailableError());
    }

    // A Redis we were told to use is unreachable. What happens now is the
    // policy's own decision, declared where the policy is.
    if (this.fallback === 'closed') throw new RedisUnavailableError();
    return this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    const redis = this.client();
    if (!redis) {
      await this.memory.decrement(key);
      return;
    }
    try {
      await redis.decr(rateLimitKey(this.policy, key));
    } catch {
      // A counter that could not be decremented expires on its own; the window
      // is simply slightly stricter for this client until then.
    }
  }

  async resetKey(key: string): Promise<void> {
    const redis = this.client();
    if (!redis) {
      await this.memory.resetKey(key);
      return;
    }
    try {
      await redis.del(rateLimitKey(this.policy, key));
    } catch {
      // Nothing to do: the key expires anyway.
    }
  }
}

/**
 * Builds a limiter from a policy.
 *
 * Every limiter in the application goes through here, so the storage, the
 * fallback, the key namespace and the response shape are decided in one place
 * rather than twenty.
 */
export function createRateLimiter(policy: RateLimitPolicy): RequestHandler {
  const store = policy.store ?? new RedisRateLimitStore(policy.name, policy.fallback);

  const message =
    policy.message ?? { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Slow down a moment and try again.' } };

  const limiter = rateLimit({
    windowMs: policy.windowMs,
    limit: isProd ? policy.limit : policy.devLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    ...(policy.keyGenerator ? { keyGenerator: policy.keyGenerator } : {}),
    ...(policy.skipSuccessfulRequests ? { skipSuccessfulRequests: true } : {}),
    message,
    // A store error must never quietly let the request through; what happens
    // instead is the policy's decision, handled below.
    passOnStoreError: false,
    requestWasSuccessful: (_req, res) => res.statusCode < 400,
  });

  if (policy.fallback !== 'closed') return limiter;

  /**
   * A `closed` policy refuses when Redis is away, and it has to refuse with the
   * limiter's own 429 rather than the 500 that a store error would otherwise
   * become: the client already understands "too many requests", an operator
   * reading a 500 would go looking for a crash, and the outcome is a deliberate
   * refusal, not a fault. Any other error is passed along untouched.
   */
  // Returns the promise, so Express (and a test) can await the outcome.
  return async (req, res, next) => {
    try {
      await limiter(req, res, ((error?: unknown) => {
        if (error instanceof RedisUnavailableError) {
          res.status(429).send(message);
          return;
        }
        next(error as never);
      }) as never);
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        res.status(429).send(message);
        return;
      }
      next(error as never);
    }
  };
}

/**
 * Identity for a limiter that should count per workspace rather than per
 * address, because several tills share one office connection. Falls back to the
 * IP before authentication has run.
 */
export const tenantIdentity = (req: Request): string => String(req.ctx?.tenantId ?? req.ip ?? 'unknown');
