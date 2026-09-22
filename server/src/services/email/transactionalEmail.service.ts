import type { Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { AccountModel } from '../../models/Account';
import { EmailNotificationModel, type EmailNotificationDoc, type EmailNotificationType } from '../../models/EmailNotification';
import { InvoiceModel } from '../../models/Invoice';
import { PaymentModel } from '../../models/Payment';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { SubscriptionModel, type SubscriptionDoc } from '../../models/Subscription';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { logger } from '../../utils/logger';
import { offerForPlan } from '../subscription/purchasePricing.service';
import { canRenewAutomatically } from '../subscription/renewalCapability';
import { RENEWAL_REMINDER_LEAD_MS } from '../subscription/renewalPolicy';
import { walletService } from '../wallet/wallet.service';
import { emailService, type SendEmailInput, type SendEmailResult } from './index';
import { renderExpiryReminderEmail, renderInvoiceEmail, type RenderedEmail } from './templates/subscriptionEmails';

/**
 * Transactional billing emails: the invoice for a purchase, the confirmation
 * for a renewal, and the reminder before a period ends.
 *
 * Emails are strictly AFTER the money: they are triggered once an invoice
 * exists (which only happens for a paid payment), never decide whether a
 * payment succeeded, and never throw into the billing path. Each email is a row
 * keyed by what it is about, so a webhook retry, a second scheduler run or a
 * second worker cannot send it twice - and a failure is kept for retry with the
 * same invoice.
 */

const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Invoices issued for payments older than this (a backfill, a late sweep) are not emailed out of the blue. */
const FRESH_PAYMENT_MS = 2 * DAY_MS;
/** A failed email is retried no sooner than this. */
const RETRY_AFTER_MS = 30 * 60 * 1000;

export interface EmailSender {
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** Test seam: production sends through the configured SMTP provider. */
let senderOverride: EmailSender | null = null;
export function setTransactionalEmailSender(sender: EmailSender | null) {
  senderOverride = sender;
}

export type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'already_sent' | 'in_progress' | 'gave_up';

type Build = () => Promise<({ to: string } & RenderedEmail) | { skip: string }>;
interface RowMeta {
  type: EmailNotificationType;
  accountId?: Types.ObjectId | null;
  tenantId?: Types.ObjectId | null;
  subscriptionId?: Types.ObjectId | null;
  paymentId?: Types.ObjectId | null;
  invoiceId?: Types.ObjectId | null;
}

const isEmail = (value: string | null | undefined): value is string => Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
/** Provider errors can echo connection details; keep them short and credential-free. */
const safeError = (value: unknown) =>
  String(value instanceof Error ? value.message : (value ?? 'Send failed'))
    .replace(/(pass(word)?|pwd|auth|token|key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);

/**
 * Sends the email behind `key` at most once. Creates the row if needed, then
 * claims it with a short lease so only one worker attempts it at a time.
 */
async function deliver(key: string, meta: RowMeta, build: Build): Promise<DeliveryOutcome> {
  try {
    await EmailNotificationModel.updateOne(
      { key },
      { $setOnInsert: { key, status: 'pending', attempts: 0, accountId: null, tenantId: null, subscriptionId: null, paymentId: null, invoiceId: null, ...meta } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  const now = new Date();
  const claimed = await EmailNotificationModel.findOneAndUpdate(
    { key, status: { $in: ['pending', 'failed'] }, attempts: { $lt: MAX_ATTEMPTS }, $or: [{ claimedUntil: null }, { claimedUntil: { $lt: now } }] },
    { $set: { claimedUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now }, $inc: { attempts: 1 } },
    { new: true },
  ).lean<EmailNotificationDoc & { _id: Types.ObjectId }>();

  if (!claimed) {
    const row = await EmailNotificationModel.findOne({ key }).select('status attempts').lean();
    if (row?.status === 'sent') return 'already_sent';
    if (row?.status === 'skipped') return 'skipped';
    if ((row?.attempts ?? 0) >= MAX_ATTEMPTS) return 'gave_up';
    return 'in_progress';
  }

  const finish = (set: Record<string, unknown>) =>
    EmailNotificationModel.updateOne({ _id: claimed._id }, { $set: { claimedUntil: null, ...set } });

  try {
    const built = await build();
    if ('skip' in built) {
      await finish({ status: 'skipped', lastError: built.skip.slice(0, 300) });
      return 'skipped';
    }
    const sender: EmailSender = senderOverride ?? (await emailService.provider());
    if (!sender.isConfigured()) {
      await finish({ status: 'failed', recipient: built.to, subject: built.subject, lastError: 'Email is not configured' });
      logger.warn('A billing email could not be sent: email is not configured', { key, type: meta.type });
      return 'failed';
    }
    const result = await sender
      .send({ to: built.to, subject: built.subject, html: built.html, text: built.text })
      .catch((error: unknown) => ({ success: false, providerMessageId: null, error: safeError(error) }) as SendEmailResult);
    if (result.success) {
      await finish({ status: 'sent', recipient: built.to, subject: built.subject, sentAt: new Date(), lastError: '' });
      return 'sent';
    }
    await finish({ status: 'failed', recipient: built.to, subject: built.subject, lastError: safeError(result.error) });
    logger.warn('A billing email could not be delivered', { key, type: meta.type, attempt: claimed.attempts, error: safeError(result.error) });
    return 'failed';
  } catch (error) {
    await finish({ status: 'failed', lastError: safeError(error) }).catch(() => undefined);
    logger.error('Building a billing email failed', { key, type: meta.type, error: safeError(error) });
    return 'failed';
  }
}

/** The account's billing address: the invoice snapshot, else the owner's login email. */
async function ownerOf(tenantId: Types.ObjectId) {
  const workspace = await TenantModel.findById(tenantId).select('name ownerUserId accountId status').lean();
  if (!workspace) return null;
  const [owner, account] = await Promise.all([
    UserModel.findOne({ _id: workspace.ownerUserId, deletedAt: null }).select('name email').lean(),
    workspace.accountId ? AccountModel.findById(workspace.accountId).select('name contactEmail').lean() : null,
  ]);
  return { workspace, owner, account };
}

/**
 * Emails the invoice for a paid subscription payment: an invoice for a
 * purchase, a payment confirmation for a renewal. Keyed by the invoice, so the
 * same payment is emailed once whichever path (webhook, callback, approval,
 * sweep) issued its invoice.
 */
export async function sendInvoiceEmail(invoiceId: Types.ObjectId, options: { ignoreFreshness?: boolean; now?: Date } = {}): Promise<DeliveryOutcome> {
  const now = options.now ?? new Date();
  const invoice = await InvoiceModel.findById(invoiceId).lean();
  if (!invoice) return 'skipped';
  const payment = await PaymentModel.findById(invoice.paymentId).select('status metadata paidAt').lean();
  // Demo data is never mailed.
  if ((payment?.metadata as { seeded?: boolean } | undefined)?.seeded) return 'skipped';
  const paidAt = invoice.payment?.paidAt ?? invoice.issuedAt;
  if (!options.ignoreFreshness && now.getTime() - new Date(paidAt).getTime() > FRESH_PAYMENT_MS) return 'skipped';

  const type: EmailNotificationType = invoice.kind === 'renewal' ? 'payment_confirmation' : 'subscription_invoice';
  return deliver(
    `invoice:${String(invoice._id)}`,
    { type, accountId: invoice.accountId, tenantId: invoice.tenantId, subscriptionId: invoice.subscriptionId, paymentId: invoice.paymentId, invoiceId: invoice._id },
    async () => {
      const people = await ownerOf(invoice.tenantId);
      const to = [invoice.billedTo?.email, people?.owner?.email, people?.account?.contactEmail].find(isEmail);
      if (!to) return { skip: 'The account has no billing email address' };
      const settings = await getPlatformSettings();
      const line = invoice.lines?.[0];
      return {
        to: to.trim().toLowerCase(),
        ...renderInvoiceEmail({
          number: invoice.number,
          issuedAt: invoice.issuedAt,
          kind: invoice.kind,
          currency: invoice.currency,
          billedTo: { accountName: invoice.billedTo?.accountName || people?.owner?.name || '', workspaceName: invoice.billedTo?.workspaceName || people?.workspace.name || '', email: to },
          line: line ? { planName: line.planName, billingCycle: line.billingCycle, posType: line.posType, periodStart: line.periodStart, periodEnd: line.periodEnd } : null,
          subtotalMinor: invoice.subtotalMinor,
          discountMinor: invoice.discountMinor,
          couponCode: (invoice as { couponCode?: string | null }).couponCode ?? null,
          creditMinor: invoice.creditMinor,
          adjustmentMinor: invoice.adjustmentMinor,
          totalMinor: invoice.totalMinor,
          payment: { method: invoice.payment?.method ?? '', reference: invoice.payment?.reference ?? null, paidAt },
          supportEmail: isEmail(settings.supportEmail) ? settings.supportEmail : undefined,
        }),
      };
    },
  );
}

/** For the invoice path: never throws, never waits on the mail server. */
export function queueInvoiceEmail(invoiceId: Types.ObjectId | null | undefined) {
  if (!invoiceId) return;
  setImmediate(() => {
    sendInvoiceEmail(invoiceId).catch((error: unknown) => logger.error('Queueing an invoice email failed', { invoiceId: String(invoiceId), error: safeError(error) }));
  });
}

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };
const RUNNING = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL] as string[];

const reminderKey = (subscription: Pick<SubscriptionRecord, '_id' | 'currentPeriodEnd'>) =>
  `expiry_3day:${String(subscription._id)}:${new Date(subscription.currentPeriodEnd).toISOString()}`;

/** Whether this exact period still warrants a reminder right now. */
async function reminderStillDue(subscription: SubscriptionRecord, now: Date) {
  if (!RUNNING.includes(subscription.status) || subscription.cancelAtPeriodEnd) return false;
  const end = new Date(subscription.currentPeriodEnd).getTime();
  if (end <= now.getTime() || end > now.getTime() + RENEWAL_REMINDER_LEAD_MS) return false;
  // Superseded by a newer period (renewed early): that period gets its own reminder.
  if (await SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } })) return false;
  return true;
}

async function remindOne(subscription: SubscriptionRecord, now: Date) {
  const plan = await SubscriptionPlanModel.findOne({ _id: subscription.scheduledChange?.planId ?? subscription.planId, isActive: true });
  const offer = plan ? await offerForPlan(subscription.tenantId, plan).catch(() => null) : null;
  const { balanceMinor, currency } = await walletService.balance(subscription.tenantId);
  const lowBalance = !offer || balanceMinor < offer.listPriceMinor;

  const outcome = await deliver(
    reminderKey(subscription),
    { type: 'subscription_expiry_reminder', accountId: subscription.accountId ?? null, tenantId: subscription.tenantId, subscriptionId: subscription._id },
    async () => {
      // Re-checked at the moment of this run, so a period that changed while waiting is not reminded.
      if (!(await reminderStillDue(subscription, now))) return { skip: 'The period changed before the reminder was sent' };
      const people = await ownerOf(subscription.tenantId);
      if (!people || people.workspace.status === 'suspended') return { skip: 'The workspace is not active' };
      const to = [people.owner?.email, people.account?.contactEmail].find(isEmail);
      if (!to) return { skip: 'The account has no billing email address' };
      const settings = await getPlatformSettings();
      const isTrial = subscription.status === SUBSCRIPTION_STATUS.TRIAL;
      const renewal = subscription.autoRenew && subscription.renewWith === 'wallet' ? 'wallet_auto' : subscription.autoRenew && canRenewAutomatically(subscription) ? 'provider_auto' : 'manual';
      return {
        to: to.trim().toLowerCase(),
        ...renderExpiryReminderEmail({
          customerName: people.owner?.name ?? '',
          workspaceName: people.workspace.name,
          planName: plan?.name ?? subscription.planSnapshot?.name ?? 'your plan',
          billingCycle: subscription.billingCycle ?? (subscription.planSnapshot?.interval === 'yearly' ? 'annual' : 'monthly'),
          posType: subscription.posProductCode ?? 'clothing',
          isTrial,
          periodEnd: subscription.currentPeriodEnd,
          daysLeft: Math.ceil((new Date(subscription.currentPeriodEnd).getTime() - now.getTime()) / DAY_MS),
          renewalAmountMinor: offer?.listPriceMinor ?? null,
          walletBalanceMinor: balanceMinor,
          currency: offer?.currency ?? currency,
          renewal,
          supportEmail: isEmail(settings.supportEmail) ? settings.supportEmail : undefined,
        }),
      };
    },
  );
  if (outcome === 'sent') {
    await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: { renewalReminderSentAt: now } }, { timestamps: false });
  }
  return { outcome, lowBalance };
}

