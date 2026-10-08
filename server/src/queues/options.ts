import type { JobsOptions } from 'bullmq';

/**
 * Centralised queue policy: names, retry behaviour and the payload rules.
 *
 * Everything here is pure data and plain functions, so the policy can be read
 * and tested without a Redis server anywhere near it.
 */

/**
 * QUEUE NAMING CONVENTION
 *
 * Lowercase kebab-case, a singular domain noun, no environment and no tenant in
 * the name - environments are separated by the key namespace (see `queuePrefix`)
 * and a queue is never per tenant. Validated rather than merely documented, so
 * a typo fails at the call site instead of quietly creating a second queue that
 * no worker is listening to.
 *
 * The queues Phase 3 is expected to add are `scheduled`, `messaging`, `export`,
 * `import` and `media` (docs/INFRASTRUCTURE_ROADMAP.md §4). None of them exist
 * yet: this phase is the foundation only.
 */
const QUEUE_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_QUEUE_NAME_LENGTH = 50;

export function assertQueueName(name: string): string {
  const trimmed = name.trim();
  if (!QUEUE_NAME_PATTERN.test(trimmed) || trimmed.length > MAX_QUEUE_NAME_LENGTH) {
    throw new Error(
      `Invalid queue name "${name}". Use lowercase kebab-case, 1-${MAX_QUEUE_NAME_LENGTH} characters, e.g. "messaging" or "product-import".`,
    );
  }
  return trimmed;
}

/**
 * The BullMQ key prefix, derived from the Redis namespace so every key this
 * application writes - cache or queue - lives under one root and two
 * environments sharing a Redis cannot see each other's jobs.
 *
 * BullMQ needs this because it refuses an ioredis `keyPrefix` outright: its Lua
 * scripts address keys explicitly, so prefixing happens here instead.
 */
export const queuePrefix = (redisKeyPrefix: string): string => `${redisKeyPrefix}bull`;

const SECONDS = 1;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;
const DAYS = 24 * HOURS;

/**
 * Default job options for every queue.
 *
 * Deliberately conservative, and deliberately NOT infinite:
 *
 *   - `attempts: 3` - enough to ride out a brief gateway or network failure,
 *     few enough that a job which is genuinely broken stops rather than
 *     hammering a third party for ever. A queue whose work needs more says so
 *     explicitly when it is created.
 *   - exponential backoff from 10s (10s, 20s, 40s), so a struggling dependency
 *     is given room instead of being retried into the ground.
 *   - completed jobs are kept briefly, for a week or the last thousand,
 *     whichever is smaller - long enough to answer "did that run?".
 *   - FAILED jobs are kept for a month and never trimmed by count, because a
 *     failed job is the record of something that did not happen. Losing it
 *     means losing the only evidence.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 7 * DAYS, count: 1_000 },
  removeOnFail: { age: 30 * DAYS },
};

/**
 * Default worker concurrency: one job at a time.
 *
 * One is the right default because the work this will carry is not uniform -
 * image optimisation is CPU-bound and must stay low, campaign sending is
 * bounded by a gateway's own limits, not ours. Each worker chooses its own
 * number knowingly rather than inheriting an optimistic one.
 */
export const DEFAULT_WORKER_CONCURRENCY = 1;

/** How long a graceful shutdown lets active jobs finish before they are abandoned. */
export const SHUTDOWN_GRACE_MS = 15_000;

/**
 * PAYLOAD POLICY - read before adding a job.
 *
 * A job payload is stored in Redis, in plain text, until the job is trimmed. So:
 *
 *   1. Pass IDENTIFIERS, not documents. `{ saleId, tenantId }`, never the sale
 *      itself. The processor re-reads from MongoDB, which is also the only way
 *      it can be sure it is acting on current data rather than on a snapshot
 *      taken minutes ago.
 *   2. NEVER put a secret in a payload - no gateway key, no SMTP password, no
 *      token, no card detail. Credentials live in platform settings and are
 *      read by the processor.
 *   3. Keep personal data out of it where an id will do. A payload is a second
 *      copy of that data, in a different store, with a different lifetime.
 *   4. Payloads must stay small. Redis holds them in memory, and a queue of
 *      large payloads is a memory problem long before it is a throughput one.
 */
export const PAYLOAD_POLICY =
  'Queue payloads carry identifiers, never documents, secrets or unnecessary personal data.';
