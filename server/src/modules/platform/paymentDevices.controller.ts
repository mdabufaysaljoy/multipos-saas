import type { Request, Response } from 'express';
import { PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, created, buildPageMeta, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { applyProviderReport } from '../../services/payment/paymentConfirmation.service';
import { paymentDeviceService } from '../../services/payment/sms/paymentDevice.service';
import { smsVerificationService } from '../../services/payment/sms/smsVerification.service';

const actorOf = (req: Request) => ({ id: req.auth!.id, name: req.auth!.name });

/** Devices allowed to report payment SMS. The secret is shown once, at creation. */
export const listDevices = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await paymentDeviceService.list());
});

export const registerDevice = asyncHandler(async (req: Request, res: Response) => {
  const input = body<{ label: string; allowedProviders: string[]; merchantAccounts: string[] }>(req);
  const result = await paymentDeviceService.register(input, actorOf(req));
  // The credential itself is never audited - only that a device now exists.
  await recordAudit(req, {
    action: 'platform.payment_device_registered',
    targetLabel: result.device.label,
    newValue: { deviceId: result.device.deviceId, allowedProviders: input.allowedProviders, merchantAccounts: input.merchantAccounts.length },
  });
  created(res, result);
});

export const rotateDevice = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  const result = await paymentDeviceService.rotate(id);
  await recordAudit(req, { action: 'platform.payment_device_rotated', targetLabel: result.device.label, newValue: { deviceId: result.device.deviceId } });
  ok(res, result);
});

export const revokeDevice = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  const { reason } = body<{ reason: string }>(req);
  const device = await paymentDeviceService.revoke(id, reason, actorOf(req));
  await recordAudit(req, { action: 'platform.payment_device_revoked', targetLabel: device.label, newValue: { deviceId: device.deviceId, reason } });
  ok(res, device);
});

/**
 * Reported SMS evidence, for reconciliation. `rawMessage` is `select: false`,
 * so this listing carries classifications and amounts - not people's messages.
 */
export const listSmsEvents = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ outcome?: string; page?: number; limit?: number }>(req);
  const result = await smsVerificationService.listEvents(input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

/**
 * Manually verifying a payment that did not match automatically.
 *
 * The original evidence is never edited. The payment is completed through the
 * same confirmation path a gateway uses, so the wallet credit is atomic and
 * happens exactly once however many admins press the button.
 */
export const manuallyVerify = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  const { reason } = body<{ reason: string }>(req);

  const payment = await PaymentModel.findById(id).lean();
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status !== PAYMENT_STATUS.PENDING) {
    throw ApiError.badRequest(`This payment is already ${payment.status}`, { reason: 'NOT_PENDING' });
  }

  await recordAudit(req, {
    action: 'platform.payment_manually_verified',
    targetTenantId: payment.tenantId,
    targetLabel: String(payment._id),
    oldValue: { status: payment.status },
    newValue: { amountMinor: payment.amountMinor, provider: payment.provider, reference: payment.rawReference, reason },
  });

  const outcome = await applyProviderReport(
    payment._id,
    { status: 'paid', amountMinor: payment.amountMinor, currency: payment.currency, paidAt: new Date() },
    'admin',
  );
  await PaymentModel.updateOne({ _id: payment._id }, { $set: { verificationMethod: 'manual_admin', verifiedAt: new Date() } });
  ok(res, { outcome: outcome.outcome, payment: outcome.payment });
});

/** Rejecting a claim that cannot be proven. Credits nothing; the evidence stays. */
export const manuallyReject = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  const { reason } = body<{ reason: string }>(req);

  const payment = await PaymentModel.findOneAndUpdate(
    { _id: id, status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.FAILED, failureReason: reason, 'review.required': false, 'review.resolvedAt': new Date(), 'review.resolvedBy': req.auth!.id, 'review.resolutionNote': reason } },
    { new: true },
  ).lean();
  if (!payment) throw ApiError.badRequest('Only a pending payment can be rejected');

  await recordAudit(req, {
    action: 'platform.payment_manually_rejected',
    targetTenantId: payment.tenantId,
    targetLabel: String(payment._id),
    newValue: { reason },
  });
  ok(res, payment);
});
