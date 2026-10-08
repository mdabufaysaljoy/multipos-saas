import { Types } from 'mongoose';
import {
  MAX_DELIVERY_ATTEMPTS,
  SmsCampaignModel,
  SmsMessageModel,
  type DeliveryFailureKind,
  type SmsMessageDoc,
} from '../../models/SmsMessage';
import { htmlToPlainText } from '../../utils/sanitizeEmailHtml';
import { logger } from '../../utils/logger';
import { usageChargeService } from '../billing/usageCharge.service';
import { emailService } from '../email';
import { smsRegistry } from './registry';

/**
 * Campaign delivery: the part that actually sends, and the only part of it.
 *
 * WHY THIS FILE EXISTS. Delivery used to run inside the HTTP request, looping
 * over as many as 5,000 recipients sequentially while the caller waited. It now
 * runs in the background worker. This module is the single implementation of
 * the work itself, so there is one copy of the rules whether it is invoked by a
 * BullMQ job or - when no Redis is configured, which Phase 1 deliberately
 * allows - inline by the API as a fallback. One implementation, two ways of
 * reaching it; never two implementations.
 *
 * WHAT IS DURABLE. Everything. The recipient list is rows in MongoDB, written
 * before the work is enqueued, so a job payload carries only ids and a worker
 * restart continues from the database rather than from memory. Each recipient
 * is claimed with a lease before it is attempted, so the same recipient is
 * never attempted twice at once, and a worker that dies leaves claims that
 * expire rather than rows stuck in limbo.
 *
 * WHAT CANNOT BE GUARANTEED. Exactly-once EXTERNAL delivery. If a gateway
 * accepts a message and this process dies before the row is updated, the claim
 * eventually expires and the recipient is attempted again - the person gets the
 * message twice. Closing that would need provider-level idempotency keys, which
 * neither the SMS gateway nor SMTP offers here. So the design is at-least-once
 * with durable duplicate protection either side of the single unprotected
 * instant, and that instant is narrow: one row update immediately after one
 * send. The money is not exposed to it, because a campaign is charged once up
 * front and reconciled once at the end.
 *
 * TENANCY. The worker runs outside any HTTP request, so `resolveTenant` has not
 * run and nothing may be inferred from a session. Every query below is scoped
 * by `tenantId`, taken from the job and matched against the campaign itself; a
 * campaign id alone is never trusted to be sufficient.
 */

/**
 * Recipients per background job.
 *
 * Chosen from what the sends actually cost: delivery is sequential, one gateway
 * call at a time (see `concurrency` below), and a call takes a few hundred
 * milliseconds, so 100 recipients is roughly half a minute of work. Short
 * enough that a crash or a redeploy loses little and a retry repeats little;
 * long enough that a 5,000-recipient campaign is 50 jobs rather than 5,000.
 */
export const CAMPAIGN_BATCH_SIZE = 100;

/** How long a claimed recipient stays claimed before another worker may retry it. */
const CLAIM_LEASE_MS = 2 * 60 * 1000;

export interface CampaignJobData {
  campaignId: string;
  tenantId: string;
  batchIndex: number;
}

export interface BatchOutcome {
  /** Recipients this pass delivered. */
  sent: number;
  /** Recipients this pass failed permanently. */
  failed: number;
  /** Recipients this pass failed transiently and left for another attempt. */
  deferred: number;
  /** True when the campaign reached a terminal state during this pass. */
  finalized: boolean;
}

/**
 * Decides whether a failure is worth another attempt.
 *
 * Conservative by design: anything unrecognised is treated as TRANSIENT, so a
 * gateway phrase nobody anticipated does not throw away a message that would
 * have gone out on the next try. That is safe only because attempts are
 * bounded - `MAX_DELIVERY_ATTEMPTS` per recipient, and a bounded number of job
 * attempts above that - so "retry" can never mean "retry for ever".
 *
 * Permanent means retrying cannot help: the recipient is not a real address,
 * the gateway refused the content, or the account is not configured. An
 * operator has to change something, and hammering the gateway until they do
 * damages the sender reputation this platform shares across tenants.
 */
