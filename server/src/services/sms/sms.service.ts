import { Types } from 'mongoose';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { SmsCampaignModel, SmsMessageModel } from '../../models/SmsMessage';
import { ApiError } from '../../utils/ApiError';
import { htmlToPlainText, sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';
import { walletService } from '../wallet/wallet.service';
import { usageChargeService } from '../billing/usageCharge.service';
import { smsRegistry } from './registry';
import { emailService } from '../email';
import { countSegments } from './SmsProvider';
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
   * Promotional campaign to many recipients.
   *
   * One usage charge for the whole campaign, sent, then one refund for the
   * failures against that charge.
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

    const campaign = await SmsCampaignModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      name: input.name,
      message: input.message,
      segments: estimate.segments,
      encoding: estimate.encoding,
      recipientCount: unique.length,
      estimatedCostMinor: estimate.totalCostMinor,
      status: 'sending',
      startedAt: new Date(),
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
    // The frozen unit price, so the per-message cost matches what was charged.
    const perMessageCost = charge.unitPriceMinor * estimate.segments;
    let sent = 0;
    let failed = 0;

    for (const recipient of unique) {
      const record = await SmsMessageModel.create({
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
        sentBy: ctx.userId,
        sentByNameSnapshot: ctx.userName,
      });

      try {
        const result = await provider.send({ to: recipient.phone, message: input.message });
        record.status = result.success ? 'sent' : 'failed';
        record.providerMessageId = result.providerMessageId;
        record.error = result.error ?? null;
        record.sentAt = result.success ? new Date() : null;
        if (!result.success) record.costMinor = 0;
        if (result.success) sent += 1;
        else failed += 1;
      } catch (error) {
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : 'Unknown error';
        record.costMinor = 0;
        failed += 1;
      }

      await record.save();
    }

    const actualCostMinor = perMessageCost * sent;
    const refundMinor = charge.amountMinor - actualCostMinor;

    if (refundMinor > 0) {
      // A workspace is never charged for a message the gateway did not accept.
      await usageChargeService.refund(charge._id, refundMinor, `Refund - ${failed} message(s) failed in "${input.name}"`, actorOf(ctx));
    }

    campaign.sentCount = sent;
    campaign.failedCount = failed;
    campaign.actualCostMinor = actualCostMinor;
    campaign.status = sent === 0 ? 'failed' : 'completed';
    campaign.completedAt = new Date();
    await campaign.save();

    if (failed > 0) logger.warn('SMS campaign completed with failures', { campaignId: String(campaign._id), sent, failed });

    return campaign.toObject();
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

    const valid = input.recipients.filter((r) => /.+@.+\..+/.test(r.email));
    if (valid.length === 0) throw ApiError.badRequest('None of the selected customers have a valid email address');

    // Sanitise HERE, not in the browser. The client sanitises so the preview is
    // honest, but a campaign can be posted straight to the API with no browser
    // involved, so this is the copy that decides what actually goes out.
    const safeHtml = sanitizeEmailHtml(input.body);
    if (safeHtml.trim().length === 0) {
      throw ApiError.badRequest('The campaign body is empty once scripts and unsafe markup are removed.');
    }
    const plainText = htmlToPlainText(safeHtml);

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
      status: 'sending',
      startedAt: new Date(),
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
    const perEmail = charge.unitPriceMinor;

    let sent = 0;
    let failed = 0;

    for (const recipient of valid) {
      const record = await SmsMessageModel.create({
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
        sentBy: ctx.userId,
        sentByNameSnapshot: ctx.userName,
      });

      // Sent as HTML with a text fallback. It was previously passed as `text`
      // only, so recipients saw raw markup instead of a formatted email.
      const result = await provider.send({
        to: recipient.email,
        subject: input.subject,
        text: plainText,
        html: safeHtml,
      });
      record.status = result.success ? 'sent' : 'failed';
      record.providerMessageId = result.providerMessageId;
      record.error = result.error ?? null;
      record.sentAt = result.success ? new Date() : null;
      if (!result.success) record.costMinor = 0;
      if (result.success) sent += 1;
      else failed += 1;
      await record.save();
    }

    const actualCostMinor = perEmail * sent;
    const refundMinor = charge.amountMinor - actualCostMinor;
    if (refundMinor > 0) {
      await usageChargeService.refund(charge._id, refundMinor, `Refund - ${failed} email(s) failed in "${input.name}"`, actorOf(ctx));
    }

    campaign.sentCount = sent;
    campaign.failedCount = failed;
    campaign.actualCostMinor = actualCostMinor;
    campaign.status = sent === 0 ? 'failed' : 'completed';
    campaign.completedAt = new Date();
    await campaign.save();

    return campaign.toObject();
  }
}

export const smsService = new SmsService();
