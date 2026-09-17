import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { RefundMethod, SubscriptionAdjustmentAction } from '../../models/Payment';
import { sendPaymentAlertDigest } from '../../services/payment/paymentAlerts.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { paymentOperationsService, type PaymentQueue } from '../../services/payment/paymentOperations.service';

const actorFrom = (req: Request) => ({ id: req.auth?.id ?? null, name: req.auth?.name ?? 'platform admin' });
type IdParams = { id: Types.ObjectId };

export const list = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ queue: PaymentQueue; provider?: string; tenantId?: Types.ObjectId; page?: number; limit?: number }>(req);
  const result = await paymentOperationsService.list(input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const summary = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await paymentOperationsService.summary());
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await paymentOperationsService.detail(params<IdParams>(req).id));
});

export const recheck = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  const result = await paymentOperationsService.recheck(id);
  await recordAudit(req, {
    action: 'payment.rechecked',
    targetTenantId: result.tenantId,
    targetLabel: String(id),
    newValue: { paymentId: String(id), outcome: result.outcome, status: (result.payment as { status?: string } | null)?.status ?? null },
  });
  ok(res, { outcome: result.outcome, reason: 'reason' in result ? result.reason : undefined, payment: result.payment });
});

export const markReceived = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  const input = body<{ amountReceivedMinor: number; reference: string; note: string }>(req);
  const result = await paymentOperationsService.markReceived(id, input, actorFrom(req));
  await recordAudit(req, {
    action: 'payment.marked_received',
    targetTenantId: result.tenantId,
    targetLabel: String(id),
    newValue: { paymentId: String(id), outcome: result.outcome, amountReceivedMinor: input.amountReceivedMinor, reference: input.reference, note: input.note },
  });
  ok(res, { outcome: result.outcome, payment: result.payment });
});

export const recordRefund = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  const input = body<{ amountMinor: number; method: RefundMethod; reference: string; reason: string }>(req);
  const result = await paymentOperationsService.recordRefund(id, input, actorFrom(req));
  await recordAudit(req, {
    action: 'payment.refund_recorded',
    targetTenantId: result.tenantId,
    targetLabel: String(id),
    newValue: { paymentId: String(id), ...input, refundedMinor: result.payment.refundedMinor, status: result.payment.status },
  });
  created(res, result.payment);
});

export const adjustSubscription = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  const input = body<{ action: SubscriptionAdjustmentAction; until?: Date; reason: string }>(req);
  const result = await paymentOperationsService.adjustSubscriptionAfterRefund(id, input, actorFrom(req));
  await recordAudit(req, {
    action: 'payment.subscription_adjusted',
    targetTenantId: result.tenantId,
    targetLabel: String(id),
    oldValue: { currentPeriodEnd: result.payment.subscriptionAdjustment?.previousEnd },
    newValue: {
      paymentId: String(id),
      subscriptionId: String(result.subscription._id),
      action: input.action,
      until: result.subscription.currentPeriodEnd,
      status: result.subscription.status,
      reason: input.reason,
    },
  });
  ok(res, { payment: result.payment, subscription: result.subscription });
});

export const sendAlerts = asyncHandler(async (req: Request, res: Response) => {
  const result = await sendPaymentAlertDigest();
  await recordAudit(req, { action: 'payment.alerts_sent', newValue: { ...result } });
  ok(res, result);
});

export const resolveReview = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<IdParams>(req);
  const { note } = body<{ note: string }>(req);
  const payment = await paymentOperationsService.resolveReview(id, note, actorFrom(req));
  await recordAudit(req, {
    action: 'payment.review_resolved',
    targetTenantId: payment.tenantId,
    targetLabel: String(id),
    oldValue: { reason: payment.review?.reason },
    newValue: { paymentId: String(id), note },
  });
  ok(res, payment);
});
