import { Types } from 'mongoose';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { SmsCampaignModel, SmsMessageModel } from '../../models/SmsMessage';
import { ApiError } from '../../utils/ApiError';
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';
import { walletService } from '../wallet/wallet.service';
import { usageChargeService } from '../billing/usageCharge.service';
import { smsRegistry } from './registry';
import { emailService } from '../email';
import { countSegments } from './SmsProvider';
import {
  batchIndexesFor,
  CAMPAIGN_BATCH_SIZE,
  deliverCampaignBatch,
  type CampaignJobData,
} from './campaignDelivery.service';
import { campaignQueueAvailable, enqueueCampaignBatches } from '../../queues/campaign.queue';
import type { TenantContext } from '../../types/express';

export interface CostEstimate {
  recipients: number;
  segments: number;
  encoding: string;
  characters: number;
  perSmsCostMinor: number;
  totalCostMinor: number;
}

const actorOf = (ctx: TenantContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId, userName: ctx.userName });

/**
 * SMS and email sending, billed through the shared usage-charge service.
 *
 * The money rules:
 *  - the price per unit is configured by the platform admin and frozen on each
 *    charge at the moment of use, never hardcoded and never taken from a client
 *  - the account wallet is charged before anything is sent
 *  - anything that fails to send is refunded against that same charge, so a
 *    workspace is never billed for a message that was not delivered
 */
class SmsService {
  /** What a message would cost, without sending anything. */
  async estimate(message: string, recipients: number): Promise<CostEstimate> {
    const settings = await getPlatformSettings();
    const info = countSegments(message);

    return {
      recipients,
      segments: info.segments,
      encoding: info.encoding,
      characters: info.characters,
      perSmsCostMinor: settings.smsCostMinor,
      // Cost scales with segments: a long Bengali message is several SMS.
      totalCostMinor: settings.smsCostMinor * info.segments * recipients,
    };
  }

  /** Provider availability, so the UI can explain why sending is disabled. */
  status() {
    const active = smsRegistry.active();
    return {
      available: Boolean(active),
      provider: active?.name ?? null,
      displayName: active?.displayName ?? null,
      providers: smsRegistry.listAll(),
    };
  }

  /**
   * Same, but reloads credentials first.
   *
   * Used wherever the answer must reflect a key an admin saved a moment ago
   * rather than whatever was loaded at boot.
   */
  async statusAsync() {
    await smsRegistry.refresh();
    return this.status();
  }

  /** Provider account balance, when the gateway exposes one. */
  async providerBalance() {
    const provider = await smsRegistry.activeAsync();
    if (!provider?.getBalance) return { balanceMinor: null, currency: null, supported: false };
    try {
      const balance = await provider.getBalance();
      return { ...balance, supported: true };
    } catch (error) {
      return {
        balanceMinor: null,
        currency: null,
        supported: true,
        error: error instanceof Error ? error.message : 'Could not read the gateway balance',
      };
    }
  }

  /** Sends one message - used for transactional notices and test sends. */
  async sendOne(
    ctx: TenantContext,
    input: { to: string; message: string; customerId?: Types.ObjectId | null },
  ) {
    const provider = await smsRegistry.activeAsync();
    if (!provider) {
      throw ApiError.badRequest(
        'No SMS gateway is configured. Ask the platform administrator to set one up.',
      );
    }

    const estimate = await this.estimate(input.message, 1);
    if (estimate.segments === 0) throw ApiError.badRequest('The message is empty');

    // The message id is fixed first so the charge can point at it.
    const recordId = new Types.ObjectId();

    // Charge before sending. A failed send is refunded below.
    const charge = await usageChargeService.charge(actorOf(ctx), {
      service: 'sms',
      quantity: estimate.segments,
      description: `SMS to ${input.to}`,
      referenceType: 'sms_message',
      referenceId: recordId,
      metadata: { segments: estimate.segments, recipients: 1 },
    });

    const record = await SmsMessageModel.create({
      _id: recordId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      customerId: input.customerId ?? null,
      recipient: input.to,
      message: input.message,
      segments: estimate.segments,
      encoding: estimate.encoding,
      costMinor: charge.amountMinor,
      provider: provider.name,
      status: 'queued',
      sentBy: ctx.userId,
      sentByNameSnapshot: ctx.userName,
    });

    const result = await provider.send({ to: input.to, message: input.message });

    record.status = result.success ? 'sent' : 'failed';
    record.providerMessageId = result.providerMessageId;
    record.error = result.error ?? null;
    record.sentAt = result.success ? new Date() : null;

    if (!result.success) {
      // Nothing was delivered, so the charge is returned in full.
      record.costMinor = 0;
      if (charge.amountMinor > 0) {
        await usageChargeService.refund(charge._id, charge.amountMinor, `Refund - SMS to ${input.to} failed`, actorOf(ctx));
      }
    }

    await record.save();
    return record.toObject();
  }

