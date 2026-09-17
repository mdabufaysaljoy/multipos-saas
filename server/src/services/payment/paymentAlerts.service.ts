import { PAYMENT_PROVIDERS, PAYMENT_STATUS, ROLES } from '../../config/constants';
import { env } from '../../config/env';
import { PaymentModel } from '../../models/Payment';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { UserModel } from '../../models/User';
import { logger } from '../../utils/logger';
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml';
import { emailService, type SendEmailInput, type SendEmailResult } from '../email';
import { formatDate } from './alertFormat';

export interface AlertSender {
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export type AlertDigestStatus = 'disabled' | 'nothing_to_send' | 'no_recipients' | 'not_configured' | 'failed' | 'sent';

export interface AlertDigestResult {
  status: AlertDigestStatus;
  review: number;
  stale: number;
  recipients: number;
  delivered: number;
  error?: string;
}

export interface AlertDigestOptions {
  now?: Date;
  /** A gateway payment still pending after this long is worth a human look. */
  staleAfterMs?: number;
  limit?: number;
  /** Test seam; production uses the configured SMTP provider. */
  sender?: AlertSender;
}

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

type AlertPayment = {
  _id: unknown;
  amountMinor: number;
  currency: string;
  provider: string;
  createdAt: Date;
  review?: { reason?: string };
  tenantId?: { name?: string } | null;
};

/**
 * One digest email to platform admins about payments that need a human:
 * newly flagged for review, and gateway payments pending over an hour.
 *
 * Each payment is announced once (a review is announced again if it is
 * re-flagged later). Payments are only marked as announced after at least one
 * recipient actually received the email, so a mail outage delays alerts rather
 * than losing them. Everything taken from workspaces (names, reasons) is
 * escaped, and the finished HTML is sanitised before it is sent.
 */
export async function sendPaymentAlertDigest(options: AlertDigestOptions = {}): Promise<AlertDigestResult> {
  const startedAt = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 60 * 60 * 1000;
  const limit = options.limit ?? 50;

  const settings = await getPlatformSettings();
  if (settings.paymentAlerts?.enabled === false) return { status: 'disabled', review: 0, stale: 0, recipients: 0, delivered: 0 };

  const reviewFilter = {
    'review.required': true,
    'review.resolvedAt': null,
    'review.flaggedAt': { $lte: startedAt },
    $or: [{ 'alerts.reviewNotifiedAt': null }, { $expr: { $lt: ['$alerts.reviewNotifiedAt', '$review.flaggedAt'] } }],
  };
  const staleFilter = {
    status: PAYMENT_STATUS.PENDING,
    provider: { $ne: PAYMENT_PROVIDERS.MANUAL },
    createdAt: { $lte: new Date(startedAt.getTime() - staleAfterMs) },
    'alerts.staleNotifiedAt': null,
  };

  const [review, stale] = await Promise.all([
    PaymentModel.find(reviewFilter).sort({ 'review.flaggedAt': 1 }).limit(limit).populate('tenantId', 'name').lean<AlertPayment[]>(),
    PaymentModel.find(staleFilter).sort({ createdAt: 1 }).limit(limit).populate('tenantId', 'name').lean<AlertPayment[]>(),
  ]);
  const counts = { review: review.length, stale: stale.length };
  if (review.length === 0 && stale.length === 0) return { status: 'nothing_to_send', ...counts, recipients: 0, delivered: 0 };

  const admins = await UserModel.find({ role: ROLES.PLATFORM_ADMIN, isActive: true, deletedAt: null }).select('email').lean();
  const recipients = [...new Set([...admins.map((a) => a.email), ...(settings.paymentAlerts?.recipients ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) return { status: 'no_recipients', ...counts, recipients: 0, delivered: 0 };

  const sender: AlertSender = options.sender ?? (await emailService.provider());
  if (!sender.isConfigured()) {
    logger.warn('Payment alerts are waiting: no email provider is configured', counts);
    return { status: 'not_configured', ...counts, recipients: recipients.length, delivered: 0 };
  }

  const subject = `[Payments] ${review.length} need review, ${stale.length} pending over an hour`;
  const { html, text } = renderDigest(review, stale, startedAt);

  let delivered = 0;
  let lastError: string | undefined;
  for (const to of recipients) {
    try {
      const result = await sender.send({ to, subject, html, text });
      if (result.success) delivered += 1;
      else lastError = result.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Send failed';
    }
  }

  if (delivered === 0) {
    logger.warn('Payment alert digest could not be delivered; it will be retried', { ...counts, error: lastError });
    return { status: 'failed', ...counts, recipients: recipients.length, delivered, error: lastError };
  }

  // Marked with the time the digest was PREPARED: a review re-flagged after that
  // moment carries a later flaggedAt and is announced again next time.
  await Promise.all([
    PaymentModel.updateMany(
      { _id: { $in: review.map((p) => p._id) }, 'review.flaggedAt': { $lte: startedAt } },
      { $set: { 'alerts.reviewNotifiedAt': startedAt } },
      { timestamps: false },
    ),
    PaymentModel.updateMany({ _id: { $in: stale.map((p) => p._id) } }, { $set: { 'alerts.staleNotifiedAt': startedAt } }, { timestamps: false }),
  ]);

  return { status: 'sent', ...counts, recipients: recipients.length, delivered };
}

function renderDigest(review: AlertPayment[], stale: AlertPayment[], at: Date) {
  const deskUrl = `${env.CLIENT_ORIGIN.split(',')[0].trim().replace(/\/$/, '')}/platform`;
  const row = (p: AlertPayment, note: string) =>
    `<tr><td>${escapeHtml(p.tenantId?.name ?? 'Unknown workspace')}</td><td>${escapeHtml(money(p.amountMinor, p.currency))}</td><td>${escapeHtml(p.provider)}</td><td>${escapeHtml(note)}</td></tr>`;
  const table = (rows: string) =>
    `<table width="100%" style="border-collapse:collapse" align="left"><thead><tr><th align="left">Workspace</th><th align="left">Amount</th><th align="left">Provider</th><th align="left">Why</th></tr></thead><tbody>${rows}</tbody></table>`;

  const parts = [`<h2>Payments needing attention</h2><p>Summary prepared ${escapeHtml(formatDate(at))}.</p>`];
  if (review.length > 0) {
    parts.push(`<h3>Needs review (${review.length})</h3>`, table(review.map((p) => row(p, p.review?.reason ?? 'Flagged for review')).join('')));
  }
  if (stale.length > 0) {
    parts.push(`<h3>Pending over an hour (${stale.length})</h3>`, table(stale.map((p) => row(p, `Pending since ${formatDate(p.createdAt)}`)).join('')));
  }
  parts.push(`<p><a href="${escapeHtml(deskUrl)}">Open payment operations</a></p>`);
  const html = sanitizeEmailHtml(parts.join(''));

  const lines = ['Payments needing attention', ''];
  if (review.length > 0) {
    lines.push(`Needs review (${review.length}):`);
    review.forEach((p) => lines.push(`- ${p.tenantId?.name ?? 'Unknown workspace'}: ${money(p.amountMinor, p.currency)} via ${p.provider} - ${p.review?.reason ?? ''}`));
    lines.push('');
  }
  if (stale.length > 0) {
    lines.push(`Pending over an hour (${stale.length}):`);
    stale.forEach((p) => lines.push(`- ${p.tenantId?.name ?? 'Unknown workspace'}: ${money(p.amountMinor, p.currency)} via ${p.provider} since ${formatDate(p.createdAt)}`));
    lines.push('');
  }
  lines.push(`Open payment operations: ${deskUrl}`);
  return { html, text: lines.join('\n') };
}
