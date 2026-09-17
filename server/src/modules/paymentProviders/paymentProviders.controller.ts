import type { NextFunction, Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { PaymentDeviceDoc } from '../../models/PaymentDevice';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { body } from '../../middleware/validate';
import { logger } from '../../utils/logger';
import { paymentDeviceService } from '../../services/payment/sms/paymentDevice.service';
import { smsVerificationService } from '../../services/payment/sms/smsVerification.service';
import type { SmsEventBody } from './paymentProviders.validators';

type ReportingDevice = PaymentDeviceDoc & { _id: Types.ObjectId };

declare module 'express-serve-static-core' {
  interface Request {
    reportingDevice?: ReportingDevice;
  }
}

const headerValue = (req: Request, name: string): string => {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
};

/**
 * Authenticates a reporting device by its own credential - never a user login,
 * never an account. Every failure answers the same way, so a prober cannot
 * learn whether a device id exists.
 */
export const authenticateDevice = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const device = await paymentDeviceService.authenticate(headerValue(req, 'x-device-id'), headerValue(req, 'x-device-secret'));
  if (!device) {
    logger.warn('Rejected an unauthenticated payment device request', { ip: req.ip });
    throw ApiError.unauthorized('Device authentication failed');
  }
  req.reportingDevice = device;
  next();
});

/**
 * Receives one payment SMS from a registered device.
 *
 * The answer is deliberately flat - it says the event was received and how it
 * was classified, never whose payment it touched or what a wallet holds. A
 * device learns nothing it could use to probe for valid transactions.
 */
export const receiveSmsEvent = asyncHandler(async (req: Request, res: Response) => {
  const device = req.reportingDevice!;
  const input = body<SmsEventBody>(req);

  const result = await smsVerificationService.ingest(device, input);
  await paymentDeviceService.recordOutcome(device._id, result.outcome === 'matched');

  res.status(202).json({ success: true, data: { received: true, outcome: result.outcome } });
});
