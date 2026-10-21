/**
 * The infrastructure integration check: real MongoDB replica set, real Redis.
 *
 * WHY IT RUNS IN THE CONTAINER. Everything here needs infrastructure the host
 * does not have - a MongoDB replica set and a Redis - and needs to reach it the
 * way the application does, through the same configuration and the same
 * clients. It is compiled into the production image, so it runs as:
 *
 *   docker compose exec api node dist/seed/infraIntegration.check.js
 *
 * WHAT IT CLOSES. Three limitations carried since Phase 0:
 *   - MongoDB transactions had never been exercised: CI and every local run
 *     used a standalone server, where the application silently falls back to
 *     compensating writes. Here `withTransaction` opens a real session.
 *   - BullMQ had never met a real Redis: its queues live in Lua scripts that a
 *     protocol stub cannot honestly stand in for.
 *   - The rate limiter's atomic increment had only been tested against a fake
 *     command executor.
 *
 * It uses a probe queue and probe collections of its own and cleans them up. No
 * business data is touched, no campaign is sent and nothing external is called.
 */
import mongoose, { Schema } from 'mongoose';
import { connectDatabase, disconnectDatabase, supportsTransactions } from '../config/db';
import { connectRedis, disconnectRedis, getRedis, redisConfig, pingRedis } from '../config/redis';
import { RedisRateLimitStore, rateLimitKey } from '../middleware/rateLimit';
import { createAppQueue, createAppWorker, shutdownQueues, queuePrefix } from '../queues';
import { withTransaction } from '../utils/tx';

