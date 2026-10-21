/**
 * Campaign delivery in the background: the rules the HTTP suite cannot reach.
 *
 * The end-to-end suite drives campaigns over HTTP and proves the money, the
 * permissions and the tenant isolation. It cannot reach any of what follows,
 * because all of it is about what happens when delivery is INTERRUPTED or
 * REPEATED - a worker claiming a recipient twice, a lease expiring, a transient
 * failure being retried, a second batch trying to refund a campaign that is
 * already settled. Over HTTP those need a crash at an exact instant; here the
 * rows can simply be put into the state a crash would have left.
 *
 * Delivery is driven through the `setCampaignSender` seam - the same pattern
 * `transactionalEmail.service.ts` uses - so successes, transient failures,
 * permanent failures and thrown errors are all deterministic and nothing
 * contacts a real gateway.
 *
 * WHAT THIS DOES NOT COVER: BullMQ itself. Whether Redis hands the job to the
 * worker, retries it on the central backoff and detects a stall is BullMQ's
 * behaviour, it needs a real Redis, and this project's CI has none. The
 * processor wrapper is thin on purpose and the function it calls is what is
 * tested here. See docs/IMPLEMENTATION_STATUS.md for that limitation.
 *
 * Run as part of `npm test`.
 */
import mongoose, { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { MAX_DELIVERY_ATTEMPTS, SmsCampaignModel, SmsMessageModel } from '../models/SmsMessage';
import { TenantModel } from '../models/Tenant';
import { WalletModel } from '../models/Wallet';
import { UsageChargeModel } from '../models/UsageCharge';
import {
  batchIndexesFor,
  CAMPAIGN_BATCH_SIZE,
  classifyDeliveryFailure,
  deliverCampaignBatch,
  finalizeCampaignIfComplete,
  setCampaignSender,
  type CampaignSender,
} from '../services/sms/campaignDelivery.service';
import { CAMPAIGN_QUEUE, campaignJobId, processCampaignJob } from '../queues/campaign.queue';

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

const stamp = Date.now();
const tenantId = new Types.ObjectId();
const otherTenantId = new Types.ObjectId();
const storeId = new Types.ObjectId();

/** A sender whose answer per recipient is scripted, and which counts its calls. */
function scriptedSender(script: Record<string, CampaignSendResultScript>) {
  const calls: string[] = [];
  const sender: CampaignSender = {
    async send(row) {
      calls.push(row.recipient);
      const outcome = script[row.recipient] ?? { kind: 'ok' };
      if (outcome.kind === 'throw') throw new Error(outcome.error);
      if (outcome.kind === 'ok') return { success: true, providerMessageId: `mid-${row.recipient}`, provider: 'scripted' };
      return { success: false, providerMessageId: null, error: outcome.error, provider: 'scripted' };
    },
  };
  setCampaignSender(sender);
  return { calls };
}
type CampaignSendResultScript =
  | { kind: 'ok' }
  | { kind: 'fail'; error: string }
  | { kind: 'throw'; error: string };

/** Creates a campaign and its recipient rows the way the API does. */
async function makeCampaign(options: {
  recipients: string[];
  channel?: 'sms' | 'email';
  perMessageMinor?: number;
  tenant?: Types.ObjectId;
  name?: string;
}) {
  const perMessage = options.perMessageMinor ?? 50;
  const owner = options.tenant ?? tenantId;
  const recipientCount = options.recipients.length;

  const charge = await UsageChargeModel.create({
    tenantId: owner,
    accountId: new Types.ObjectId(),
    walletId: new Types.ObjectId(),
    service: options.channel === 'email' ? 'email' : 'sms',
    unit: options.channel === 'email' ? 'email' : 'segment',
    quantity: recipientCount,
    unitPriceMinor: perMessage,
    amountMinor: perMessage * recipientCount,
    description: 'check',
    status: 'charged',
  });

  const campaign = await SmsCampaignModel.create({
    tenantId: owner,
    storeId,
    name: options.name ?? `Check ${stamp}`,
    message: options.channel === 'email' ? 'Subject line\n\n<p>Hello</p>' : 'Hello',
    segments: 1,
    encoding: options.channel === 'email' ? 'EMAIL' : 'GSM7',
    channel: options.channel ?? 'sms',
    recipientCount,
    estimatedCostMinor: perMessage * recipientCount,
    usageChargeId: charge._id,
    status: 'queued',
    batchSize: CAMPAIGN_BATCH_SIZE,
    batchCount: batchIndexesFor(recipientCount).length,
    queuedAt: new Date(),
  });

  await SmsMessageModel.insertMany(
    options.recipients.map((recipient, index) => ({
      tenantId: owner,
      storeId,
      campaignId: campaign._id,
      recipient,
      message: options.channel === 'email' ? 'Subject line' : 'Hello',
      segments: 1,
      encoding: options.channel === 'email' ? 'EMAIL' : 'GSM7',
      channel: options.channel ?? 'sms',
      costMinor: perMessage,
      provider: 'scripted',
      status: 'queued',
      batchIndex: Math.floor(index / CAMPAIGN_BATCH_SIZE),
    })),
    { ordered: false },
  );

  return { campaign, charge };
}

const rowsOf = (campaignId: Types.ObjectId) =>
  SmsMessageModel.find({ campaignId }).sort({ recipient: 1 }).lean();
const campaignOf = (campaignId: Types.ObjectId) => SmsCampaignModel.findById(campaignId).lean();

async function main(): Promise<void> {
  await connectDatabase();
  console.log('\n  Campaign delivery (background worker)\n');

  // Real workspaces, so a refund resolves a real wallet and the money
  // assertions below exercise the whole path rather than half of it.
  for (const [id, name] of [
    [tenantId, `Campaign check ${stamp}`],
    [otherTenantId, `Campaign check other ${stamp}`],
  ] as const) {
    await TenantModel.create({ _id: id, name, slug: `campaign-check-${id}`, ownerUserId: new Types.ObjectId() });
  }

  // 1. Batching ------------------------------------------------------------

  check('A campaign is split into bounded batches', batchIndexesFor(5_000).length === Math.ceil(5_000 / CAMPAIGN_BATCH_SIZE));
  check('...so 5,000 recipients is tens of jobs, not thousands', batchIndexesFor(5_000).length <= 50, batchIndexesFor(5_000).length);
  check('A single recipient is still one batch', batchIndexesFor(1).length === 1);
  check('An empty campaign is still one batch rather than none', batchIndexesFor(0).length === 1);

  // 2. The queue payload carries identifiers only -------------------------

  check('The queue name follows the convention', CAMPAIGN_QUEUE === 'campaign-delivery');
  const jobId = campaignJobId('abc123', 7);
  check('A job id is deterministic, so a repeated enqueue is ignored', jobId === campaignJobId('abc123', 7) && jobId.includes('abc123'));
  check('...and differs per batch', campaignJobId('abc123', 7) !== campaignJobId('abc123', 8));
  // BullMQ refuses a custom job id containing a colon ("Custom Id cannot
  // contain :"), and it refuses it at ENQUEUE time - so an id that breaks the
  // rule fails only against a real Redis. One did, and it reached Phase 7
  // having passed every test that existed, because this file only ever compared
  // the string to itself and the HTTP suite ran on the Redis-less inline path.
  check('...and contains no colon, which BullMQ rejects outright', !jobId.includes(':'), jobId);
  check(
    '...for any campaign id and batch index',
    [0, 1, 49, 1_000].every((i) => !campaignJobId('65b0000000000000000000ff', i).includes(':')),
  );

  // 2b. The worker's own two decisions ------------------------------------

  {
    const seen: { lastAttempt: boolean }[] = [];
    const deliver = async (_data: typeof jobData, options: { lastAttempt: boolean }) => {
      seen.push(options);
      return { sent: 1, failed: 0, deferred: 0 };
    };
    const jobData = { campaignId: 'c1', tenantId: 't1', batchIndex: 0 };

    await processCampaignJob({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } }, deliver);
    check('The first of three attempts is not the last', seen[0]?.lastAttempt === false, seen[0]);

    await processCampaignJob({ data: jobData, attemptsMade: 2, opts: { attempts: 3 } }, deliver);
    check('The third of three attempts is the last', seen[1]?.lastAttempt === true, seen[1]);

    await processCampaignJob({ data: jobData, attemptsMade: 0, opts: {} }, deliver);
    check('A job with no retry policy is on its last attempt immediately', seen[2]?.lastAttempt === true, seen[2]);

    // Deferred work must hand the batch back so BullMQ retries it on the
    // central backoff; nothing deferred must not fail the job.
    let threw = false;
    try {
      await processCampaignJob({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } }, async () => ({ sent: 0, failed: 0, deferred: 2 }));
    } catch {
      threw = true;
    }
    check('A batch with transient failures is handed back for retry', threw);

    let threwOnClean = false;
    try {
      await processCampaignJob({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } }, async () => ({ sent: 5, failed: 1, deferred: 0 }));
    } catch {
      threwOnClean = true;
    }
    check('A batch with only permanent failures is not retried', !threwOnClean);
  }

  // 3. Happy path: queued -> sending -> completed --------------------------

  {
    const { campaign, charge } = await makeCampaign({ recipients: ['01710000001', '01710000002'] });
    const sender = scriptedSender({});

    check('A prepared campaign starts queued', (await campaignOf(campaign._id))?.status === 'queued');

    const outcome = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('Every recipient is delivered', outcome.sent === 2 && outcome.failed === 0 && outcome.deferred === 0, outcome);
    check('The campaign finalises', outcome.finalized);

    const after = await campaignOf(campaign._id);
    check('...as completed', after?.status === 'completed', after?.status);
    check('...counting what was sent', after?.sentCount === 2 && after?.failedCount === 0, after);
    check('...and charging only for those', after?.actualCostMinor === 100, after?.actualCostMinor);
    check('A delivered row records the provider message id', (await rowsOf(campaign._id)).every((r) => r.status === 'sent' && r.providerMessageId));

    const settled = await UsageChargeModel.findById(charge._id).lean();
    check('Nothing is refunded when nothing failed', (settled?.refundedMinor ?? 0) === 0, settled?.refundedMinor);

    // Re-running the same batch must not send to anyone again.
    const callsBefore = sender.calls.length;
    const again = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('Re-running a finished batch sends nothing', sender.calls.length === callsBefore && again.sent === 0, again);
    check('...and does not re-finalise the campaign', !again.finalized);
    const afterReplay = await UsageChargeModel.findById(charge._id).lean();
    check('...and never refunds twice', (afterReplay?.refundedMinor ?? 0) === 0);
  }

  // 4. Tenant isolation ----------------------------------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000010'] });
    const sender = scriptedSender({});

    const stolen = await deliverCampaignBatch({
      campaignId: String(campaign._id),
      // The right campaign id, the wrong workspace.
      tenantId: String(otherTenantId),
      batchIndex: 0,
    });
    check('A job naming another workspace delivers nothing', stolen.sent === 0 && sender.calls.length === 0, stolen);
    check('...and leaves the campaign untouched', (await campaignOf(campaign._id))?.status === 'queued');
    check('...and leaves its recipients unsent', (await rowsOf(campaign._id)).every((r) => r.status === 'queued'));

    // The real owner still works.
    const owned = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('The owning workspace can deliver it', owned.sent === 1, owned);
  }

  // 5. Duplicate protection at the database level -------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000020'] });
    let rejected = false;
    try {
      await SmsMessageModel.create({
        tenantId,
        storeId,
        campaignId: campaign._id,
        recipient: '01710000020',
        message: 'Hello',
        segments: 1,
        costMinor: 50,
        provider: 'scripted',
        status: 'queued',
      });
    } catch (error) {
      rejected = (error as { code?: number }).code === 11000;
    }
    check('One recipient cannot appear twice in one campaign', rejected);

    // A one-off message has no campaign, and several of those are legitimate.
    const loose = await SmsMessageModel.create([
      { tenantId, storeId, recipient: '01710009999', message: 'a', segments: 1, costMinor: 1, provider: 'scripted', status: 'sent' },
      { tenantId, storeId, recipient: '01710009999', message: 'b', segments: 1, costMinor: 1, provider: 'scripted', status: 'sent' },
    ]);
    check('...but two one-off messages to the same number are fine', loose.length === 2);
  }

  // 6. Failure classification ---------------------------------------------

  for (const permanent of [
    'Invalid recipient number',
    'mailbox not found',
    'No such user here',
    '550 5.1.1 recipient rejected',
    'Authentication failed',
    'The API key is invalid',
    'No SMS gateway is configured',
    'Insufficient balance',
  ]) {
    check(`Permanent: "${permanent}"`, classifyDeliveryFailure(permanent) === 'permanent');
  }
  for (const transient of ['Request timed out', 'socket hang up', 'ECONNRESET', '451 try again later', 'Service temporarily unavailable', '']) {
    check(`Transient: "${transient || '(no message)'}"`, classifyDeliveryFailure(transient) === 'transient');
  }
  check('An unrecognised failure is treated as transient, never discarded', classifyDeliveryFailure('weird gateway hiccup #42') === 'transient');

  // 7. Transient failures are retried; permanent ones are not -------------

  {
    const { campaign, charge } = await makeCampaign({ recipients: ['01710000031', '01710000032', '01710000033'] });
    const sender = scriptedSender({
      '01710000032': { kind: 'fail', error: 'Request timed out' },
      '01710000033': { kind: 'fail', error: 'Invalid recipient number' },
    });

    const first = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('A transient failure is deferred, not finished', first.deferred === 1, first);
    check('A permanent failure is recorded as failed', first.failed === 1, first);
    check('The campaign does NOT finalise while a retry is owed', !first.finalized);
    check('...and is still sending', (await campaignOf(campaign._id))?.status === 'sending');

    const rows = await rowsOf(campaign._id);
    const transientRow = rows.find((r) => r.recipient === '01710000032');
    const permanentRow = rows.find((r) => r.recipient === '01710000033');
    check('The transient row is marked retryable', transientRow?.status === 'failed' && transientRow?.failureKind === 'transient');
    check('The permanent row is marked permanent', permanentRow?.status === 'failed' && permanentRow?.failureKind === 'permanent');
    check('A failed recipient costs nothing', transientRow?.costMinor === 0 && permanentRow?.costMinor === 0);
    check('The reason is kept so a person can see why', (permanentRow?.error ?? '').includes('Invalid recipient'));

    // The retry: the transient one succeeds, and nothing else is re-sent.
    setCampaignSender({
      async send(row) {
        sender.calls.push(row.recipient);
        return { success: true, providerMessageId: 'retry', provider: 'scripted' };
      },
    });
    const retryCallsBefore = sender.calls.length;
    const second = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    const retried = sender.calls.slice(retryCallsBefore);
    check('A retry attempts only the transient recipient', retried.length === 1 && retried[0] === '01710000032', retried);
    check('...and it succeeds', second.sent === 1, second);
    check('A permanently failed recipient is never attempted again', !retried.includes('01710000033'));
    check('The campaign now finalises', second.finalized);

    const after = await campaignOf(campaign._id);
    check('Partial failure is completed with a failure count', after?.status === 'completed' && after?.failedCount === 1, after);
    check('...and sentCount counts the retry', after?.sentCount === 2, after?.sentCount);
    check('...and the cost covers only what went out', after?.actualCostMinor === 100, after?.actualCostMinor);

    const settled = await UsageChargeModel.findById(charge._id).lean();
    check('The failed recipient is refunded, exactly once', settled?.refundedMinor === 50, settled?.refundedMinor);
  }

  // 8. Retries are bounded -------------------------------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000040'] });
    const sender = scriptedSender({ '01710000040': { kind: 'fail', error: 'Request timed out' } });

    for (let pass = 0; pass < MAX_DELIVERY_ATTEMPTS + 3; pass += 1) {
      await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    }
    check(
      'A recipient that keeps failing is attempted a bounded number of times',
      sender.calls.length === MAX_DELIVERY_ATTEMPTS,
      sender.calls.length,
    );
    const row = (await rowsOf(campaign._id))[0];
    check('...then treated as permanent', row?.failureKind === 'permanent' && row?.attempts === MAX_DELIVERY_ATTEMPTS, row);
    check('...so the campaign reaches a terminal state', (await campaignOf(campaign._id))?.status === 'failed');
  }

  // 9. The final attempt gives up rather than leaving work pending --------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000050'] });
    scriptedSender({ '01710000050': { kind: 'fail', error: 'Request timed out' } });

    const outcome = await deliverCampaignBatch(
      { campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 },
      { lastAttempt: true },
    );
    check('On the last attempt a transient failure becomes permanent', outcome.failed === 1 && outcome.deferred === 0, outcome);
    check('...so the campaign does not hang in sending for ever', outcome.finalized);
    check('...and reports that nothing was delivered', (await campaignOf(campaign._id))?.status === 'failed');
  }

  // 10. A thrown provider error is a failure, not a lost batch ------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000061', '01710000062'] });
    scriptedSender({ '01710000061': { kind: 'throw', error: 'socket hang up' } });

    const outcome = await deliverCampaignBatch(
      { campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 },
      { lastAttempt: true },
    );
    check('A thrown error does not abandon the rest of the batch', outcome.sent === 1 && outcome.failed === 1, outcome);
    const rows = await rowsOf(campaign._id);
    check('...and the thrown message is recorded', (rows.find((r) => r.recipient === '01710000061')?.error ?? '').includes('socket hang up'));
  }

  // 11. Recovery from an interrupted worker -------------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000071', '01710000072'] });
    const sender = scriptedSender({});

    // What a crash mid-send leaves: one row claimed, its lease still running.
    await SmsMessageModel.updateOne(
      { campaignId: campaign._id, recipient: '01710000071' },
      { $set: { status: 'sending', claimedUntil: new Date(Date.now() + 60_000), attempts: 1 } },
    );

    const blocked = await finalizeCampaignIfComplete(campaign._id, tenantId);
    check('A campaign with a live claim does not finalise', !blocked);

    // The lease expires: the work becomes claimable again.
    await SmsMessageModel.updateOne(
      { campaignId: campaign._id, recipient: '01710000071' },
      { $set: { claimedUntil: new Date(Date.now() - 1_000) } },
    );

    const resumed = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('An expired claim is picked up again after a restart', sender.calls.includes('01710000071'), sender.calls);
    check('...and the untouched recipient is delivered too', resumed.sent === 2, resumed);
    check('...and the campaign completes', (await campaignOf(campaign._id))?.status === 'completed');
  }

  // 12. Only one batch settles the campaign -------------------------------

  {
    const { campaign, charge } = await makeCampaign({ recipients: ['01710000081'], perMessageMinor: 70 });
    scriptedSender({ '01710000081': { kind: 'fail', error: 'Invalid recipient number' } });

    await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    const first = await UsageChargeModel.findById(charge._id).lean();
    check('A campaign where everything failed is refunded in full', first?.refundedMinor === 70, first?.refundedMinor);

    // Every batch calls finalisation; only the one that moved the status settles.
    const second = await finalizeCampaignIfComplete(campaign._id, tenantId);
    const third = await finalizeCampaignIfComplete(campaign._id, tenantId);
    check('A second finalisation is a no-op', !second && !third);
    const settled = await UsageChargeModel.findById(charge._id).lean();
    check('...so the refund is never duplicated', settled?.refundedMinor === 70, settled?.refundedMinor);
  }

  // 13. A cancelled campaign is left alone --------------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['01710000091'] });
    await SmsCampaignModel.updateOne({ _id: campaign._id }, { $set: { status: 'cancelled' } });
    const sender = scriptedSender({});
    const outcome = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('A cancelled campaign sends nothing', outcome.sent === 0 && sender.calls.length === 0, outcome);
    check('...and stays cancelled', (await campaignOf(campaign._id))?.status === 'cancelled');
  }

  // 14. A missing campaign is survivable ----------------------------------

  {
    scriptedSender({});
    const outcome = await deliverCampaignBatch({
      campaignId: String(new Types.ObjectId()),
      tenantId: String(tenantId),
      batchIndex: 0,
    });
    check('A job for a campaign that no longer exists is a no-op', outcome.sent === 0 && !outcome.finalized);
  }

  // 15. Email campaigns use the same machinery ----------------------------

  {
    const { campaign } = await makeCampaign({ recipients: ['a@example.com', 'b@example.com'], channel: 'email', perMessageMinor: 10 });
    let sawSubject = '';
    let sawHtml = '';
    let sawText = '';
    setCampaignSender({
      async send(_row, message) {
        sawSubject = message.subject ?? '';
        sawHtml = message.html ?? '';
        sawText = message.text;
        return { success: true, providerMessageId: 'email', provider: 'scripted' };
      },
    });

    const outcome = await deliverCampaignBatch({ campaignId: String(campaign._id), tenantId: String(tenantId), batchIndex: 0 });
    check('An email campaign delivers through the same code', outcome.sent === 2 && outcome.finalized, outcome);
    check('...splitting the stored subject from the body', sawSubject === 'Subject line', sawSubject);
    check('...sending the sanitised HTML', sawHtml.includes('<p>Hello</p>'), sawHtml);
    check('...with a plain-text fallback', sawText.trim() === 'Hello', sawText);
  }

  setCampaignSender(null);

  // Clean up everything this check created.
  await SmsMessageModel.deleteMany({ tenantId: { $in: [tenantId, otherTenantId] } });
  await SmsCampaignModel.deleteMany({ tenantId: { $in: [tenantId, otherTenantId] } });
  await UsageChargeModel.deleteMany({ tenantId: { $in: [tenantId, otherTenantId] } });
  await WalletModel.deleteMany({ tenantId: { $in: [tenantId, otherTenantId] } });
  await TenantModel.deleteMany({ _id: { $in: [tenantId, otherTenantId] } });

  console.log(`\n==========  ${passed} passed, ${failed} failed  ==========\n`);
  await disconnectDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Campaign delivery check crashed:', error);
  setCampaignSender(null);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(1);
});
