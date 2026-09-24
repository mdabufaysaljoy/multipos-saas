import type { Request, Response } from 'express';
import { env, isProd } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { ttlToMs } from '../../utils/tokens';
import { body } from '../../middleware/validate';
import { authService, type SessionMeta } from './auth.service';
import type { ChangePasswordInput, LoginInput, RegisterInput, SelectLoginInput, SwitchWorkspaceInput } from './auth.validators';
import { recordAudit } from '../../services/audit/audit.service';
import { UserModel } from '../../models/User';
import { verificationService } from '../../services/auth/verification.service';
import type { ConfirmCodeInput, SendCodeInput } from './verification.validators';

const REFRESH_COOKIE = 'refreshToken';

const metaFrom = (req: Request): SessionMeta => ({
  userAgent: req.header('user-agent') ?? '',
  ip: req.ip ?? '',
});

/** httpOnly cookie so the refresh token is never reachable from JavaScript. */
const setRefreshCookie = (res: Response, token: string) => {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: ttlToMs(env.REFRESH_TOKEN_TTL),
    path: '/api/auth',
  });
};

const clearRefreshCookie = (res: Response) =>
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(body<RegisterInput>(req), metaFrom(req));
  setRefreshCookie(res, result.tokens.refreshToken);
  created(res, result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(body<LoginInput>(req), metaFrom(req));
  // A sign-in awaiting a choice of identity has no session yet.
  if ('tokens' in result) setRefreshCookie(res, result.tokens.refreshToken);
  ok(res, result);
});

export const selectLogin = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.selectLogin(body<SelectLoginInput>(req), metaFrom(req));
  setRefreshCookie(res, result.tokens.refreshToken);
  ok(res, result);
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const cookies = req.cookies as Record<string, string> | undefined;
  const token = cookies?.[REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken;
  if (!token) throw ApiError.unauthorized('No refresh token supplied');

  const tokens = await authService.refresh(token, metaFrom(req));
  setRefreshCookie(res, tokens.refreshToken);
  ok(res, tokens);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const cookies = req.cookies as Record<string, string> | undefined;
  await authService.logout(cookies?.[REFRESH_COOKIE], req.auth?.id);
  clearRefreshCookie(res);
  ok(res, { message: 'Signed out' });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  // `req.auth.tenantId` was authorised by `authenticate` for this request.
  ok(res, await authService.buildSession(req.auth.id, req.auth.tenantId));
});

export const workspaces = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  ok(res, await authService.workspaces(req.auth.id, req.auth.tenantId));
});

export const switchWorkspace = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  const input = body<SwitchWorkspaceInput>(req);
  const cookies = req.cookies as Record<string, string> | undefined;
  const previousTenantId = req.auth.tenantId;

  const result = await authService.switchWorkspace(
    req.auth.id,
    input.workspaceId,
    cookies?.[REFRESH_COOKIE] ?? input.refreshToken,
    metaFrom(req),
  );
  setRefreshCookie(res, result.tokens.refreshToken);

  await recordAudit(req, {
    action: 'auth.workspace_switched',
    targetTenantId: input.workspaceId,
    targetUserId: req.auth.id,
    targetLabel: result.tenant?.name ?? '',
    oldValue: { tenantId: previousTenantId },
    newValue: { tenantId: input.workspaceId },
  });

  ok(res, result);
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  await authService.changePassword(req.auth.id, body<ChangePasswordInput>(req));
  clearRefreshCookie(res);
  ok(res, { message: 'Password updated. Please sign in again.' });
});

/** Verification status for the signed-in user: what is proven, what is not. */
export const verificationStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = await UserModel.findById(req.auth!.id).select('email phone emailVerifiedAt phoneVerifiedAt').lean();
  if (!user) throw ApiError.unauthorized();
  ok(res, verificationService.status(user));
});

export const sendVerificationCode = asyncHandler(async (req: Request, res: Response) => {
  const { channel } = body<SendCodeInput>(req);
  ok(res, await verificationService.send(req.auth!.id, channel));
});

export const confirmVerificationCode = asyncHandler(async (req: Request, res: Response) => {
  const { channel, code } = body<ConfirmCodeInput>(req);
  ok(res, await verificationService.confirm(req.auth!.id, channel, code));
});
