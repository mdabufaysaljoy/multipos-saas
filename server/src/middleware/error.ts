import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';
import { isProd } from '../config/env';
import { logger } from '../utils/logger';

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} does not exist` },
  });
};

/** Translates any thrown value into the single API error envelope. */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The submitted data is not valid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The submitted data is not valid',
        details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
      },
    });
    return;
  }

  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: `Invalid value for "${err.path}"` },
    });
    return;
  }

  // Duplicate key -> 409 with the offending field, but never the raw index name.
  const mongoErr = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (mongoErr?.code === 11000) {
    const fields = Object.keys(mongoErr.keyPattern ?? {}).filter((f) => f !== 'tenantId' && f !== 'storeId');
    res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: fields.length ? `A record with this ${fields.join(' + ')} already exists` : 'This record already exists',
        details: { fields },
      },
    });
    return;
  }

  logger.error('Unhandled error', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on our side',
      // Stack traces never leak in production.
      ...(isProd ? {} : { details: err instanceof Error ? err.message : String(err) }),
    },
  });
};