/**
 * The reminder pass: every running subscription whose period ends within the
 * reminder lead (3 days), one email per workspace subscription PER PERIOD. Safe
 * to run any number of times, on any number of workers.
 */
export async function sendExpiryReminders(now = new Date()) {
  const due = await SubscriptionModel.find({
    status: { $in: RUNNING },
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + RENEWAL_REMINDER_LEAD_MS) },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(500)
    .lean<SubscriptionRecord[]>();

  const result = { due: due.length, lowBalance: 0, sent: 0 };
  for (const subscription of due) {
    if (!(await reminderStillDue(subscription, now))) continue;
    const { outcome, lowBalance } = await remindOne(subscription, now);
    if (lowBalance) result.lowBalance += 1;
    if (outcome === 'sent') result.sent += 1;
  }
  return result;
}

/** Retries emails that failed earlier - the same invoice, the same period, never a new one. */
export async function retryFailedEmails(now = new Date(), limit = 50) {
  const rows = await EmailNotificationModel.find({
    status: { $in: ['failed', 'pending'] },
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ lastAttemptAt: null }, { lastAttemptAt: { $lt: new Date(now.getTime() - RETRY_AFTER_MS) } }],
  })
    .sort({ lastAttemptAt: 1 })
    .limit(limit)
    .lean();

  const result = { checked: rows.length, sent: 0 };
  for (const row of rows) {
    const outcome = await retryEmail(row, now);
    if (outcome === 'sent') result.sent += 1;
  }
  return result;
}

