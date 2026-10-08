import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * The shared Redis connection.
 *
 * WHAT THIS IS FOR. Redis exists here to hold the state that must be the same
 * in every API process. Nothing uses it yet - this is the foundation the next
 * phases build on (docs/INFRASTRUCTURE_ROADMAP.md §3):
 *
 *   - BullMQ queues (Phase 2-3), which require Redis and cannot use MongoDB;
 *   - distributed rate limiting (Phase 4), today a per-process memory store, so
 *     the real limit is multiplied by the number of replicas;
 *   - short-lived shared cache for the few hot unauthenticated reads;
 *   - coordination locks, only where a cheaper mechanism genuinely will not do.
 *
 * WHAT IT IS NOT FOR. Not sessions - authentication is a stateless JWT plus a
 * database-backed refresh chain with reuse detection, and moving it here would
 * weaken it. Not idempotency - those keys are unique partial indexes on the
 * business documents themselves, which is stronger than a key with a TTL that
 * can expire out from under a retry. And not a general cache: nothing should be
 * cached here until a measurement says it needs to be.
 *
 * REDIS IS OPTIONAL AT THIS STAGE. `REDIS_URL` unset means the client is never
 * opened and everything behaves exactly as it did before. An unreachable Redis
 * does not stop the server booting and does not take the POS down - a till that
 * cannot sell because a cache is unavailable would be a far worse outcome than
 * a missing cache. Each future consumer decides for itself whether Redis is
 * required for its own feature; the connection never decides that globally.
 *
 * ONE CLIENT PER PROCESS. Created once, here. Never inside a route handler and
 * never per request. Future queue connections are built from the SAME resolved
 * configuration through `createRedisClient`, so there is one place that knows
 * how to reach Redis - which is what makes this reusable by the API, by the
 * worker process Phase 2 adds, and by any further replica.
 */

export interface RedisConfig {
  url: string;
  keyPrefix: string;
  /** True when the URL asks for TLS (`rediss://`), which managed providers require. */
  tls: boolean;
}

/** The environment values this module reads. Narrowed so it can be tested without a real environment. */
export interface RedisEnvSource {
  NODE_ENV: string;
  REDIS_URL?: string | undefined;
  REDIS_KEY_PREFIX?: string | undefined;
}

/**
 * Derives the configuration from an environment-shaped object, or `null` when
 * no Redis is configured. Pure, so the rules are testable on their own.
 */
export function resolveRedisConfig(source: RedisEnvSource): RedisConfig | null {
  const url = source.REDIS_URL?.trim();
  if (!url) return null;

  // A prefix always ends in a separator, so keys read cleanly in redis-cli and
  // a prefix can never run into the first key segment.
  const raw = source.REDIS_KEY_PREFIX?.trim() || `retailersuites:${source.NODE_ENV}`;
  const keyPrefix = raw.endsWith(':') ? raw : `${raw}:`;

  return { url, keyPrefix, tls: url.startsWith('rediss://') };
}

/** How long a reconnect waits, capped. Retries for ever: a Redis that comes back should be picked up. */
const retryStrategy = (attempt: number) => Math.min(attempt * 200, 5_000);

/**
 * Builds a client from a resolved configuration.
 *
 * The defaults are chosen for APPLICATION use, where a command must fail fast
 * so the caller can fall back:
 *
 *   - `enableOfflineQueue: false` - while disconnected a command is rejected
 *     immediately rather than buffered until it succeeds. A rate limiter that
 *     wants to fail open needs an error now, not a request that hangs.
 *   - `maxRetriesPerRequest: 2` - bounded, for the same reason.
 *
 * BullMQ needs the opposite - `maxRetriesPerRequest: null`, `enableOfflineQueue`
 * left on, and its own connection per queue and worker. That is why this takes
 * an override: Phase 2 calls `createRedisClient(redisConfig(), { ... })`
 * instead of learning the connection details for itself.
 *
 * A client built here is NOT connected and has NO listeners. The caller owns
 * both: ioredis reports an `error` with no listener as an unhandled event, so
 * anything using this factory directly must attach one. The shared client
 * below already does.
 */
export function createRedisClient(config: RedisConfig, overrides: RedisOptions = {}): Redis {
  return new Redis(config.url, {
    keyPrefix: config.keyPrefix,
    // Nothing connects on construction; `connectRedis` decides when.
    lazyConnect: true,
    connectTimeout: 10_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy,
    // A replica promoted behind a managed endpoint answers READONLY; reconnecting
    // is what picks up the new primary.
    reconnectOnError: (error: Error) => error.message.includes('READONLY'),
    ...overrides,
  });
}

export type RedisConnectionState = 'disabled' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface RedisState {
  /** Whether `REDIS_URL` is set at all. */
  configured: boolean;
  state: RedisConnectionState;
  /** True only when a handshake has completed and commands can be sent. */
  ready: boolean;
}

/**
 * Resolved once, at load: it is pure, and reporting "configured" must not
 * depend on whether anything has tried to connect yet.
 */
const config = resolveRedisConfig(env);

let client: Redis | null = null;
let closing = false;

/** The resolved configuration, or `null` when Redis is not configured. */
export const redisConfig = (): RedisConfig | null => config;

