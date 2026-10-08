import type { Job, Queue, Worker } from 'bullmq';
import { redisConfig } from '../config/redis';
import { logger } from '../utils/logger';
import { createAppQueue, createAppWorker } from './index';
import type { CampaignJobData } from '../services/sms/campaignDelivery.service';

/**
 * The campaign delivery queue: the first workload moved off the request path.
 *
 * One job per bounded batch of recipients. The payload is three identifiers and
 * nothing else - no recipient list, no message body, no credentials - because
 * everything a job needs is already durable in MongoDB, and a payload sits in
 * Redis in plain text until it is trimmed.
 *
 * The job id is derived from the campaign and the batch, so enqueueing the same
 * batch twice is a no-op in BullMQ rather than a second delivery pass. That is
 * the outer layer of duplicate protection; the inner one is the per-recipient
 * claim in `campaignDelivery.service.ts`, which is what actually makes a retry
 * safe.
 */
export const CAMPAIGN_QUEUE = 'campaign-delivery';

/** Deterministic, so a repeated enqueue of the same batch is ignored. */
export const campaignJobId = (campaignId: string, batchIndex: number) => `campaign:${campaignId}:batch:${batchIndex}`;

/** True when a queue can be used at all. Redis is optional for the API. */
export const campaignQueueAvailable = (): boolean => redisConfig() !== null;

export const campaignQueue = (): Queue<CampaignJobData> => createAppQueue(CAMPAIGN_QUEUE) as Queue<CampaignJobData>;

/**
 * Enqueues every batch of a campaign.
 *
 * Rejects if the queue cannot be reached, so the caller can refuse to report a
 * campaign as queued when it is not - see `sms.service.ts`.
 */
export async function enqueueCampaignBatches(input: {
  campaignId: string;
  tenantId: string;
  batchIndexes: number[];
}): Promise<void> {
  const queue = campaignQueue();
  await queue.addBulk(
    input.batchIndexes.map((batchIndex) => ({
      name: 'deliver-batch',
      data: { campaignId: input.campaignId, tenantId: input.tenantId, batchIndex },
      opts: { jobId: campaignJobId(input.campaignId, batchIndex) },
    })),
  );
}

/**
 * Registers the delivery worker. Called only from the worker process.
 *
 * Concurrency is ONE. The implementation it replaces sent one message at a
 * time, the gateways' own limits are not documented in this codebase, and the
 * first migration's job is to be correct rather than fast. Raising it is a
 * one-line change here once a provider limit is actually known - the delivery
 * code needs no change, because batches are disjoint by `batchIndex` and every
 * recipient is claimed before it is attempted.
 */
export type CampaignDeliver = (
  data: CampaignJobData,
  options: { lastAttempt: boolean },
) => Promise<{ sent: number; failed: number; deferred: number }>;

/** The minimum of a BullMQ job this processor reads. Narrowed so it is testable. */
export interface CampaignJobView {
  data: CampaignJobData;
  attemptsMade: number;
  opts: { attempts?: number | undefined };
}

/**
 * What the worker does with one job.
 *
 * Separated from `createAppWorker` so the two decisions it makes - whether this
 * is the final attempt, and whether to hand the batch back to BullMQ - can be
 * tested without a Redis server. Everything else about the job is BullMQ's.
 */
export async function processCampaignJob(job: CampaignJobView, deliver: CampaignDeliver): Promise<void> {
  const attempts = job.opts.attempts ?? 1;
  // `attemptsMade` counts the attempts BEFORE this one, so this is the last
  // when no further attempt is left after it.
  const lastAttempt = job.attemptsMade + 1 >= attempts;

  const result = await deliver(job.data, { lastAttempt });

  logger.info('Campaign batch processed', {
    campaignId: job.data.campaignId,
    batch: job.data.batchIndex,
    attempt: job.attemptsMade + 1,
    ...result,
  });

  // Transient failures are left pending on purpose: throwing hands the batch
  // back to BullMQ, which retries it on the central backoff with the
  // already-delivered recipients skipped. On the final attempt the delivery
  // code has already recorded them as permanent, so there is nothing left to
  // retry and the batch ends quietly rather than failing the job for ever.
  if (result.deferred > 0) {
    throw new Error(`${result.deferred} recipient(s) in batch ${job.data.batchIndex} failed transiently and will be retried`);
  }
}

export function registerCampaignWorker(deliver: CampaignDeliver): Worker<CampaignJobData> {
  return createAppWorker<CampaignJobData, void>(
    CAMPAIGN_QUEUE,
    (job: Job<CampaignJobData>) => processCampaignJob(job, deliver),
    { concurrency: 1 },
  );
}