const PERMANENT_FAILURE_PATTERNS = [
  /invalid (recipient|number|phone|address|destination|email)/i,
  /(recipient|number|address|mailbox).{0,20}(not found|does not exist|unknown|rejected|blocked|blacklist)/i,
  /no such (user|mailbox|recipient)/i,
  /unsubscrib/i,
  /(malformed|invalid) (message|content|body|sender)/i,
  /(authentication|authorisation|authorization) (failed|error)/i,
  /(invalid|missing|expired) (api[- ]?key|credential|token)/i,
  // ...and the same thing said the other way round ("the API key is invalid").
  /(api[- ]?key|credential|token).{0,24}(invalid|expired|missing|rejected|wrong)/i,
  /not configured/i,
  // "No SMS gateway is configured", "No email provider is configured".
  /\bno\b.{0,40}\bis configured\b/i,
  /insufficient (balance|credit|fund)/i,
  /\b5\.[157]\.\d+\b/, // SMTP permanent: bad mailbox, policy rejection, message rejected.
  /\b(550|551|552|553|554)\b/,
];

export function classifyDeliveryFailure(error: string | null | undefined): DeliveryFailureKind {
  const text = (error ?? '').trim();
  if (text.length === 0) return 'transient';
  return PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text)) ? 'permanent' : 'transient';
}