/**
 * The shared client, or `null` when Redis is not configured.
 *
 * Callers must handle `null` and must handle a rejected command: this returns a
 * connection that may be down, never a promise that it is up.
 */
export const getRedis = (): Redis | null => client;

/**
 * Error reporting that stays useful without flooding the log.
 *
 * ioredis emits `error` on every failed reconnect attempt, which for an
 * unreachable server is several lines a second for ever. So the first error is
 * logged in full and repeats of the SAME message are counted and re-logged at
 * most once a minute. Nothing is swallowed - a suppressed error is still
 * reported in the next line and in the count printed when the connection
 * recovers.
 */
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorMessage = '';
let lastErrorLoggedAt = 0;
let suppressedErrors = 0;
let downSince: number | null = null;

function reportError(error: Error): void {
  const message = error.message || String(error);
  const now = Date.now();
  const repeat = message === lastErrorMessage;

  if (repeat && now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
    suppressedErrors += 1;
    return;
  }

  logger.error('Redis connection error', {
    error: message,
    ...(suppressedErrors > 0 ? { repeatedSince: `${suppressedErrors} identical error(s) not logged` } : {}),
  });
  lastErrorMessage = message;
  lastErrorLoggedAt = now;
  suppressedErrors = 0;
}

/** Maps ioredis's own status to the small set of states the application reports. */
function stateOf(instance: Redis | null): RedisConnectionState {
  if (!instance) return 'disabled';
  switch (instance.status) {
    case 'ready':
      return 'ready';
    case 'connect':
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    default:
      // 'close', 'end', 'wait' - not connected, and not currently trying.
      return 'closed';
  }
}

/** The current connection state. Reads cached state; sends no command. */
export function redisState(): RedisState {
  const state = stateOf(client);
  return { configured: config !== null, state, ready: state === 'ready' };
}

export interface RedisPing {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * A real round trip to Redis, for a dependency check that must not take the
 * connection's word for it. Never throws, and never waits longer than
 * `timeoutMs` - a readiness probe has to answer.
 */
export async function pingRedis(timeoutMs = 1_000): Promise<RedisPing> {
  if (!client) return { ok: false, error: 'Redis is not configured' };

  const startedAt = Date.now();
  try {
    const reply = await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`Redis did not answer within ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ]);
    if (reply !== 'PONG') return { ok: false, error: `Redis answered "${reply}"` };
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** How long startup waits for a first connection before carrying on without it. */
const STARTUP_WAIT_MS = 5_000;

/**
 * Opens the shared connection, if one is configured.
 *
 * Startup waits briefly for the first handshake purely so the log line is
 * accurate, then continues REGARDLESS: a slow or absent Redis must not hold a
 * deployment hostage, and ioredis keeps retrying in the background either way.
 * This never throws and never exits the process.
 *
 * Calling it twice is a no-op, so no code path can end up with two connections.
 */
export async function connectRedis(startupWaitMs = STARTUP_WAIT_MS): Promise<RedisState> {
  if (client) return redisState();

  if (!config) {
    logger.info('Redis is not configured (REDIS_URL unset) - continuing without it');
    return redisState();
  }

  closing = false;
  client = createRedisClient(config);

  // Attached before connecting: an ioredis client with no `error` listener
  // throws the error as an unhandled event instead.
  client.on('error', (error: Error) => {
    if (closing) return;
    if (downSince === null) downSince = Date.now();
    reportError(error);
  });

  client.on('ready', () => {
    const downFor = downSince === null ? null : Date.now() - downSince;
    logger.info('Redis connected', {
      keyPrefix: config?.keyPrefix,
      tls: config?.tls,
      ...(downFor === null ? {} : { recoveredAfterMs: downFor }),
      ...(suppressedErrors > 0 ? { suppressedErrors } : {}),
    });
    downSince = null;
    suppressedErrors = 0;
    lastErrorMessage = '';
  });

  client.on('end', () => {
    if (!closing) logger.warn('Redis connection closed - it will be retried');
  });

  try {
    await Promise.race([
      client.connect(),
      new Promise<void>((resolve) => setTimeout(resolve, startupWaitMs).unref()),
    ]);
  } catch (error) {
    // Already reported by the 'error' handler; this only stops an unhandled
    // rejection from a connect that failed before the first retry.
    logger.warn('Redis was not reachable at startup - the application continues and will retry', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const state = redisState();
  if (!state.ready) {
    // Deliberately no duration: a refused connection gives up long before the
    // wait budget, so quoting it would misreport what happened.
    logger.warn(`Redis is configured but not ready yet (${state.state}) - retrying in the background`);
  }
  return state;
}

/**
 * Closes the connection on shutdown.
 *
 * `quit` lets Redis see a clean goodbye; if it does not answer promptly the
 * socket is dropped, because a shutdown must finish. Idempotent.
 */
export async function disconnectRedis(): Promise<void> {
  const instance = client;
  if (!instance) return;

  closing = true;
  client = null;

  try {
    await Promise.race([
      instance.quit(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
    ]);
  } catch {
    // A connection that was never established cannot be quit politely.
  } finally {
    instance.disconnect();
  }
}
