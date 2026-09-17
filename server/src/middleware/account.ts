import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { accountForUser } from '../services/account/account.service';
import { canAccessWorkspace } from '../services/account/workspaceAccess.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Attaches the account the signed-in user OWNS as `req.account`.
 *
 * Derived from `req.auth.id` only. A body, query or header naming an account is
 * never read. Staff and platform administrators own no account and get a 403.
 * Must run after `authenticate`.
 */
export const resolveAccount = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) throw ApiError.unauthorized();
  if (req.auth.isPlatformAdmin) throw ApiError.forbidden('Platform administrators do not own a customer account');
  const { account } = await accountForUser(req.auth.id, 'Only the account owner can manage the account and its workspaces');
  req.account = { id: account._id, status: account.status };
  next();
});

/**
 * Requires that the authenticated account owns the workspace named by the
 * validated route parameter, and attaches it as `req.workspace`.
 *
 * Must run after `resolveAccount` and after `validate({ params })` has turned
 * the parameter into an ObjectId (so a malformed id is a 422, not a lookup).
 *
 *   - no such workspace, or another account's  -> 404 (indistinguishable)
 *   - own workspace, account suspended          -> 403
 */
export const requireWorkspaceAccess = (param = 'workspaceId') =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) throw ApiError.unauthorized();
    const workspaceId = (req.validated?.params as Record<string, unknown> | undefined)?.[param];
    if (!(workspaceId instanceof Types.ObjectId)) throw ApiError.validation('A valid workspace id is required');

    const access = await canAccessWorkspace(req.account.id, workspaceId);
    if (access.allowed) {
      req.workspace = access.workspace;
      return next();
    }
    if (access.reason === 'account_suspended') {
      throw ApiError.forbidden('This account is suspended. Please contact support.');
    }
    throw ApiError.notFound('Workspace not found');
  });