/** Provider errors can echo credentials; keep what is stored short and clean. */
const safeError = (value: unknown): string =>
  String(value instanceof Error ? value.message : (value ?? 'Delivery failed'))
    .replace(/(pass(word)?|pwd|auth|token|key|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);

type ClaimedRow = SmsMessageDoc & { _id: Types.ObjectId };

/**
 * Claims the next recipient in this batch that still needs attempting.
 *
 * A single atomic `findOneAndUpdate` is the whole duplicate-protection
 * mechanism: two workers handed the same batch cannot both claim the same row,
 * and a row already `sent` is not a candidate at all, so a retried job skips
 * what already went out instead of sending it again.
 *
 * Claimable means: never attempted, or a transient failure with attempts left,
 * or a claim whose lease has expired because the worker holding it died.
 */
async function claimNext(
  campaignId: Types.ObjectId,
  tenantId: Types.ObjectId,
  batchIndex: number,
  handled: Types.ObjectId[],
): Promise<ClaimedRow | null> {
  const now = new Date();
  return SmsMessageModel.findOneAndUpdate(
    {
      // Tenant scope on every read, because no middleware has run here.
      tenantId,
      campaignId,
      batchIndex,
      attempts: { $lt: MAX_DELIVERY_ATTEMPTS },
      // At most one attempt per recipient per pass. Without this a recipient
      // that fails transiently is instantly claimable again and the loop below
      // burns through its attempts in a few milliseconds - which is the
      // opposite of a retry, since the whole point is to try again LATER, on
      // the queue's backoff.
      ...(handled.length > 0 ? { _id: { $nin: handled } } : {}),
      $or: [
        { status: 'queued' },
        { status: 'failed', failureKind: 'transient' },
        { status: 'sending', claimedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'sending', claimedUntil: new Date(now.getTime() + CLAIM_LEASE_MS) }, $inc: { attempts: 1 } },
    { returnDocument: 'after', sort: { _id: 1 } },
  ).lean<ClaimedRow>();
}

export interface CampaignSendResult {
  success: boolean;
  providerMessageId: string | null;
  error?: string;
  provider: string;
}

export interface CampaignSender {
  send(
    row: { recipient: string; channel: string; message: string },
    message: { subject: string | null; text: string; html: string | null },
  ): Promise<CampaignSendResult>;
}

/**
 * Test seam, in the same shape as the one `transactionalEmail.service.ts`
 * already uses: production always goes through the configured gateways below.
 * It exists so delivery can be driven through controllable successes and
 * failures without a live SMS or SMTP account.
 */
let senderOverride: CampaignSender | null = null;
export function setCampaignSender(sender: CampaignSender | null): void {
  senderOverride = sender;
}

/** Sends one claimed recipient through the channel's provider. */
async function deliverOne(
  row: ClaimedRow,
  message: { subject: string | null; text: string; html: string | null },
): Promise<CampaignSendResult> {
  if (senderOverride) {
    return senderOverride.send({ recipient: row.recipient, channel: row.channel, message: row.message }, message);
  }

  if (row.channel === 'email') {
    const provider = await emailService.provider();
    if (!provider.isConfigured()) {
      return { success: false, providerMessageId: null, error: 'Email is not configured', provider: 'unconfigured' };
    }
    const result = await provider.send({
      to: row.recipient,
      subject: message.subject ?? '',
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    return { ...result, provider: provider.name };
  }

  const provider = await smsRegistry.activeAsync();
  if (!provider?.isConfigured()) {
    return { success: false, providerMessageId: null, error: 'No SMS gateway is configured', provider: 'unconfigured' };
  }
  const result = await provider.send({ to: row.recipient, message: row.message });
  return { ...result, provider: provider.name };
}

/**
 * The message body as it will be sent.
 *
 * Read from the campaign, not from the job, so the payload in Redis stays small
 * and the content cannot drift from what was stored and sanitised. An email
 * campaign keeps `"<subject>\n\n<sanitised html>"` in `message`, which is the
 * shape the existing history and this split both rely on.
 */
function messageOf(campaign: { channel: string; message: string }): { subject: string | null; text: string; html: string | null } {
  if (campaign.channel !== 'email') return { subject: null, text: campaign.message, html: null };
  const split = campaign.message.indexOf('\n\n');
  const subject = split === -1 ? '' : campaign.message.slice(0, split);
  const html = split === -1 ? campaign.message : campaign.message.slice(split + 2);
  return { subject, text: htmlToPlainText(html), html };
}

/**
 * Delivers one bounded batch of a campaign.
 *
 * Sequential on purpose. The previous implementation sent one message at a time
 * and the gateways' concurrency limits are not documented here, so the
 * migration keeps the same pressure on them: correctness first. Raising it
 * later means raising the WORKER's concurrency (see `worker.ts`) or sending
 * several recipients per batch at once - both of which need a known provider
 * limit first, and neither of which changes anything in this file.
 *
 * `lastAttempt` tells it that BullMQ will not call again: transient failures
 * are then recorded as permanent rather than left pending for a retry that is
 * never coming, so the campaign can reach a terminal state.
 */
export async function deliverCampaignBatch(
  data: CampaignJobData,
  options: { lastAttempt?: boolean } = {},
): Promise<BatchOutcome> {
  // A job payload arrives from Redis, so it is input, not a given. Without this
  // a missing id becomes `new ObjectId(undefined)` - a fresh random id - and the
  // worker would quietly look up something nobody asked about.
  if (
    !Types.ObjectId.isValid(data?.campaignId ?? '') ||
    !Types.ObjectId.isValid(data?.tenantId ?? '') ||
    !Number.isInteger(data?.batchIndex) ||
    (data?.batchIndex ?? -1) < 0
  ) {
    // Not thrown: a malformed payload will never become valid, so retrying it
    // is noise. It is logged as an error because it means a bug upstream.
    logger.error('Campaign delivery refused a malformed job', { data });
    return { sent: 0, failed: 0, deferred: 0, finalized: false };
  }

  const campaignId = new Types.ObjectId(data.campaignId);
  const tenantId = new Types.ObjectId(data.tenantId);

  // Scoped by tenant AND id: a job may never reach another workspace's campaign.
  const campaign = await SmsCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
  if (!campaign) {
    logger.warn('Campaign delivery skipped: no such campaign for this workspace', {
      campaignId: data.campaignId,
      tenantId: data.tenantId,
    });
    return { sent: 0, failed: 0, deferred: 0, finalized: false };
  }

  if (campaign.status === 'cancelled') {
    return { sent: 0, failed: 0, deferred: 0, finalized: false };
  }

  // First batch to arrive moves the campaign from queued to sending. Conditional,
  // so a later batch does not rewrite a status another batch already advanced.
  await SmsCampaignModel.updateOne(
    { _id: campaignId, tenantId, status: 'queued' },
    { $set: { status: 'sending', startedAt: new Date() } },
  );

  const message = messageOf(campaign);
  const outcome: BatchOutcome = { sent: 0, failed: 0, deferred: 0, finalized: false };

  const handled: Types.ObjectId[] = [];

  for (;;) {
    const row = await claimNext(campaignId, tenantId, data.batchIndex, handled);
    if (!row) break;
    handled.push(row._id);

    let success = false;
    let providerMessageId: string | null = null;
    let error: string | undefined;
    let provider = row.provider;

    try {
      const result = await deliverOne(row, message);
      success = result.success;
      providerMessageId = result.providerMessageId;
      error = result.error;
      provider = result.provider;
    } catch (caught) {
      // A thrown error is a failure like any other - never a reason to abandon
      // the rest of the batch, which would leave paid-for recipients unsent.
      error = safeError(caught);
    }

    if (success) {
      await SmsMessageModel.updateOne(
        { _id: row._id, tenantId },
        { $set: { status: 'sent', providerMessageId, provider, error: null, failureKind: null, sentAt: new Date(), claimedUntil: null } },
      );
      outcome.sent += 1;
      continue;
    }

    const kind = classifyDeliveryFailure(error);
    const exhausted = row.attempts >= MAX_DELIVERY_ATTEMPTS || options.lastAttempt === true;
    const finalKind: DeliveryFailureKind = kind === 'permanent' || exhausted ? 'permanent' : 'transient';

    await SmsMessageModel.updateOne(
      { _id: row._id, tenantId },
      {
        $set: {
          status: 'failed',
          failureKind: finalKind,
          error: safeError(error),
          provider,
          providerMessageId,
          // Nothing was delivered, so this recipient costs nothing. The campaign's
          // charge is reconciled once, at finalisation.
          costMinor: 0,
          claimedUntil: null,
        },
      },
    );

    if (finalKind === 'permanent') outcome.failed += 1;
    else outcome.deferred += 1;
  }

  outcome.finalized = await finalizeCampaignIfComplete(campaignId, tenantId);
  return outcome;
}

/**
 * Closes a campaign once no recipient is still waiting, and settles the money.
 *
 * The status change is a compare-and-swap, and it is what makes the refund
 * happen exactly once: every batch calls this when it finishes, but only the
 * call that actually moves the campaign out of `sending` goes on to refund.
 * Without that, fifty batch jobs would each refund the same campaign.
 */
export async function finalizeCampaignIfComplete(campaignId: Types.ObjectId, tenantId: Types.ObjectId): Promise<boolean> {
  const now = new Date();

  // Anything still deliverable - including a claim whose lease has expired.
  const pending = await SmsMessageModel.countDocuments({
    tenantId,
    campaignId,
    attempts: { $lt: MAX_DELIVERY_ATTEMPTS },
    $or: [
      { status: 'queued' },
      { status: 'failed', failureKind: 'transient' },
      { status: 'sending', claimedUntil: { $lt: now } },
    ],
  });
  if (pending > 0) return false;

  // A row still inside its lease means another worker is mid-send; it will call
  // this again when it is done.
  const inFlight = await SmsMessageModel.countDocuments({
    tenantId,
    campaignId,
    status: 'sending',
    claimedUntil: { $gte: now },
  });
  if (inFlight > 0) return false;

  const [sent, failed] = await Promise.all([
    SmsMessageModel.countDocuments({ tenantId, campaignId, status: 'sent' }),
    SmsMessageModel.countDocuments({ tenantId, campaignId, status: 'failed' }),
  ]);

  // The CAS. Only one caller wins, and only the winner settles the charge.
  const claimed = await SmsCampaignModel.findOneAndUpdate(
    { _id: campaignId, tenantId, status: { $in: ['queued', 'sending'] } },
    {
      $set: {
        // Terminal states are unchanged from before the migration: some
        // delivered is `completed` with a failure count, none delivered is
        // `failed`. The UI already reads both.
        status: sent === 0 ? 'failed' : 'completed',
        sentCount: sent,
        failedCount: failed,
        completedAt: now,
      },
    },
    { returnDocument: 'before' },
  ).lean();

  if (!claimed) return false;

  const perMessage = claimed.recipientCount > 0 ? Math.round(claimed.estimatedCostMinor / claimed.recipientCount) : 0;
  const actualCostMinor = perMessage * sent;
  const refundMinor = Math.max(0, claimed.estimatedCostMinor - actualCostMinor);

  await SmsCampaignModel.updateOne({ _id: campaignId, tenantId }, { $set: { actualCostMinor } });

  if (refundMinor > 0 && claimed.usageChargeId) {
    // A workspace is never charged for a message the gateway did not accept -
    // the rule the synchronous implementation had, kept exactly.
    await usageChargeService
      .refund(claimed.usageChargeId, refundMinor, `Refund - ${failed} message(s) failed in "${claimed.name}"`, {
        // The refund resolves the wallet from the charge itself, so it takes
        // only the actor - the person who started the campaign.
        userId: claimed.createdBy ?? null,
        userName: claimed.createdByNameSnapshot || 'system',
      })
      .catch((error: unknown) => {
        // The campaign is already closed; a refund that could not be written is
        // money owed, so it must be loud rather than swallowed.
        logger.error('Campaign refund failed after delivery completed', {
          campaignId: String(campaignId),
          refundMinor,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  if (failed > 0) {
    logger.warn('Campaign completed with failures', { campaignId: String(campaignId), sent, failed });
  } else {
    logger.info('Campaign completed', { campaignId: String(campaignId), sent });
  }
  return true;
}

/** Every batch index a campaign was split into. */
export const batchIndexesFor = (recipientCount: number, batchSize = CAMPAIGN_BATCH_SIZE): number[] =>
  Array.from({ length: Math.max(1, Math.ceil(recipientCount / batchSize)) }, (_batch, index) => index);