  /**
   * Hands a prepared campaign to the background worker.
   *
   * The recipients, the message and the charge are already durable before this
   * runs, so all that is enqueued is `{ campaignId, tenantId, batchIndex }` per
   * batch. If the enqueue fails the campaign is NOT reported as queued: the
   * charge is returned and the campaign is marked failed, because a campaign
   * that was paid for and silently never sent is the worst of the outcomes.
   *
   * WHEN THERE IS NO REDIS the work runs inline, exactly as it did before this
   * migration. Phase 1 made Redis optional for the API on purpose, and a
   * deployment without it must still be able to send a campaign - enqueueing
   * into nothing would mean a campaign that never goes out. It is the same
   * delivery code either way (`deliverCampaignBatch`), reached two ways; there
   * is no second implementation to drift.
   */
  private async dispatchCampaign(
    campaign: { _id: Types.ObjectId; tenantId: Types.ObjectId; name: string; recipientCount: number; usageChargeId: Types.ObjectId | null },
    charge: { _id: Types.ObjectId; amountMinor: number },
    actor: { userId: Types.ObjectId | null; userName: string },
  ) {
    const batchIndexes = batchIndexesFor(campaign.recipientCount);
    const job: Omit<CampaignJobData, 'batchIndex'> = {
      campaignId: String(campaign._id),
      tenantId: String(campaign.tenantId),
    };

    if (!campaignQueueAvailable()) {
      // Inline fallback: one attempt per recipient, which is what the
      // synchronous implementation did, so a transient failure is recorded
      // rather than left pending for a worker that does not exist.
      for (const batchIndex of batchIndexes) {
        await deliverCampaignBatch({ ...job, batchIndex }, { lastAttempt: true });
      }
      return this.campaignView(campaign._id, campaign.tenantId);
    }

    try {
      await enqueueCampaignBatches({ ...job, batchIndexes });
    } catch (error) {
      logger.error('Could not enqueue a campaign; the charge is being returned', {
        campaignId: String(campaign._id),
        error: error instanceof Error ? error.message : String(error),
      });
      if (charge.amountMinor > 0) {
        await usageChargeService
          .refund(charge._id, charge.amountMinor, `Refund - "${campaign.name}" could not be queued`, actor)
          .catch(() => undefined);
      }
      await SmsCampaignModel.updateOne(
        { _id: campaign._id, tenantId: campaign.tenantId },
        { $set: { status: 'failed', completedAt: new Date(), actualCostMinor: 0 } },
      );
      throw ApiError.internal('The campaign could not be queued for sending. Nothing was sent and the charge has been returned.');
    }

    return this.campaignView(campaign._id, campaign.tenantId);
  }

  /** The campaign as the API returns it, read back so counters are current. */
  private async campaignView(campaignId: Types.ObjectId, tenantId: Types.ObjectId) {
    const campaign = await SmsCampaignModel.findOne({ _id: campaignId, tenantId }).lean();
    if (!campaign) throw ApiError.notFound('Campaign not found');
    return campaign;
  }

