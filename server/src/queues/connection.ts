import type { Redis, RedisOptions } from 'ioredis';
import { createRedisClient, redisConfig, type RedisConfig } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * The Redis connection BullMQ uses.
 *
 * WHY THIS IS NOT THE PHASE 1 CLIENT. It is built from the same resolved
 * configuration - same URL, same namespace, one place that knows how to reach
 * Redis - but it cannot BE the same client, for two reasons read out of
 * BullMQ's own source rather than assumed:
 *
 *   1. BullMQ throws if the client it is handed has an ioredis `keyPrefix`
 *      ("ioredis does not support ioredis prefixes, use the prefix option
 *      instead"), because its Lua scripts address keys explicitly. The
 *      application client sets a keyPrefix by design, so the queue connection
 *      clears it and the namespace is applied through BullMQ's own `prefix`
 *      instead (see `queuePrefix`).
 *   2. A blocking connection throws unless `maxRetriesPerRequest` is null. The
 *      application client sets it to 2 on purpose, so that an ordinary command
 *      fails fast and the caller can fall back.
 *
 * So: one shared connection for every queue and worker in this process, built
 * through the Phase 1 factory with the two overrides BullMQ requires.
 *
 * HOW MANY CONNECTIONS THIS COSTS. One, plus one per worker. A worker needs a
 * connection that can block on BZPOPMIN and therefore cannot share one -
 * BullMQ handles that itself by duplicating this connection per worker
 * (`worker.js`: `blockingConnection: true`, `shared: false`). Queues are
 * non-blocking and all share this single connection.
 *
 * It is created on FIRST USE, never at import, so importing the foundation -
 * which the API process does once Phase 3 starts enqueueing - opens nothing by
 * itself, and nothing is ever opened per request.
 */

let connection: Redis | null = null;
let closing = false;

/** Thrown when the queue foundation is used without Redis configured. */
export class QueueRedisUnavailableError extends Error {
  constructor() {
    super(
      'Redis is required for queues and workers but REDIS_URL is not set. ' +
        'Set it (see .env.example) before starting the worker process or enqueueing a job.',
    );
    this.name = 'QueueRedisUnavailableError';
  }
}

/** The BullMQ-compatible options, exposed so the policy can be asserted in tests. */
export function queueConnectionOptions(): RedisOptions {
  return {
    // BullMQ refuses a prefixed client; the namespace is applied as BullMQ's `prefix`.
    keyPrefix: '',
    // Mandatory for the blocking connections workers duplicate from this one.
    maxRetriesPerRequest: null,
    // Left ON, unlike the application client: a brief reconnect should delay
    // adding a job, not reject it outright.
    enableOfflineQueue: true,
  };
}

/**
 * The shared queue connection, opened on first call.
 *
 * Throws when Redis is not configured. That is deliberate and it is the one
 * place this phase departs from the Phase 1 rule that Redis is optional: a
 * queue without Redis is not a degraded queue, it is a job that silently never
 * runs. The API keeps Phase 1's behaviour, because the API never reaches here
 * unless it is actually enqueueing something.
 */
export function queueConnection(): Redis {
  if (connection) return connection;

  const config: RedisConfig | null = redisConfig();
  if (!config) throw new QueueRedisUnavailableError();

  closing = false;
  connection = createRedisClient(config, queueConnectionOptions());

  // ioredis reports an `error` with no listener as an unhandled event. Logged
  // at warn rather than error: BullMQ surfaces the failures that matter on the
  // queue and worker objects themselves, and this fires on every reconnect.
  connection.on('error', (error: Error) => {
    if (closing) return;
    logger.warn('Queue Redis connection error', { error: error.message });
  });
  connection.on('ready', () => logger.info('Queue Redis connection ready', { prefix: config.keyPrefix }));

  return connection;
}

/** Whether the shared connection has been opened. Used by status reporting and tests. */
export const queueConnectionOpened = (): boolean => connection !== null;

/**
 * Opens the shared connection and proves it works, for a process that cannot
 * do its job without Redis.
 *
 * `queueConnection()` only CONSTRUCTS the client - it is lazy, like the Phase 1
 * client, so with no queues created yet nothing would actually dial Redis and a
 * wrong address would go unnoticed until the first job. The worker process
 * calls this instead, so a bad address is a startup failure rather than a
 * silent one.
 *
 * Rejects rather than exiting: the caller decides what an unreachable Redis
 * means for it.
 */
export async function openQueueConnection(timeoutMs = 10_000): Promise<void> {
  const client = queueConnection();

  if (client.status !== 'ready') {
    await Promise.race([
      client.status === 'wait'
        ? client.connect()
        : new Promise<void>((resolve, reject) => {
            client.once('ready', resolve);
            client.once('error', reject);
          }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`Redis did not become ready within ${timeoutMs}ms`)), timeoutMs).unref(),
      ),
    ]);
  }

  // A handshake is not proof that commands work; a round trip is.
  await client.ping();
}

/** Closes the shared connection. Idempotent. */
export async function closeQueueConnection(): Promise<void> {
  const instance = connection;
  if (!instance) return;

  closing = true;
  connection = null;

  try {
    await Promise.race([instance.quit(), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
  } catch {
    // A connection that never opened cannot be quit politely.
  } finally {
    instance.disconnect();
  }
}
