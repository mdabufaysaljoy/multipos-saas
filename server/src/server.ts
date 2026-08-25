import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/db';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startSubscriptionJobs, stopSubscriptionJobs } from './jobs/subscription.job';

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  startSubscriptionJobs();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received - shutting down`);
    stopSubscriptionJobs();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logger.error('Failed to start the server', error);
  process.exit(1);
});
