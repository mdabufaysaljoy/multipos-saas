import { BRANDING } from '../../../config/branding';
import { brandedEmail, detailsTable, paragraph } from './layout';
import { formatDay, formatMoney, oneLine, paymentMethodLabel, posLabel } from './format';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface InvoiceEmailData {
  number: string;
  issuedAt: Date;
  kind: string;
  currency: string;
  billedTo: { accountName: string; workspaceName: string; email: string };
  line: { planName: string; billingCycle: string; posType: string; periodStart: Date | null; periodEnd: Date | null } | null;
  subtotalMinor: number;
  discountMinor: number;
  couponCode: string | null;
  creditMinor: number;
  adjustmentMinor: number;
  totalMinor: number;
  payment: { method: string; reference: string | null; paidAt: Date | null };
  supportEmail?: string;
}

const cycleLabel = (cycle: string) => (cycle === 'annual' ? 'Annual' : cycle === 'monthly' ? 'Monthly' : cycle);
const billingLink = (tab: string) => `${BRANDING.appUrl}/billing?tab=${tab}`;

/**
 * The invoice email. A first purchase, upgrade or assignment reads as an
 * invoice; a renewal reads as a payment confirmation - same invoice record,
 * same number, either way. Only fields the invoice actually carries are shown.
 */
export function renderInvoiceEmail(data: InvoiceEmailData): RenderedEmail {
  const renewal = data.kind === 'renewal';
  const brand = BRANDING.productName;
  const period = data.line?.periodStart && data.line?.periodEnd ? `${formatDay(data.line.periodStart)} → ${formatDay(data.line.periodEnd)}` : null;
  const method = paymentMethodLabel(data.payment.method);
  const total = formatMoney(data.totalMinor, data.currency);

  const subject = renewal
    ? `Payment Successful — Your ${brand} Subscription Is Renewed`
    : `Your ${brand} Subscription Invoice — ${data.number}`;

  const bodyHtml = [
    detailsTable('Invoice', [
      ['Invoice number', data.number],
      ['Date', formatDay(data.issuedAt)],
      ['Status', 'PAID', { tone: 'success', strong: false }],
    ]),
    detailsTable('Customer', [
      ['Name', data.billedTo.accountName],
      ['Email', data.billedTo.email],
    ]),
    detailsTable('Subscription', [
      ['Plan', data.line?.planName],
      ['Billing cycle', data.line ? cycleLabel(data.line.billingCycle) : null],
      ['POS type', posLabel(data.line?.posType)],
      ['Workspace', data.billedTo.workspaceName],
      [renewal ? 'New subscription period' : 'Subscription period', period],
    ]),
    detailsTable('Amount', [
      ['Subtotal', formatMoney(data.subtotalMinor, data.currency)],
      ...(data.discountMinor > 0 ? [[`Discount${data.couponCode ? ` (${data.couponCode})` : ''}`, `-${formatMoney(data.discountMinor, data.currency)}`] as [string, string]] : []),
      ...(data.creditMinor > 0 ? [['Credit for unused time', `-${formatMoney(data.creditMinor, data.currency)}`] as [string, string]] : []),
      ...(data.adjustmentMinor !== 0 ? [['Adjustment', formatMoney(data.adjustmentMinor, data.currency)] as [string, string]] : []),
      ['Total paid', total, { strong: true }],
    ]),
    detailsTable('Payment', [
      ['Payment method', method],
      ['Transaction ID', data.payment.reference],
      ['Paid on', formatDay(data.payment.paidAt)],
    ]),
  ].join('');

  const intro = renewal ? 'Your subscription has been successfully renewed.' : 'Thank you for your subscription.';
  const html = brandedEmail({
    preheader: renewal ? `Renewed · ${total} paid · Invoice ${data.number}` : `Invoice ${data.number} · ${total} paid`,
    title: 'Payment Successful',
    intro,
    statusLabel: 'PAID',
    bodyHtml,
    buttons: [{ label: 'View invoices', url: billingLink('invoices') }],
    supportEmail: data.supportEmail,
  });

  const text = [
    `Payment Successful`,
    intro,
    ``,
    `Invoice number: ${data.number}`,
    `Date: ${formatDay(data.issuedAt)}`,
    `Status: PAID`,
    ``,
    `Customer: ${data.billedTo.accountName} <${data.billedTo.email}>`,
    data.line ? `Plan: ${data.line.planName} (${cycleLabel(data.line.billingCycle)})` : '',
    data.line?.posType ? `POS type: ${posLabel(data.line.posType)}` : '',
    `Workspace: ${data.billedTo.workspaceName}`,
    period ? `${renewal ? 'New subscription period' : 'Subscription period'}: ${period}` : '',
    ``,
    `Total paid: ${total}`,
    method ? `Payment method: ${method}` : '',
    data.payment.reference ? `Transaction ID: ${data.payment.reference}` : '',
    ``,
    `View invoices: ${billingLink('invoices')}`,
    data.supportEmail ? `Questions? ${data.supportEmail}` : '',
    `${brand} · ${BRANDING.websiteUrl}`,
  ]
    .filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '')
    .join('\n');

  return { subject: oneLine(subject), html, text };
}