  /**
   * Promotional campaign to many recipients.
   *
   * One usage charge for the whole campaign up front, one refund for the
   * failures at the end - unchanged. What changed is WHERE the sending happens:
   * the recipients are stored, the work is enqueued, and the request returns.
   * It no longer waits for up to 5,000 sequential gateway calls.
   */
  async sendCampaign(
    ctx: TenantContext,
    input: { name: string; message: string; recipients: { phone: string; customerId?: Types.ObjectId | null }[] },
  ) {
    const provider = await smsRegistry.activeAsync();
    if (!provider) {
      throw ApiError.badRequest(
        'No SMS gateway is configured. Ask the platform administrator to set one up.',
      );
    }

    const unique = [...new Map(input.recipients.map((r) => [r.phone.replace(/\D/g, ''), r])).values()].filter(
      (r) => r.phone.replace(/\D/g, '').length >= 10,
    );
    if (unique.length === 0) throw ApiError.badRequest('No valid recipients were supplied');

    const estimate = await this.estimate(input.message, unique.length);

    if (!(await walletService.canAfford(ctx.tenantId, estimate.totalCostMinor))) {
      const balance = await walletService.balance(ctx.tenantId);
      throw ApiError.badRequest(
        `This campaign costs ${(estimate.totalCostMinor / 100).toFixed(2)} but your wallet holds ${(balance.balanceMinor / 100).toFixed(2)}. Top up to continue.`,
        { requiredMinor: estimate.totalCostMinor, availableMinor: balance.balanceMinor },
      );
    }

    const batchIndexes = batchIndexesFor(unique.length);
    const campaign = await SmsCampaignModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      name: input.name,
      message: input.message,
      segments: estimate.segments,
      encoding: estimate.encoding,
      recipientCount: unique.length,
      estimatedCostMinor: estimate.totalCostMinor,
      // Paid for and stored, but not yet started. A worker moves it to
      // 'sending' when it picks up the first batch.
      status: 'queued',
      batchSize: CAMPAIGN_BATCH_SIZE,
      batchCount: batchIndexes.length,
      queuedAt: new Date(),
      createdBy: ctx.userId,
      createdByNameSnapshot: ctx.userName,
    });

    let charge;
    try {
      charge = await usageChargeService.charge(actorOf(ctx), {
        service: 'sms',
        quantity: estimate.segments * unique.length,
        description: `SMS campaign "${input.name}" (${unique.length} recipients)`,
        referenceType: 'sms_campaign',
        referenceId: campaign._id,
        metadata: { segments: estimate.segments, recipients: unique.length },
      });
    } catch (error) {
      // The balance changed between the check and the charge: nothing is sent.
      campaign.status = 'failed';
      campaign.completedAt = new Date();
      await campaign.save();
      throw error;
    }

    campaign.usageChargeId = charge._id;
    campaign.estimatedCostMinor = charge.amountMinor;
    await campaign.save();

    // The frozen unit price, so the per-message cost matches what was charged.
    const perMessageCost = charge.unitPriceMinor * estimate.segments;

    // The recipient list becomes rows BEFORE anything is enqueued. That is what
    // keeps the job payload to three ids, lets a worker restart carry on from
    // the database, and - with the unique (campaignId, recipient) index - makes
    // a repeated delivery attempt unable to create a second row for anyone.
    // `ordered: false` so one bad row cannot abandon the rest.
    await SmsMessageModel.insertMany(
      unique.map((recipient, index) => ({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        campaignId: campaign._id,
        customerId: recipient.customerId ?? null,
        recipient: recipient.phone,
        message: input.message,
        segments: estimate.segments,
        encoding: estimate.encoding,
        costMinor: perMessageCost,
        provider: provider.name,
        status: 'queued',
        batchIndex: Math.floor(index / CAMPAIGN_BATCH_SIZE),
        sentBy: ctx.userId,
        sentByNameSnapshot: ctx.userName,
      })),
      { ordered: false },
    );

    return this.dispatchCampaign(
      { _id: campaign._id, tenantId: ctx.tenantId, name: input.name, recipientCount: unique.length, usageChargeId: charge._id },
      charge,
      { userId: ctx.userId, userName: ctx.userName },
    );
  }

  async history(tenantId: Types.ObjectId, input: { page?: number; limit?: number; status?: string; campaignId?: Types.ObjectId }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId };
    if (input.status) filter.status = input.status;
    if (input.campaignId) filter.campaignId = input.campaignId;

    const [items, total] = await Promise.all([
      SmsMessageModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SmsMessageModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async campaigns(tenantId: Types.ObjectId, input: { page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const [items, total] = await Promise.all([
      SmsCampaignModel.find({ tenantId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SmsCampaignModel.countDocuments({ tenantId }),
    ]);
    return { items, page, limit, total };
  }

  /** Totals for the messaging dashboard. */
  async usage(tenantId: Types.ObjectId) {
    const [row] = await SmsMessageModel.aggregate<{ sent: number; failed: number; costMinor: number; segments: number }>([
      { $match: { tenantId } },
      {
        $group: {
          _id: null,
          sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          costMinor: { $sum: '$costMinor' },
          segments: { $sum: '$segments' },
        },
      },
    ]);

    return {
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
      totalCostMinor: row?.costMinor ?? 0,
      totalSegments: row?.segments ?? 0,
    };
  }

  /**
   * Email campaign, billed exactly like SMS.
   *
   * Only customers with an email address are targeted - the caller filters
   * first, so a workspace is never charged for an address that does not exist.
   */
  async sendEmailCampaign(
    ctx: TenantContext,
    input: { name: string; subject: string; body: string; recipients: { email: string; customerId?: Types.ObjectId | null }[] },
  ) {
    const provider = await emailService.provider();
    if (!provider.isConfigured()) {
      throw ApiError.badRequest('No email provider is configured on this server. Ask an administrator to set up SMTP.');
    }

    // Deduplicated by address, as the SMS path already does: two customers can
    // share an email, and a workspace should neither be charged twice for one
    // address nor send the same person the same campaign twice.
    const valid = [
      ...new Map(
        input.recipients
          .filter((r) => /.+@.+\..+/.test(r.email))
          .map((r) => [r.email.trim().toLowerCase(), { ...r, email: r.email.trim() }]),
      ).values(),
    ];
    if (valid.length === 0) throw ApiError.badRequest('None of the selected customers have a valid email address');

    // Sanitise HERE, not in the browser. The client sanitises so the preview is
    // honest, but a campaign can be posted straight to the API with no browser
    // involved, so this is the copy that decides what actually goes out.
    const safeHtml = sanitizeEmailHtml(input.body);
    if (safeHtml.trim().length === 0) {
      throw ApiError.badRequest('The campaign body is empty once scripts and unsafe markup are removed.');
    }
    const settings = await getPlatformSettings();
    const estimatedTotal = (settings.emailCostMinor ?? 0) * valid.length;

    if (estimatedTotal > 0 && !(await walletService.canAfford(ctx.tenantId, estimatedTotal))) {
      const balance = await walletService.balance(ctx.tenantId);
      throw ApiError.badRequest(
        `This campaign costs ${(estimatedTotal / 100).toFixed(2)} but your wallet holds ${(balance.balanceMinor / 100).toFixed(2)}. Top up to continue.`,
        { requiredMinor: estimatedTotal, availableMinor: balance.balanceMinor },
      );
    }

    const campaign = await SmsCampaignModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      name: input.name,
      // The stored copy is the sanitised one, so history can never replay
      // markup that was stripped before sending.
      message: `${input.subject}\n\n${safeHtml}`,
      segments: 1,
      encoding: 'EMAIL',
      channel: 'email',
      recipientCount: valid.length,
      estimatedCostMinor: estimatedTotal,
      status: 'queued',
      batchSize: CAMPAIGN_BATCH_SIZE,
      batchCount: batchIndexesFor(valid.length).length,
      queuedAt: new Date(),
      createdBy: ctx.userId,
      createdByNameSnapshot: ctx.userName,
    });

    // Recorded as usage even while email is free, so enabling a price later
    // needs no change here.
    let charge;
    try {
      charge = await usageChargeService.charge(actorOf(ctx), {
        service: 'email',
        quantity: valid.length,
        description: `Email campaign "${input.name}" (${valid.length} recipients)`,
        referenceType: 'email_campaign',
        referenceId: campaign._id,
        metadata: { recipients: valid.length },
      });
    } catch (error) {
      campaign.status = 'failed';
      campaign.completedAt = new Date();
      await campaign.save();
      throw error;
    }

    campaign.usageChargeId = charge._id;
    campaign.estimatedCostMinor = charge.amountMinor;
    await campaign.save();

    const perEmail = charge.unitPriceMinor;

    // The sanitised HTML lives on the campaign as `subject\n\nhtml`, so the
    // worker reads the body - and derives its plain-text fallback - from there,
    // and the job payload stays three ids.
    await SmsMessageModel.insertMany(
      valid.map((recipient, index) => ({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        campaignId: campaign._id,
        customerId: recipient.customerId ?? null,
        recipient: recipient.email,
        message: input.subject,
        segments: 1,
        encoding: 'EMAIL',
        channel: 'email',
        costMinor: perEmail,
        provider: provider.name,
        status: 'queued',
        batchIndex: Math.floor(index / CAMPAIGN_BATCH_SIZE),
        sentBy: ctx.userId,
        sentByNameSnapshot: ctx.userName,
      })),
      { ordered: false },
    );

    return this.dispatchCampaign(
      { _id: campaign._id, tenantId: ctx.tenantId, name: input.name, recipientCount: valid.length, usageChargeId: charge._id },
      charge,
      { userId: ctx.userId, userName: ctx.userName },
    );
  }
}

export const smsService = new SmsService();
