import { Types } from 'mongoose';
import { env } from '../../config/env';
import { PAYMENT_STATUS } from '../../config/constants';
import { AccountModel } from '../../models/Account';
import { nextDocumentSequence } from '../../models/DocumentSequence';
import { InvoiceModel, type InvoiceDoc } from '../../models/Invoice';
import { PaymentModel, type PaymentDoc } from '../../models/Payment';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { SubscriptionModel } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';

type InvoiceRecord = InvoiceDoc & { _id: Types.ObjectId };
type PaymentRecord = PaymentDoc & { _id: Types.ObjectId };

/** Payments that were paid, including ones refunded since: they were still paid for. */
const INVOICEABLE: string[] = [PAYMENT_STATUS.PAID, PAYMENT_STATUS.REFUNDED];
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const wholeMinor = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

const POS_LABEL: Record<string, string> = { clothing: 'Clothing', restaurant: 'Restaurant', pharmacy: 'Pharmacy', supershop: 'Super shop', grocery: 'Grocery' };

export const formatInvoiceNumber = (year: number, sequence: number) => `INV-${year}-${String(sequence).padStart(6, '0')}`;

async function linkPayment(paymentId: Types.ObjectId, invoiceId: Types.ObjectId) {
  await PaymentModel.updateOne({ _id: paymentId, invoiceId: null }, { $set: { invoiceId } }, { timestamps: false });
}

/**
 * Issues the invoice for a paid subscription payment, exactly once.
 *
 * Every figure is a snapshot of what the payment itself recorded when it was
 * taken - the list price the pricing engine quoted, the coupon discount on its
 * upgrade request, the credit for unused time - never today's prices. A
 * payment not yet turned into a subscription period gets its invoice later
 * (the sweep picks it up). Safe to call any number of times, concurrently.
 */
