import type { NextFunction, Request, Response } from 'express';
import { verificationService } from '../services/auth/verification.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Buying requires a proven contact.
 *
 * Before money changes hands, the person must have verified either their email
 * address or their phone number - so an invoice, a receipt and a renewal
 * reminder have somewhere real to go, and an account cannot be created and paid
 * for behind an address nobody owns. One of the two is enough; which one is up
 * to the customer.
 *
 * Only USER-INITIATED purchases pass through here. Automatic renewal from the
 * wallet does not: a paying customer must never lose their subscription to a
 * check they cannot answer at 3am.
 */
export const requireVerifiedContact = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const ctx = req.ctx;
  if (!ctx) throw ApiError.unauthorized();
  if (await verificationService.hasVerifiedContact(ctx.userId)) return next();
  throw ApiError.verificationRequired('Verify your email address or phone number before buying a subscription.');
});
