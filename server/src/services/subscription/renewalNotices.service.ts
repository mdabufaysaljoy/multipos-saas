import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { SubscriptionModel, type SubscriptionDoc } from '../../models/Subscription';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { logger } from '../../utils/logger';
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml';
import { emailService, type SendEmailInput, type SendEmailResult } from '../email';
import { formatDate } from '../payment/alertFormat';
import { minorToDecimalString } from '../payment/money';
import { walletService } from '../wallet/wallet.service';
import { offerForPlan } from './purchasePricing.service';
import { RENEWAL_MAX_ATTEMPTS, RENEWAL_REMINDER_LEAD_MS } from './renewalPolicy';

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };

export interface NoticeSender {
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export type RenewalNoticeKind = 'low_balance' | 'renewal_failed' | 'auto_renew_stopped' | 'renewal_unavailable';
export type RenewalNoticeStatus = 'sent' | 'no_recipients' | 'not_configured' | 'failed';

export interface RenewalNotice {
  kind: RenewalNoticeKind;
  tenantId: Types.ObjectId;
  planName: string;
  periodEnd: Date;
  amountMinor?: number | null;
  currency?: string | null;
  balanceMinor?: number | null;
  reason?: string | null;
  attempt?: number;
  graceEndsAt?: Date | null;
}

/** Test seam: production sends through the configured SMTP provider. */
let senderOverride: NoticeSender | null = null;
export function setRenewalNoticeSender(sender: NoticeSender | null) {
  senderOverride = sender;
}

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Subjects are headers: no line breaks may reach them. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 150);

function render(notice: RenewalNotice, workspaceName: string) {
  const money = (minor: number | null | undefined) => `${minorToDecimalString(minor ?? 0)} ${notice.currency ?? 'BDT'}`;
  const billingUrl = `${env.CLIENT_ORIGIN.split(',')[0].trim().replace(/\/$/, '')}/subscription`;
  const reason = notice.reason ? ` Reason: ${notice.reason}` : '';

  let subject: string;
  let lines: string[];
  switch (notice.kind) {
    case 'low_balance':
      subject = `Top up your wallet to renew ${notice.planName}`;
      lines = [
        `${workspaceName}: ${notice.planName} renews automatically from your wallet on ${formatDate(notice.periodEnd)}.`,
        notice.amountMinor != null
          ? `The renewal costs ${money(notice.amountMinor)} and the wallet holds ${money(notice.balanceMinor)}.`
          : `The renewal cannot be priced right now.${reason}`,
        'Top up the wallet before then so the POS keeps running without interruption.',
      ];
      break;
    case 'renewal_failed':
      subject = `Automatic renewal of ${notice.planName} failed`;
      lines = [
        `${workspaceName}: renewing ${notice.planName} from the wallet did not go through (attempt ${notice.attempt ?? 1} of ${RENEWAL_MAX_ATTEMPTS}).${reason}`,
        notice.graceEndsAt
          ? `The POS keeps working until ${formatDate(notice.graceEndsAt)} while the renewal is tried again.`
          : 'The renewal will be tried again.',
        'Top up the wallet or renew from the billing page to keep your plan.',
      ];
      break;
    case 'auto_renew_stopped':
      subject = `Your ${notice.planName} subscription has ended`;
      lines = [
        `${workspaceName}: ${notice.planName} could not be renewed automatically, so automatic renewal has been switched off and the subscription has ended.${reason}`,
        'Your data is kept. Renew from the billing page to use the POS again.',
      ];
      break;
    case 'renewal_unavailable':
      subject = `Renew ${notice.planName} to keep using the POS`;
      lines = [
        `${workspaceName}: the period on ${notice.planName} ended on ${formatDate(notice.periodEnd)}. Its payment method cannot renew automatically.`,
        'Renew from the billing page to keep using the POS.',
      ];
      break;
  }
  lines.push(`Manage billing: ${billingUrl}`);
  return {
    subject: oneLine(subject),
    text: lines.join('\n\n'),
    html: sanitizeEmailHtml(lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')),
  };
}

/**
 * Emails the workspace owner (and the workspace contact address) about their
 * renewal. A system message: it never charges the workspace wallet. Never
 * throws - a notice that cannot be delivered must not undo a renewal.
 */
export async function sendRenewalNotice(notice: RenewalNotice): Promise<RenewalNoticeStatus> {
  try {
    const workspace = await TenantModel.findById(notice.tenantId).select('name ownerUserId contactEmail').lean();
    if (!workspace) return 'no_recipients';
    const owner = await UserModel.findOne({ _id: workspace.ownerUserId, isActive: true, deletedAt: null }).select('email').lean();
    const recipients = [...new Set([owner?.email, workspace.contactEmail].map((email) => (email ?? '').trim().toLowerCase()).filter(Boolean))];
    if (recipients.length === 0) return 'no_recipients';

    const sender: NoticeSender = senderOverride ?? (await emailService.provider());
    if (!sender.isConfigured()) return 'not_configured';

    const message = render(notice, workspace.name);
    let delivered = 0;
    for (const to of recipients) {
      const result = await sender.send({ to, ...message }).catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : 'Send failed' }));
      if (result.success) delivered += 1;
    }
    if (delivered === 0) {
      logger.warn('A renewal notice could not be delivered', { kind: notice.kind, tenantId: String(notice.tenantId) });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    logger.error('Sending a renewal notice failed', { kind: notice.kind, tenantId: String(notice.tenantId), error: error instanceof Error ? error.message : 'unknown' });
    return 'failed';
  }
}

/**
 * Warns owners, RENEWAL_REMINDER_LEAD_MS ahead, when an automatic wallet
 * renewal will not go through: the wallet holds less than the renewal's price
 * (the pricing engine's price now, for the plan it will renew into), or that
 * plan cannot be priced. Once per period, and only marked once delivered, so a
 * mail outage delays the warning rather than losing it.
 */
export async function sendRenewalReminders(now = new Date()) {
  const due = await SubscriptionModel.find({
    renewWith: 'wallet',
    autoRenew: true,
    cancelAtPeriodEnd: false,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL] },
    currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + RENEWAL_REMINDER_LEAD_MS) },
    renewalReminderSentAt: null,
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(200)
    .lean<SubscriptionRecord[]>();

  const result = { due: due.length, lowBalance: 0, sent: 0 };
  for (const subscription of due) {
    // Superseded by a newer period: that one gets its own reminder.
    if (await SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } })) continue;

    const plan = await SubscriptionPlanModel.findOne({ _id: subscription.scheduledChange?.planId ?? subscription.planId, isActive: true });
    const offer = plan ? await offerForPlan(subscription.tenantId, plan).catch(() => null) : null;
    const { balanceMinor, currency } = await walletService.balance(subscription.tenantId);
    if (offer && balanceMinor >= offer.listPriceMinor) continue;

    result.lowBalance += 1;
    const status = await sendRenewalNotice({
      kind: 'low_balance',
      tenantId: subscription.tenantId,
      planName: plan?.name ?? subscription.scheduledChange?.planName ?? subscription.planSnapshot?.name ?? 'your plan',
      periodEnd: subscription.currentPeriodEnd,
      amountMinor: offer?.listPriceMinor ?? null,
      currency: offer?.currency ?? currency,
      balanceMinor,
      reason: plan ? null : 'the plan it renews into is no longer available',
    });
    if (status === 'sent') {
      await SubscriptionModel.updateOne({ _id: subscription._id, renewalReminderSentAt: null }, { $set: { renewalReminderSentAt: now } }, { timestamps: false });
      result.sent += 1;
    }
  }
  return result;
}
