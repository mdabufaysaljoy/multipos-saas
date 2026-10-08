/**
 * The BullMQ foundation: configuration, naming, connection policy and shutdown.
 *
 * WHAT THIS DOES NOT DO. It does not pretend to test BullMQ itself. BullMQ's
 * behaviour - that a job is picked up, retried on the configured backoff,
 * marked stalled, trimmed on completion - lives in Lua scripts running inside
 * a real Redis, and there is no Redis in this project's CI. Phase 1 could test
 * its connection against a protocol stub because a PING is a PING; a queue
 * cannot, and a stub answering BullMQ's scripts with plausible nonsense would
 * be a test that proves the stub, not the system. So this covers what is
 * genuinely determinable without a server - the policy this foundation applies
 * and the guards around it - and the limitation is recorded in
 * docs/IMPLEMENTATION_STATUS.md rather than papered over. The first processor
 * Phase 3 adds should be exercised against a real Redis.
 *
 * WHY TWO PROCESSES. The foundation reads its Redis configuration once, when
 * the module loads, so one process cannot test both "Redis absent" and "Redis
 * configured" - and the module state cannot be reset, because a dynamic import
 * is memoised even when `require.cache` is cleared. So the first phase runs
 * here with no Redis, then re-executes this same file as a child process with
 * REDIS_URL set, carrying the loader through `process.execArgv`.
 *
 * Run as part of `npm test` (and on its own with `npm run test:queues -w server`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Phase 1: the policy, and the guards that fire when Redis is not configured. */