export async function retryEmail(row: Pick<EmailNotificationDoc, 'key' | 'type' | 'invoiceId' | 'subscriptionId'>, now = new Date()): Promise<DeliveryOutcome> {
  if (row.invoiceId && (row.type === 'subscription_invoice' || row.type === 'payment_confirmation')) {
    return sendInvoiceEmail(row.invoiceId, { ignoreFreshness: true, now });
  }
  if (row.type === 'subscription_expiry_reminder' && row.subscriptionId) {
    const subscription = await SubscriptionModel.findById(row.subscriptionId).lean<SubscriptionRecord>();
    if (!subscription || reminderKey(subscription) !== row.key || !(await reminderStillDue(subscription, now))) {
      await EmailNotificationModel.updateOne({ key: row.key, status: { $ne: 'sent' } }, { $set: { status: 'skipped', lastError: 'The period changed before the reminder was sent', claimedUntil: null } });
      return 'skipped';
    }
    return (await remindOne(subscription, now)).outcome;
  }
  return 'skipped';
}

/** Admin retry: gives a failed or exhausted email a fresh set of attempts. */
export async function adminRetryEmail(id: Types.ObjectId) {
  const row = await EmailNotificationModel.findOneAndUpdate(
    { _id: id, status: { $in: ['failed', 'pending'] } },
    { $set: { attempts: 0, claimedUntil: null } },
    { new: true },
  ).lean();
  if (!row) return null;
  const outcome = await retryEmail(row);
  return { outcome, row: await EmailNotificationModel.findById(id).lean() };
}
