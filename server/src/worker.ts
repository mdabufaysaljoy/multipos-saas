import { connectDatabase, disconnectDatabase } from './config/db';
import { env } from './config/env';
import { redisConfig } from './config/redis';
import { logger } from './utils/logger';
import { openQueueConnection, queueStatus, shutdownQueues } from './queues';
import { registerCampaignWorker } from './queues/campaign.queue';
import { deliverCampaignBatch } from './services/sms/campaignDelivery.service';

/**
 * The background worker process.
 *
 * SEPARATE FROM THE API, DELIBERATELY. It starts no Express server, serves no
 * HTTP, and the API starts no worker - that separation is the whole point of
 * the phase. A campaign send or a 200,000-row export must not share an event
 * loop with the till that is waiting to ring up a sale.
 *
 * Run it with `npm run worker` (or `npm run worker:dev` while developing).
 * Deployment runs this as its own process, alongside the API, from the same
 * image and the same environment.
 *
 * REDIS IS REQUIRED HERE. The API treats Redis as optional and keeps working
 * without it; this process cannot. A worker with no Redis is not degraded, it
 * is a process that will never run a single job while looking perfectly
 * healthy - so it refuses to start instead.
 *
 * WHAT IT RUNS. Campaign email and SMS delivery (Phase 3). Everything else in
 * docs/INFRASTRUCTURE_ROADMAP.md §5 is still where the audit found it - the two
 * passes inside the API's `jobs/subscription.job.ts` included - and moves in a
 * later phase.
 */

/** Registers every worker this process runs. One line per migrated workload. */
function registerWorkers(): void {
  // Campaign email/SMS delivery. The processor is the same function the API
  // falls back to when no Redis is configured, so there is one implementation
  // of the sending rules.
  registerCampaignWorker(deliverCampaignBatch);
}

async function bootstrap(): Promise<void> {
  if (!redisConfig()) {
    // Not a warning: without Redis this process has no purpose, and pretending
    // otherwise would leave a job queue nobody is serving.
    logger.error('The worker process needs Redis. Set REDIS_URL (see .env.example) and start it again.');
    process.exit(1);
  }

  // Every job this will carry reads and writes the database, so it is part of
  // the worker's infrastructure rather than something each processor opens.
  await connectDatabase();

  // Opens the shared queue connection and pings it, so a Redis that is
  // configured but wrong is a startup failure rather than a worker that looks
  // healthy and never runs anything. Exiting non-zero is the honest outcome:
  // a process manager restarts it, and the failure is visible meanwhile.
  try {
    await openQueueConnection();
  } catch (error) {
    logger.error('The worker process could not reach Redis', {
      error: error instanceof Error ? error.message : String(error),
    });
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  }

  registerWorkers();

  const status = queueStatus();
  if (status.workers.length === 0) {
    logger.warn(
      'The worker process is running but NO job processors are registered, so it will not do any work. ' +
        'This is expected until Phase 3 migrates the background jobs.',
    );
  } else {
    logger.info(`Worker process ready with ${status.workers.length} worker(s)`, { workers: status.workers });
  }
  logger.info(`Worker process started (${env.NODE_ENV})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A second signal during a slow drain must not start a second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${signal} received - worker shutdown started`);
    // Stops taking new jobs and gives the active ones their grace period.
    await shutdownQueues().catch((error: unknown) =>
      logger.error('Queue shutdown failed', { error: error instanceof Error ? error.message : String(error) }),
    );
    await disconnectDatabase().catch(() => undefined);
    logger.info('Worker shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // Do not hang forever if something refuses to drain.
  process.on('SIGTERM', () => setTimeout(() => process.exit(1), 30_000).unref());
}

bootstrap().catch((error) => {
  logger.error('Failed to start the worker process', error);
  process.exit(1);
});