async function policyPhase(): Promise<void> {
  // Forced empty rather than deleted: the server loads `.env`, and a developer
  // who has REDIS_URL set locally must not silently test the other branch.
  // The env schema maps '' to undefined, and dotenv never overwrites a value
  // that is already present.
  process.env.REDIS_URL = '';
  delete process.env.REDIS_KEY_PREFIX;

  const options = await import('./options');

  // 1. Queue naming is deterministic and validated -------------------------

  for (const good of ['messaging', 'export', 'product-import', 'media', 'a', 'a1-b2']) {
    assert.equal(options.assertQueueName(good), good, `"${good}" is a valid queue name`);
  }
  assert.equal(options.assertQueueName('  messaging  '), 'messaging', 'a name is trimmed, so one queue cannot become two');

  for (const bad of ['Messaging', 'product_import', 'product import', '-leading', 'trailing-', 'a--b', '', '1queue', 'a'.repeat(51)]) {
    assert.throws(() => options.assertQueueName(bad), /Invalid queue name/, `"${bad}" must be refused, not silently accepted`);
  }

  // 2. The key namespace is derived from Redis, not invented ---------------

  assert.equal(options.queuePrefix('retailersuites:production:'), 'retailersuites:production:bull');
  assert.notEqual(
    options.queuePrefix('retailersuites:production:'),
    options.queuePrefix('retailersuites:development:'),
    'two environments must not share a queue namespace',
  );

  // 3. Retry and retention defaults are conservative and finite ------------

  const defaults = options.DEFAULT_JOB_OPTIONS;
  assert.equal(defaults.attempts, 3, 'a job is retried a bounded number of times');
  assert.ok(
    typeof defaults.attempts === 'number' && defaults.attempts > 1 && defaults.attempts <= 5,
    'retries are neither absent nor aggressive - no future job is accidentally infinite',
  );
  assert.deepEqual(defaults.backoff, { type: 'exponential', delay: 10_000 }, 'a struggling dependency is backed off, not hammered');
  assert.deepEqual(defaults.removeOnComplete, { age: 604_800, count: 1_000 }, 'completed jobs are trimmed');
  assert.deepEqual(defaults.removeOnFail, { age: 2_592_000 }, 'failed jobs are kept for a month: the record of what did not happen');
  assert.equal(
    (defaults.removeOnFail as { count?: number }).count,
    undefined,
    'failed jobs are never trimmed by count, so a burst cannot evict the evidence',
  );
  assert.equal(options.DEFAULT_WORKER_CONCURRENCY, 1, 'concurrency is opted into, never inherited optimistically');
  assert.ok(options.SHUTDOWN_GRACE_MS > 0 && options.SHUTDOWN_GRACE_MS <= 60_000, 'shutdown waits, but not indefinitely');
  assert.match(options.PAYLOAD_POLICY, /identifier/i, 'the payload policy is stated where callers will read it');

  // 4. Without Redis the foundation refuses rather than pretends -----------

  const foundation = await import('./index');
  assert.equal(foundation.queueConnectionOpened(), false, 'importing the foundation opens no connection');
  assert.throws(() => foundation.queueConnection(), /REDIS_URL is not set/, 'a queue connection without Redis fails clearly');
  assert.throws(() => foundation.createAppQueue('messaging'), /REDIS_URL is not set/, 'so does creating a queue');
  assert.throws(
    () => foundation.createAppWorker('messaging', async () => undefined),
    /REDIS_URL is not set/,
    'and creating a worker - one with no Redis would never run a job while looking healthy',
  );
  assert.equal(foundation.queueConnectionOpened(), false, 'a refused call leaves no half-open connection behind');
  assert.deepEqual(foundation.queueStatus(), { connectionOpened: false, queues: [], workers: [] });

  // Shutting down when nothing was ever created is a no-op, not a crash.
  await foundation.shutdownQueues();
  await foundation.shutdownQueues();

  // 5. The API process does not start a worker -----------------------------

  // A source-level guard, because the real assertion - "importing the API does
  // not register a worker" - cannot be made by importing server.ts, which would
  // boot the API. This fails the moment someone wires a worker into the API,
  // which is the regression worth catching.
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  for (const file of ['server.ts', 'app.ts', 'routes/index.ts']) {
    const source = read(file);
    assert.ok(!/from '\.{1,2}\/queues/.test(source), `${file} must not import the queue foundation`);
    assert.ok(!/createAppWorker|new Worker\(/.test(source), `${file} must not create a worker`);
  }

  const workerSource = read('worker.ts');
  assert.ok(!/createApp\b|app\.listen|from '\.\/app'/.test(workerSource), 'the worker entrypoint must not start the HTTP API');
  assert.ok(/SIGTERM/.test(workerSource) && /SIGINT/.test(workerSource), 'the worker shuts down on both signals');
  assert.ok(/shutdownQueues/.test(workerSource), 'the worker drains its queues on shutdown');
  assert.ok(/process\.exit\(1\)/.test(workerSource), 'the worker exits non-zero when Redis is missing');
}

/** Phase 2: the same foundation with REDIS_URL set, in its own process. */
async function configuredPhase(): Promise<void> {
  // REDIS_URL deliberately points at a port nothing listens on, so BullMQ's own
  // internal connections emit "Connection is closed." while they are torn down -
  // after it has removed the listeners that would have caught it. That is an
  // artifact of testing configuration against an absent server, not a finding.
  // Nothing else is tolerated: any other uncaught error fails the phase.
  const tolerateUnreachableRedis = (error: unknown) => {
    if (error instanceof Error && /Connection is closed/.test(error.message)) return;
    console.error('Unexpected error in the configured phase:', error);
    process.exit(1);
  };
  process.on('uncaughtException', tolerateUnreachableRedis);
  process.on('unhandledRejection', tolerateUnreachableRedis);

  const queues = await import('./index');
  const { redisConfig } = await import('../config/redis');

  // 6. The connection follows BullMQ's requirements, from Phase 1's config --

  const policy = queues.queueConnectionOptions();
  assert.equal(policy.keyPrefix, '', 'BullMQ throws on a prefixed client, so the key prefix is cleared');
  assert.equal(policy.maxRetriesPerRequest, null, 'BullMQ requires this to be null on the blocking connections workers duplicate');
  assert.equal(policy.enableOfflineQueue, true, 'a brief reconnect should delay adding a job, not reject it');

  const config = redisConfig();
  assert.equal(config?.keyPrefix, 'queuecheck:', 'the foundation reads the shared Phase 1 configuration');
  assert.equal(config?.url, 'redis://127.0.0.1:1');
  assert.equal(queues.queuePrefix(config!.keyPrefix), 'queuecheck:bull', 'and namespaces its keys from it');

  assert.equal(queues.queueConnectionOpened(), false, 'still nothing opened by import alone');
  const connection = queues.queueConnection();
  assert.equal(connection.options.keyPrefix, '', 'the live connection carries no ioredis prefix');
  assert.equal(connection.options.maxRetriesPerRequest, null);
  assert.equal(connection.options.enableOfflineQueue, true);
  assert.ok(connection.options.lazyConnect, 'nothing connects until it is asked to');
  assert.equal(connection.options.host, '127.0.0.1', 'the connection really is built from REDIS_URL');
  assert.equal(queues.queueConnectionOpened(), true);

  // One connection, shared by every queue and worker in the process. Not one
  // per call, and nothing resembling one per request.
  assert.equal(queues.queueConnection(), connection, 'the queue connection is shared');

  // 7. Queues are created once per name ------------------------------------

  const queue = queues.createAppQueue('messaging');
  assert.equal(queue.name, 'messaging');
  assert.equal(queue.opts.prefix, 'queuecheck:bull', 'a queue is namespaced by the shared prefix');
  assert.equal(queue.opts.defaultJobOptions?.attempts, 3, 'a queue inherits the central retry policy');
  assert.deepEqual(queue.opts.defaultJobOptions?.backoff, { type: 'exponential', delay: 10_000 });
  assert.equal(queues.createAppQueue('messaging'), queue, 'a second call returns the same queue, not a second set of connections');
  assert.equal(queues.queueConnection(), connection, 'creating a queue opened no further connection');

  // An override is merged into the policy, not a replacement for it.
  const custom = queues.createAppQueue('export', { defaultJobOptions: { attempts: 5 } });
  assert.equal(custom.opts.defaultJobOptions?.attempts, 5, 'a queue can override one option deliberately');
  assert.deepEqual(custom.opts.defaultJobOptions?.backoff, { type: 'exponential', delay: 10_000 }, '...and still inherits the rest');

  assert.deepEqual(queues.queueStatus().queues, ['export', 'messaging'], 'the registry knows what this process holds');
  assert.deepEqual(queues.queueStatus().workers, [], 'creating a queue starts no worker');

  // 8. Workers take a processor, concurrency and options -------------------

  // `autorun: false` so no run loop starts against a Redis that is not there:
  // this asserts configuration, not BullMQ's runtime.
  const worker = queues.createAppWorker('messaging', async () => undefined, { concurrency: 4, autorun: false });
  assert.equal(worker.name, 'messaging', 'a worker is named for its queue');
  assert.equal(worker.opts.concurrency, 4, 'concurrency is configurable');
  assert.equal(worker.opts.prefix, 'queuecheck:bull', 'a worker reads the same namespace as its queue');
  assert.equal(queues.createAppWorker('messaging', async () => undefined), worker, 'a second call returns the same worker');
  assert.deepEqual(queues.queueStatus().workers, ['messaging']);

  const defaulted = queues.createAppWorker('export', async () => undefined, { autorun: false });
  assert.equal(defaulted.opts.concurrency, 1, 'a worker that says nothing gets the conservative default');

  // 9. Shutdown is complete, bounded and idempotent ------------------------

  await Promise.race([
    queues.shutdownQueues(250),
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('shutdownQueues did not finish')), 20_000).unref()),
  ]);

  assert.deepEqual(queues.queueStatus(), { connectionOpened: false, queues: [], workers: [] }, 'shutdown releases everything');
  await queues.shutdownQueues(250);
}

async function main(): Promise<void> {
  if (process.env.QUEUE_CHECK_PHASE === 'configured') {
    await configuredPhase();
    return;
  }

  await policyPhase();

  // `process.execArgv` carries the TypeScript loader, so the child runs this
  // file the same way the parent was run.
  const child = spawnSync(process.execPath, [...process.execArgv, __filename], {
    env: {
      ...process.env,
      QUEUE_CHECK_PHASE: 'configured',
      // A port nothing listens on: enough to build and inspect the objects
      // without claiming anything about BullMQ's behaviour against a server.
      REDIS_URL: 'redis://127.0.0.1:1',
      REDIS_KEY_PREFIX: 'queuecheck',
    },
    stdio: 'inherit',
  });
  assert.equal(child.status, 0, 'the configured-Redis phase must pass');

  console.log(
    'BullMQ foundation: naming, retry policy, key namespace, Redis guards, API/worker separation, shared connection, factories and shutdown passed.',
  );
}

main().catch((error) => {
  console.error('BullMQ foundation check crashed:', error);
  process.exit(1);
});