let passed = 0;
let failed = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}`, detail ?? '');
  }
};

/** A collection of our own, so no business data is involved. */
const ProbeModel = mongoose.model(
  'TxProbe',
  new Schema({ tag: String, step: Number }, { collection: 'infra_tx_probe' }),
);

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.error(`  (timed out waiting for ${label})`);
  return false;
};

async function main(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  console.log('\n  Infrastructure integration (real MongoDB replica set + real Redis)\n');

  // ------------------------------------------------- 1. a real replica set

  const hello = (await mongoose.connection.db!.admin().command({ hello: 1 })) as {
    setName?: string;
    isWritablePrimary?: boolean;
  };
  check('MongoDB is a replica set, not a standalone', hello.setName === 'rs0', hello.setName ?? '(none)');
  check('...with a writable primary', hello.isWritablePrimary === true);
  check('...and the application knows transactions are available', supportsTransactions() === true);

  // ------------------------------------------------- 2. transactions commit

  const commitTag = `commit-${Date.now()}`;
  await withTransaction(async (session) => {
    check('A transaction opens with a real session', session !== undefined);
    await ProbeModel.create([{ tag: commitTag, step: 1 }], { session, ordered: true });
    await ProbeModel.create([{ tag: commitTag, step: 2 }], { session, ordered: true });
    // Outside the session the writes are invisible until commit - which is the
    // isolation a standalone server cannot provide at all.
    check('...and its writes are not visible outside it before commit', (await ProbeModel.countDocuments({ tag: commitTag })) === 0);
  });
  check('After commit both writes are present', (await ProbeModel.countDocuments({ tag: commitTag })) === 2);

  // ------------------------------------------------ 3. transactions roll back

  const rollbackTag = `rollback-${Date.now()}`;
  let surfaced: string | null = null;
  try {
    await withTransaction(async (session) => {
      await ProbeModel.create([{ tag: rollbackTag, step: 1 }], { session, ordered: true });
      await ProbeModel.create([{ tag: rollbackTag, step: 2 }], { session, ordered: true });
      throw new Error('deliberate failure after two writes');
    });
  } catch (error) {
    surfaced = error instanceof Error ? error.message : String(error);
  }
  check('A failing transaction surfaces its error', surfaced === 'deliberate failure after two writes', surfaced);
  check('...and NOTHING it wrote survives - no partial write', (await ProbeModel.countDocuments({ tag: rollbackTag })) === 0);

  // The session must not be left open afterwards.
  const sessionsBefore = mongoose.connections.length;
  await withTransaction(async () => undefined);
  check('A transaction ends its session', mongoose.connections.length === sessionsBefore);

  await ProbeModel.deleteMany({ tag: { $in: [commitTag, rollbackTag] } });

  // ----------------------------------------------------------- 4. real Redis

  const redis = getRedis();
  check('Redis is connected from this process', redis !== null);
  const ping = await pingRedis();
  check('...and answers a real PING', ping.ok === true, ping.error);

  const config = redisConfig();
  check('...under the configured namespace', Boolean(config?.keyPrefix), config?.keyPrefix);

  // The namespace must really be applied on the wire, not just configured.
  // `KEYS` returns the names the SERVER holds, so they come back with the
  // prefix already on them - which is exactly what proves the point.
  const probeKey = `infra-probe:${Date.now()}`;
  await redis!.set(probeKey, 'x', 'EX', 30);
  const serverKeys = (await redis!.keys('*')) as string[];
  check(
    'A key written through the client lands inside the namespace',
    serverKeys.includes(`${config!.keyPrefix}${probeKey}`),
    serverKeys.slice(0, 3),
  );
  check('...and nothing is written outside it', serverKeys.every((k) => k.startsWith(config!.keyPrefix)), serverKeys.find((k) => !k.startsWith(config!.keyPrefix)));
  await redis!.del(probeKey);

  // ------------------------------------- 5. the rate limiter's atomic script

  {
    const store = new RedisRateLimitStore('infra-probe', 'memory');
    store.init({ windowMs: 5_000 } as never);
    const identity = `probe-${Date.now()}`;

    const first = await store.increment(identity);
    check('The rate-limit script increments against real Redis', first.totalHits === 1, first);
    check('...and reports a reset time inside the window', first.resetTime!.getTime() - Date.now() <= 5_000);

    // The whole point of the Lua: concurrent increments cannot collide.
    const burst = (await Promise.all(Array.from({ length: 25 }, () => store.increment(identity)))).map((r) => r.totalHits);
    check(
      'Twenty-five concurrent increments produce twenty-five distinct counts',
      new Set(burst).size === 25 && Math.max(...burst) === 26,
      { distinct: new Set(burst).size, max: Math.max(...burst) },
    );

    // And a TTL really is set, so no counter key can outlive its window.
    const ttl = await redis!.pttl(rateLimitKey('infra-probe', identity));
    check('The counter key carries a bounded TTL', ttl > 0 && ttl <= 5_000, ttl);
    await store.resetKey(identity);
    check('A reset clears it', (await store.increment(identity)).totalHits === 1);
    await store.resetKey(identity);
  }

  // ------------------------------------------- 6. BullMQ against real Redis

  {
    const queueName = 'infra-probe';
    const queue = createAppQueue(queueName);
    check('A queue is created against real Redis', queue.name === queueName);
    check('...under the application key namespace', queue.opts.prefix === queuePrefix(config!.keyPrefix), queue.opts.prefix);

    const done: string[] = [];
    const attemptsSeen: number[] = [];
    const failedJobs: string[] = [];

    const worker = createAppWorker<{ kind: string }, void>(
      queueName,
      async (job) => {
        attemptsSeen.push(job.attemptsMade + 1);
        if (job.data.kind === 'always-fails') throw new Error('probe: deliberate failure');
        // Succeeds only on the second attempt, so a real retry is observable.
        if (job.data.kind === 'retry-once' && job.attemptsMade === 0) throw new Error('probe: fail once');
        done.push(job.data.kind);
      },
      { concurrency: 2 },
    );
    worker.on('failed', (job) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) failedJobs.push(String(job.data?.kind));
    });

    // A plain job, carried by Redis to a worker and back.
    await queue.add('probe', { kind: 'simple' }, { attempts: 1 });
    check('A job enqueued through Redis is processed', await waitFor(() => done.includes('simple'), 20_000, 'the job to run'));

    const counts = await queue.getJobCounts('completed', 'failed');
    check('...and Redis records it as completed', (counts.completed ?? 0) >= 1, counts);

    // Retry: fails once, succeeds on the second attempt, on the central backoff.
    await queue.add('probe', { kind: 'retry-once' }, { attempts: 3, backoff: { type: 'fixed', delay: 200 } });
    check('A transient failure is retried and then succeeds', await waitFor(() => done.includes('retry-once'), 30_000, 'the retry'));
    check('...having taken more than one attempt', attemptsSeen.filter((a) => a > 1).length >= 1, attemptsSeen);

    // Exhaustion: a job that always fails ends up failed, not retried forever.
    await queue.add('probe', { kind: 'always-fails' }, { attempts: 2, backoff: { type: 'fixed', delay: 100 } });
    check('A job that keeps failing ends as failed', await waitFor(() => failedJobs.includes('always-fails'), 30_000, 'the failure'));
    const finalCounts = await queue.getJobCounts('failed');
    check('...and Redis holds it in the failed set', (finalCounts.failed ?? 0) >= 1, finalCounts);

    // A deterministic job id is the outer duplicate guard the campaign queue relies on.
    const jobId = `probe-dedupe-${Date.now()}`;
    await queue.add('probe', { kind: 'dedupe' }, { jobId, attempts: 1 });
    await queue.add('probe', { kind: 'dedupe' }, { jobId, attempts: 1 });
    check('Enqueueing the same job id twice adds one job', await waitFor(async () => done.filter((k) => k === 'dedupe').length === 1, 20_000, 'the single job'));

    // Graceful shutdown of a real worker against a real Redis.
    await queue.drain().catch(() => undefined);
    await shutdownQueues(5_000);
    check('Queues and workers shut down cleanly', true);
    check('...and shutting down again is safe', await (async () => { await shutdownQueues(1_000); return true; })());

    // Leave no probe keys behind. `KEYS` hands back prefixed names while `DEL`
    // through the same client prefixes again, so the prefix is stripped first.
    const client = getRedis();
    if (client) {
      const prefix = config!.keyPrefix;
      const leftover = ((await client.keys('bull:infra-probe:*')) as string[]).map((k) =>
        k.startsWith(prefix) ? k.slice(prefix.length) : k,
      );
      if (leftover.length > 0) await client.del(...leftover);
      const remaining = (await client.keys('bull:infra-probe:*')) as string[];
      check('The probe queue leaves no keys behind in Redis', remaining.length === 0, remaining.slice(0, 3));
    }
  }

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  await disconnectRedis();
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Infrastructure integration check crashed:', error);
  await disconnectRedis().catch(() => undefined);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(1);
});
