import type { NextFunction, Request, Response } from 'express';
import { VERTICAL_LABELS, type PosVertical } from '../config/verticals';
import { ApiError } from '../utils/ApiError';

/**
 * Restricts a module to workspaces of the given POS vertical(s).
 *
 * The vertical is read from `req.ctx`, which `resolveTenant` loads from the
 * workspace record - never from the request - so a Restaurant workspace cannot
 * reach Clothing inventory, and a Clothing workspace cannot open restaurant
 * orders, however the request is written. Must run after `resolveTenant`.
 */
export const requireVertical =
  (...verticals: PosVertical[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.ctx;
    if (!ctx) return next(ApiError.unauthorized());
    if (verticals.includes(ctx.vertical)) return next();
    next(
      new ApiError(
        'VERTICAL_NOT_SUPPORTED',
        `This part of the POS is not available in a ${VERTICAL_LABELS[ctx.vertical]} workspace.`,
        { vertical: ctx.vertical, supportedVerticals: verticals },
      ),
    );
  };