export async function issueInvoiceForPayment(paymentId: Types.ObjectId): Promise<InvoiceRecord | null> {
  const existing = await InvoiceModel.findOne({ paymentId }).lean<InvoiceRecord>();
  if (existing) {
    await linkPayment(paymentId, existing._id);
    return existing;
  }

  const payment = await PaymentModel.findById(paymentId).lean<PaymentRecord>();
  if (!payment || !INVOICEABLE.includes(payment.status) || !payment.subscriptionId || !payment.planId) return null;
  const subscription = await SubscriptionModel.findById(payment.subscriptionId).lean();
  if (!subscription || !subscription.tenantId.equals(payment.tenantId)) return null;

  const metadata = (payment.metadata ?? {}) as Record<string, unknown>;
  const requestId = typeof metadata.upgradeRequestId === 'string' && Types.ObjectId.isValid(metadata.upgradeRequestId) ? new Types.ObjectId(metadata.upgradeRequestId) : null;
  const [workspace, request, settings] = await Promise.all([
    TenantModel.findById(payment.tenantId).select('name accountId ownerUserId contactEmail contactPhone country').lean(),
    requestId ? UpgradeRequestModel.findOne({ _id: requestId, tenantId: payment.tenantId }).select('discountMinor couponCodeSnapshot transitionKind').lean() : null,
    getPlatformSettings(),
  ]);
  const account = workspace?.accountId ? await AccountModel.findById(workspace.accountId).select('name contactEmail contactPhone country').lean() : null;
  const owner = workspace ? await UserModel.findById(workspace.ownerUserId).select('name email').lean() : null;

  const pricing = (metadata.pricing ?? {}) as { listPriceMinor?: unknown; billingCycle?: unknown; posType?: unknown };
  const snapshot = subscription.planSnapshot;
  const totalMinor = payment.amountMinor;
  const discountMinor = wholeMinor(request?.discountMinor) ?? 0;
  const creditMinor = wholeMinor(metadata.prorationCreditAppliedMinor) ?? 0;
  // Older payments did not record a list price: what was paid stands for it.
  const unitAmountMinor = wholeMinor(pricing.listPriceMinor) ?? totalMinor + discountMinor + creditMinor;
  const adjustmentMinor = totalMinor - (unitAmountMinor - discountMinor - creditMinor);

  const billingCycle =
    pricing.billingCycle === 'annual' || pricing.billingCycle === 'monthly'
      ? pricing.billingCycle
      : (subscription.billingCycle ?? (snapshot?.interval === 'yearly' ? 'annual' : 'monthly'));
  const posType = typeof pricing.posType === 'string' ? pricing.posType : (subscription.posProductCode ?? snapshot?.vertical ?? 'clothing');
  // Automatic or owner-initiated, a renewal is a renewal.
  const kind = metadata.autoRenewal || metadata.renewal
    ? 'renewal'
    : (request?.transitionKind ?? (metadata.recordedBy ? 'assigned' : metadata.seeded ? 'assigned' : 'purchase'));

  const issuedAt = payment.paidAt ?? payment.createdAt ?? new Date();
  const year = issuedAt.getUTCFullYear();

  // Checked again right before a number is spent, to keep numbering gap-free in the common case.
  const raced = await InvoiceModel.findOne({ paymentId }).lean<InvoiceRecord>();
  if (raced) {
    await linkPayment(paymentId, raced._id);
    return raced;
  }
  const sequence = await nextDocumentSequence(`invoice:${year}`);

  try {
    const invoice = await InvoiceModel.create({
      number: formatInvoiceNumber(year, sequence),
      year,
      sequence,
      accountId: workspace?.accountId ?? null,
      tenantId: payment.tenantId,
      paymentId: payment._id,
      subscriptionId: subscription._id,
      kind,
      issuedAt,
      currency: payment.currency,
      issuer: { name: env.INVOICE_ISSUER_NAME, address: env.INVOICE_ISSUER_ADDRESS, email: settings.supportEmail ?? '', phone: settings.supportPhone ?? '' },
      billedTo: {
        accountName: account?.name || owner?.name || workspace?.name || '',
        workspaceName: workspace?.name ?? '',
        email: account?.contactEmail || workspace?.contactEmail || owner?.email || '',
        phone: account?.contactPhone || workspace?.contactPhone || '',
        country: account?.country || workspace?.country || '',
      },
      lines: [
        {
          description: `${snapshot?.name ?? 'Subscription'} - ${billingCycle === 'annual' ? 'annual' : 'monthly'} subscription (${POS_LABEL[posType] ?? posType} POS)`,
          planCode: snapshot?.code ?? 'unknown',
          planName: snapshot?.name ?? 'Subscription',
          billingCycle,
          posType,
          periodStart: subscription.currentPeriodStart ?? null,
          periodEnd: subscription.currentPeriodEnd ?? null,
          quantity: 1,
          unitAmountMinor,
          amountMinor: unitAmountMinor,
        },
      ],
      subtotalMinor: unitAmountMinor,
      discountMinor,
      couponCode: request?.couponCodeSnapshot ?? null,
      creditMinor,
      adjustmentMinor,
      totalMinor,
      payment: { method: payment.provider, reference: payment.providerReference ?? payment.providerTransactionId ?? null, paidAt: payment.paidAt ?? null },
    });
    await linkPayment(payment._id, invoice._id);
    return invoice.toObject() as InvoiceRecord;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await InvoiceModel.findOne({ paymentId }).lean<InvoiceRecord>();
    if (!winner) throw error;
    logger.warn('Two processes issued an invoice for the same payment; an invoice number was skipped', { paymentId: String(paymentId), skipped: formatInvoiceNumber(year, sequence) });
    await linkPayment(paymentId, winner._id);
    return winner;
  }
}

