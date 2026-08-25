import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import type { Permission } from '../config/permissions';

/**
 * Backend permission gate. The frontend hides what a user cannot do, but this
 * is what actually enforces it - every protected route passes through here.
 */
export const requirePermission =
  (...required: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx;
    if (!ctx) return next(ApiError.unauthorized());
    if (ctx.isAdmin) return next();

    const missing = required.filter((permission) => !ctx.permissions.includes(permission));
    if (missing.length > 0) {
      return next(
        ApiError.forbidden(`You need the "${missing.join('", "')}" permission to do this`),
      );
    }
    next();
  };

/** Passes when the user holds AT LEAST ONE of the listed permissions. */
export const requireAnyPermission =
  (...anyOf: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx;
    if (!ctx) return next(ApiError.unauthorized());
    if (ctx.isAdmin) return next();
    if (anyOf.some((permission) => ctx.permissions.includes(permission))) return next();
    next(ApiError.forbidden(`You need one of: "${anyOf.join('", "')}"`));
  };
