import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { EmailNotificationModel } from '../../models/EmailNotification';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { adminRetryEmail } from '../../services/email/transactionalEmail.service';

/** Billing email delivery, for diagnosing a customer who "never got the invoice". No bodies are stored or shown. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ status?: string; type?: string; tenantId?: Types.ObjectId; invoiceId?: Types.ObjectId; page?: number; limit?: number }>(req);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const page = Math.max(input.page ?? 1, 1);
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.type) filter.type = input.type;
  if (input.tenantId) filter.tenantId = input.tenantId;
  if (input.invoiceId) filter.invoiceId = input.invoiceId;
  const [items, total] = await Promise.all([
    EmailNotificationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-claimedUntil').lean(),
    EmailNotificationModel.countDocuments(filter),
  ]);
  paginated(res, items, buildPageMeta(page, limit, total));
});

export const retry = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const result = await adminRetryEmail(id);
  if (!result) throw ApiError.badRequest('Only a failed or pending email can be retried');
  await recordAudit(req, { action: 'platform.billing_email_retried', newValue: { emailId: String(id), outcome: result.outcome } });
  ok(res, result);
});
