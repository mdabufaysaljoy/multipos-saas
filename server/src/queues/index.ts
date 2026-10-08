import { Queue, Worker, type JobsOptions, type Processor, type QueueOptions, type WorkerOptions } from 'bullmq';
import { redisConfig } from '../config/redis';
import { logger } from '../utils/logger';
import {
  closeQueueConnection,
  queueConnection,
  queueConnectionOpened,
  QueueRedisUnavailableError,
} from './connection';
import {
  assertQueueName,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_CONCURRENCY,
  queuePrefix,
  SHUTDOWN_GRACE_MS,
} from './options';

/**
 * The queue foundation: one place that knows how to make a queue and a worker.
 *
 * The point is that a feature never configures BullMQ or Redis for itself:
 *
 *     const queue = createAppQueue('messaging');
 *     await queue.add('campaign', { campaignId });      // ids, never documents
 *
 *     createAppWorker('messaging', async (job) => { ... }, { concurrency: 4 });
 *
 * Retry policy, backoff, job retention, the key namespace and the connection
 * all come from `options.ts` and `connection.ts`, so changing them is one edit
 * rather than a search. A queue that needs different behaviour overrides it at
 * the call site, visibly.
 *
 * NO QUEUE AND NO WORKER IS DEFINED HERE. Phase 2 is the foundation; Phase 3
 * migrates the background-job candidates listed in
 * docs/INFRASTRUCTURE_ROADMAP.md §5 onto it. The existing in-process
 * subscription scheduler is untouched and still runs in the API.
 *
 * Read the payload policy in `options.ts` before adding a job.
 */

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

/** Options shared by every queue and worker: the connection and the namespace. */
function sharedOptions(): { connection: ReturnType<typeof queueConnection>; prefix: string } {
  const config = redisConfig();
  if (!config) throw new QueueRedisUnavailableError();
  return { connection: queueConnection(), prefix: queuePrefix(config.keyPrefix) };
}

/**
 * A queue, created once per name in this process.
 *
 * Calling this twice for the same name returns the SAME queue: a second
 * instance would be a second set of connections and event listeners for no
 * gain. Nothing here is per request.
 */
export function createAppQueue(name: string, overrides: Partial<QueueOptions> = {}): Queue {
  const queueName = assertQueueName(name);
  const existing = queues.get(queueName);
  if (existing) return existing;

  const { defaultJobOptions: jobOverrides, ...queueOverrides } = overrides;
  const shared = sharedOptions();
  const queue = new Queue(queueName, {
    ...shared,
    ...queueOverrides,
    // Merged, not replaced: a queue that overrides `attempts` still inherits
    // the retention and backoff policy.
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...jobOverrides },
  });

  // Without a listener BullMQ re-throws connection problems as unhandled errors.
  queue.on('error', (error: Error) => logger.warn(`Queue "${queueName}" error`, { error: error.message }));

  queues.set(queueName, queue);
  logger.info(`Queue "${queueName}" ready`, { prefix: shared.prefix });
  return queue;
}

/** The default job options a queue would be created with. Exposed for tests and for review. */
export const defaultJobOptions = (overrides: JobsOptions = {}): JobsOptions => ({ ...DEFAULT_JOB_OPTIONS, ...overrides });

/**
 * A worker for a queue, created once per name in this process.
 *
 * Lifecycle events are logged at the level they deserve: a failure and a stall
 * are worth a line each, a completion is not - a worker doing its job should be
 * quiet, or the log becomes unreadable at the first busy hour and useless at
 * the moment it is needed.
 */