/** For call sites where a payment has just been completed: an invoice problem must never undo the payment. */
export async function issueInvoiceSafely(paymentId: Types.ObjectId | null | undefined) {
  if (!paymentId) return null;
  try {
    return await issueInvoiceForPayment(paymentId);
  } catch (error) {
    logger.error('Issuing an invoice failed; the invoice sweep will retry', { paymentId: String(paymentId), error: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}

/** Issues invoices for paid subscription payments that do not have one yet (any path that missed it, or older payments). */
export async function issueMissingInvoices(limit = 200) {
  const payments = await PaymentModel.find({ status: { $in: INVOICEABLE }, subscriptionId: { $ne: null }, planId: { $ne: null }, invoiceId: null })
    .sort({ _id: 1 })
    .limit(limit)
    .select('_id')
    .lean();
  let issued = 0;
  for (const payment of payments) {
    if (await issueInvoiceSafely(payment._id)) issued += 1;
  }
  if (issued > 0) logger.info('Issued missing invoices', { issued });
  return { checked: payments.length, issued };
}

// ------------------------------------------------------------------ reading

export type InvoiceStatus = 'paid' | 'partially_refunded' | 'refunded';

type RefundState = Pick<PaymentRecord, 'status' | 'refundedMinor' | 'refunds'> | null | undefined;

function refundStateOf(invoice: InvoiceRecord, payment: RefundState) {
  const refundedMinor = Math.max(0, payment?.refundedMinor ?? 0);
  const status: InvoiceStatus =
    refundedMinor <= 0 ? 'paid' : payment?.status === PAYMENT_STATUS.REFUNDED || refundedMinor >= invoice.totalMinor ? 'refunded' : 'partially_refunded';
  return { refundedMinor, status };
}

export function presentInvoiceSummary(invoice: InvoiceRecord, payment: RefundState) {
  const { refundedMinor, status } = refundStateOf(invoice, payment);
  const line = invoice.lines[0];
  return {
    id: invoice._id,
    number: invoice.number,
    issuedAt: invoice.issuedAt,
    status,
    kind: invoice.kind,
    workspace: { id: invoice.tenantId, name: invoice.billedTo.workspaceName },
    planName: line?.planName ?? null,
    billingCycle: line?.billingCycle ?? null,
    posType: line?.posType ?? null,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor,
    refundedMinor,
  };
}

export function presentInvoice(invoice: InvoiceRecord, payment: RefundState) {
  const { refundedMinor, status } = refundStateOf(invoice, payment);
  return {
    ...presentInvoiceSummary(invoice, payment),
    status,
    issuer: invoice.issuer,
    billedTo: invoice.billedTo,
    lines: invoice.lines,
    subtotalMinor: invoice.subtotalMinor,
    discountMinor: invoice.discountMinor,
    couponCode: invoice.couponCode,
    creditMinor: invoice.creditMinor,
    adjustmentMinor: invoice.adjustmentMinor,
    totalMinor: invoice.totalMinor,
    refundedMinor,
    netMinor: invoice.totalMinor - Math.min(refundedMinor, invoice.totalMinor),
    // When and how money went back; internal reasons and admin names stay internal.
    refunds: (payment?.refunds ?? []).map((refund) => ({ amountMinor: refund.amountMinor, method: refund.method, at: refund.at })),
    payment: invoice.payment,
  };
}

export interface InvoiceListInput {
  status?: InvoiceStatus;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

/** Invoices of the given workspaces - the caller has already decided which ones this user may see. */
export async function listInvoices(tenantIds: Types.ObjectId[], input: InvoiceListInput) {
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = { tenantId: { $in: tenantIds } };
  if (input.from || input.to) {
    filter.issuedAt = {
      ...(input.from ? { $gte: input.from } : {}),
      // `to` is a calendar day: the whole day is included.
      ...(input.to ? { $lt: new Date(input.to.getTime() + 86_400_000) } : {}),
    };
  }
  if (input.status) {
    const refund =
      input.status === 'paid'
        ? { $or: [{ refundedMinor: 0 }, { refundedMinor: { $exists: false } }] }
        : input.status === 'refunded'
          ? { status: PAYMENT_STATUS.REFUNDED }
          : { status: PAYMENT_STATUS.PAID, refundedMinor: { $gt: 0 } };
    filter.paymentId = { $in: await PaymentModel.find({ tenantId: { $in: tenantIds }, invoiceId: { $ne: null }, ...refund }).distinct('_id') };
  }

  const [invoices, total] = await Promise.all([
    InvoiceModel.find(filter).sort({ issuedAt: -1, _id: -1 }).skip(skip).limit(limit).lean<InvoiceRecord[]>(),
    InvoiceModel.countDocuments(filter),
  ]);
  const payments = await PaymentModel.find({ _id: { $in: invoices.map((invoice) => invoice.paymentId) } }).select('status refundedMinor refunds').lean<PaymentRecord[]>();
  const byId = new Map(payments.map((payment) => [String(payment._id), payment]));
  return { items: invoices.map((invoice) => presentInvoiceSummary(invoice, byId.get(String(invoice.paymentId)))), page, limit, total };
}

/** One invoice, only if it belongs to one of the given workspaces. Anything else is indistinguishable from missing. */
export async function getInvoice(invoiceId: Types.ObjectId, tenantIds: Types.ObjectId[]) {
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, tenantId: { $in: tenantIds } }).lean<InvoiceRecord>();
  if (!invoice) throw ApiError.notFound('Invoice not found');
  const payment = await PaymentModel.findById(invoice.paymentId).select('status refundedMinor refunds').lean<PaymentRecord>();
  return presentInvoice(invoice, payment);
}

// ------------------------------------------------------------------ payments

const truncate = (value: string | null | undefined, max = 200) => (value ? value.slice(0, max) : null);

/**
 * A payment as its customer may see it. Internal fields - review flags and
 * notes, who approved it, idempotency keys, provider metadata, alert markers -
 * are left out. Legacy field names (`_id`, `provider`, `providerReference`) are
 * kept for existing screens.
 */
export function presentPayment(payment: PaymentRecord, extras: { workspaceName?: string | null; invoiceNumber?: string | null } = {}) {
  const failed = payment.status === PAYMENT_STATUS.FAILED || payment.status === PAYMENT_STATUS.CANCELLED;
  return {
    _id: payment._id,
    id: payment._id,
    workspaceId: payment.tenantId,
    workspaceName: extras.workspaceName ?? null,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    provider: payment.provider,
    method: payment.provider,
    providerReference: payment.providerReference ?? null,
    providerTransactionId: payment.providerTransactionId ?? null,
    reference: payment.providerReference ?? payment.providerTransactionId ?? null,
    status: payment.status,
    paidAt: payment.paidAt ?? null,
    createdAt: payment.createdAt,
    planId: payment.planId ?? null,
    subscriptionId: payment.subscriptionId ?? null,
    refundedMinor: payment.refundedMinor ?? 0,
    refunds: (payment.refunds ?? []).map((refund) => ({ amountMinor: refund.amountMinor, method: refund.method, at: refund.at })),
    failureReason: failed ? truncate(payment.failureReason) : null,
    underReview: Boolean(payment.review?.required && !payment.review?.resolvedAt),
    invoice: payment.invoiceId ? { id: payment.invoiceId, number: extras.invoiceNumber ?? null } : null,
  };
}

/** Presents a batch of payments with their invoice numbers and workspace names. */
export async function presentPayments(payments: PaymentRecord[]) {
  const invoiceIds = payments.map((payment) => payment.invoiceId).filter((id): id is Types.ObjectId => Boolean(id));
  const tenantIds = [...new Set(payments.map((payment) => String(payment.tenantId)))].map((id) => new Types.ObjectId(id));
  const [invoices, workspaces] = await Promise.all([
    invoiceIds.length ? InvoiceModel.find({ _id: { $in: invoiceIds } }).select('number').lean() : [],
    TenantModel.find({ _id: { $in: tenantIds } }).select('name').lean(),
  ]);
  const numbers = new Map(invoices.map((invoice) => [String(invoice._id), invoice.number]));
  const names = new Map(workspaces.map((workspace) => [String(workspace._id), workspace.name]));
  return payments.map((payment) =>
    presentPayment(payment, { workspaceName: names.get(String(payment.tenantId)) ?? null, invoiceNumber: payment.invoiceId ? (numbers.get(String(payment.invoiceId)) ?? null) : null }),
  );
}

export interface PaymentListInput {
  status?: string;
  page?: number;
  limit?: number;
}

export async function listPayments(tenantIds: Types.ObjectId[], input: PaymentListInput) {
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = { tenantId: { $in: tenantIds } };
  if (input.status) filter.status = input.status;
  const [payments, total] = await Promise.all([
    PaymentModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<PaymentRecord[]>(),
    PaymentModel.countDocuments(filter),
  ]);
  return { items: await presentPayments(payments), page, limit, total };
}