export interface ExpiryReminderData {
  customerName: string;
  workspaceName: string;
  planName: string;
  billingCycle: string;
  posType: string;
  isTrial: boolean;
  periodEnd: Date;
  daysLeft: number;
  /** What the renewal costs now, or null when the plan cannot be priced. */
  renewalAmountMinor: number | null;
  walletBalanceMinor: number;
  currency: string;
  /** What actually happens at the end of the period - the wording depends on it. */
  renewal: 'wallet_auto' | 'provider_auto' | 'manual';
  supportEmail?: string;
}

/**
 * The reminder sent ahead of a period ending. Its wording follows what the
 * system really does: only a subscription set to renew from the wallet is told
 * it renews automatically from the wallet.
 */
export function renderExpiryReminderEmail(data: ExpiryReminderData): RenderedEmail {
  const brand = BRANDING.productName;
  const days = Math.max(1, data.daysLeft);
  const dayWord = days === 1 ? 'Day' : 'Days';
  const endDate = formatDay(data.periodEnd);
  const neededMinor = data.renewalAmountMinor !== null ? Math.max(data.renewalAmountMinor - data.walletBalanceMinor, 0) : null;

  const subject = data.isTrial ? `Your ${brand} Free Trial Ends in ${days} ${dayWord}` : `Your ${brand} Subscription Expires in ${days} ${dayWord}`;
  const title = data.isTrial ? `Your free trial ends in ${days} ${dayWord.toLowerCase()}` : `Your subscription expires in ${days} ${dayWord.toLowerCase()}`;

  let behaviour: string;
  if (data.isTrial) {
    behaviour = `Your free trial of ${data.planName} for ${data.workspaceName} ends on ${endDate}. Choose a plan before then to keep using your POS without interruption.`;
  } else if (data.renewal === 'wallet_auto') {
    behaviour = `Your ${data.planName} subscription for ${data.workspaceName} will renew automatically using your wallet balance on ${endDate}. Please make sure your wallet has sufficient funds.`;
  } else if (data.renewal === 'provider_auto') {
    behaviour = `Your ${data.planName} subscription for ${data.workspaceName} is set to renew automatically on ${endDate} through its saved payment method.`;
  } else {
    behaviour = `Your ${data.planName} subscription for ${data.workspaceName} is scheduled to expire on ${endDate}. Please keep sufficient balance in your wallet or complete your renewal payment before the subscription expires.`;
  }

  const bodyHtml = [
    paragraph(`Hi ${data.customerName || 'there'},`),
    paragraph(behaviour),
    detailsTable(data.isTrial ? 'Your trial' : 'Your subscription', [
      ['Workspace', data.workspaceName],
      ['POS type', posLabel(data.posType)],
      ['Plan', data.planName],
      ['Billing', data.isTrial ? 'Free trial' : cycleLabel(data.billingCycle)],
      [data.isTrial ? 'Trial ends' : 'Expires on', endDate, { strong: false }],
    ]),
    data.isTrial
      ? ''
      : detailsTable('Renewal', [
          ['Renewal amount', data.renewalAmountMinor !== null ? formatMoney(data.renewalAmountMinor, data.currency) : 'Not available right now'],
          ['Current wallet balance', formatMoney(data.walletBalanceMinor, data.currency)],
          ...(neededMinor !== null && neededMinor > 0
            ? [['Amount needed', formatMoney(neededMinor, data.currency), { strong: true, tone: 'danger' as const }] as [string, string, { strong: boolean; tone: 'danger' }]]
            : []),
        ]),
  ].join('');

  const buttons = data.isTrial
    ? [{ label: 'Choose a Plan', url: billingLink('subscriptions') }]
    : [
        { label: 'Renew Subscription', url: billingLink('subscriptions') },
        { label: 'Add Money to Wallet', url: billingLink('wallet'), secondary: true },
      ];

  const html = brandedEmail({
    preheader: `${data.planName} for ${data.workspaceName} ${data.isTrial ? 'ends' : 'expires'} on ${endDate}`,
    title,
    intro: `${data.workspaceName} · ${data.planName}`,
    statusLabel: data.isTrial ? 'TRIAL ENDING' : 'EXPIRING SOON',
    statusTone: 'warning',
    bodyHtml,
    buttons,
    supportEmail: data.supportEmail,
  });

  const text = [
    title,
    ``,
    `Hi ${data.customerName || 'there'},`,
    behaviour,
    ``,
    `Workspace: ${data.workspaceName}`,
    `Plan: ${data.planName}`,
    data.isTrial ? '' : `Renewal amount: ${data.renewalAmountMinor !== null ? formatMoney(data.renewalAmountMinor, data.currency) : 'Not available right now'}`,
    data.isTrial ? '' : `Current wallet balance: ${formatMoney(data.walletBalanceMinor, data.currency)}`,
    !data.isTrial && neededMinor ? `Amount needed: ${formatMoney(neededMinor, data.currency)}` : '',
    ``,
    ...buttons.map((button) => `${button.label}: ${button.url}`),
    data.supportEmail ? `Questions? ${data.supportEmail}` : '',
    `${brand} · ${BRANDING.websiteUrl}`,
  ]
    .filter((line, index, all) => line !== '' || (all[index - 1] ?? '') !== '')
    .join('\n');

  return { subject: oneLine(subject), html, text };
}