export function createAppWorker<DataType = unknown, ResultType = unknown>(
  name: string,
  processor: Processor<DataType, ResultType>,
  overrides: Partial<WorkerOptions> = {},
): Worker<DataType, ResultType> {
  const queueName = assertQueueName(name);
  const existing = workers.get(queueName);
  if (existing) return existing as Worker<DataType, ResultType>;

  const shared = sharedOptions();
  const worker = new Worker<DataType, ResultType>(queueName, processor, {
    ...shared,
    concurrency: DEFAULT_WORKER_CONCURRENCY,
    ...overrides,
    // BullMQ appends this to the name of the blocking connection it duplicates,
    // so `CLIENT LIST` on the Redis server says which worker is holding it.
    name: queueName,
  });

  worker.on('failed', (job, error) =>
    logger.error(`Job failed on "${queueName}"`, {
      jobId: job?.id,
      jobName: job?.name,
      attempts: job?.attemptsMade,
      error: error?.message,
    }),
  );
  worker.on('stalled', (jobId) => logger.warn(`Job stalled on "${queueName}"`, { jobId }));
  worker.on('error', (error: Error) => logger.warn(`Worker "${queueName}" error`, { error: error.message }));
  // A completed job is deliberately logged at debug: suppressed in production.
  worker.on('completed', (job) => logger.debug(`Job completed on "${queueName}"`, { jobId: job?.id }));

  workers.set(queueName, worker);
  logger.info(`Worker "${queueName}" registered`, {
    concurrency: overrides.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
    prefix: shared.prefix,
  });
  return worker;
}

/** How long a forced close is given before the shutdown moves on regardless. */
const CLOSE_TIMEOUT_MS = 2_000;

/** Resolves when `work` does, or after `ms` - whichever comes first. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  // The rejection is attached here so a late failure cannot surface as an
  // unhandled rejection after the race has already been decided.
  const settled = work.catch((error: unknown) => {
    throw error;
  });
  return Promise.race([settled, new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), ms).unref())]);
}

/**
 * Closes one worker: graceful first, then forcibly, then gives up.
 *
 * `worker.close()` waits for the jobs already in hand, which is what we want -
 * but it must not be awaited unconditionally. A worker whose Redis connection
 * has gone can leave that promise pending for ever, and a shutdown that never
 * finishes is a deployment that hangs until something kills it. So each stage
 * is bounded, and the last stage is "stop waiting".
 */
async function closeWorker(worker: Worker, graceMs: number): Promise<void> {
  try {
    if ((await bounded(worker.close(), graceMs)) !== 'timed-out') return;
  } catch (error) {
    logger.warn('A worker did not close cleanly', { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  logger.warn(`A worker still had active jobs after ${graceMs}ms and is being stopped`);
  try {
    await bounded(worker.close(true), CLOSE_TIMEOUT_MS);
  } catch (error) {
    logger.warn('A worker could not be stopped cleanly', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** What this process currently holds. For logging and future status reporting. */
export const queueStatus = () => ({
  connectionOpened: queueConnectionOpened(),
  queues: [...queues.keys()].sort(),
  workers: [...workers.keys()].sort(),
});

/**
 * Stops every worker and queue in this process, then closes the connection.
 *
 * A worker is closed gracefully: it stops taking new jobs and is given
 * `graceMs` for the jobs it already has. Past that it is closed forcibly,
 * because a shutdown that waits indefinitely is a deployment that never
 * finishes - an abandoned job is left for its stalled check to pick up, which
 * is exactly what that mechanism is for.
 *
 * Idempotent, and safe to call when nothing was ever created.
 */
export async function shutdownQueues(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
  const openWorkers = [...workers.values()];
  const openQueues = [...queues.values()];
  workers.clear();
  queues.clear();

  if (openWorkers.length > 0 || openQueues.length > 0) {
    logger.info('Queue shutdown started', { workers: openWorkers.length, queues: openQueues.length });
  }

  await Promise.all(openWorkers.map((worker) => closeWorker(worker, graceMs)));

  await Promise.all(
    openQueues.map((queue) =>
      // Bounded for the same reason as the workers: a close against a
      // connection that is already gone can simply never settle.
      bounded(queue.close(), CLOSE_TIMEOUT_MS).catch((error: unknown) => {
        logger.warn('A queue did not close cleanly', { error: error instanceof Error ? error.message : String(error) });
      }),
    ),
  );

  await closeQueueConnection();
}

export { assertQueueName, DEFAULT_JOB_OPTIONS, DEFAULT_WORKER_CONCURRENCY, PAYLOAD_POLICY, queuePrefix, SHUTDOWN_GRACE_MS } from './options';
export {
  QueueRedisUnavailableError,
  openQueueConnection,
  queueConnection,
  queueConnectionOptions,
  queueConnectionOpened,
} from './connection';
