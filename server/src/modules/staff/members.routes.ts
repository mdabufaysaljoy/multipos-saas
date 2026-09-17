import { Router, type Request, type Response } from 'express';
import type { Types } from 'mongoose';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { getContext, resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { body, params, validate } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { memberService } from './members.service';
import { addMemberSchema, memberParams, updateMemberSchema, type AddMemberInput, type UpdateMemberInput } from './members.validators';

/**
 * `/api/staff/members` - people from other workspaces of the same account.
 * Always about the ACTIVE workspace; a member id from any other workspace is 404.
 */
const router = Router();
router.use(authenticate, resolveTenant, requireSubscribedAccess);

type MemberParams = { memberId: Types.ObjectId };

router.get(
  '/',
  requirePermission(PERMISSIONS.STAFF_VIEW),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await memberService.list(getContext(req)));
  }),
);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_CREATE),
  validate({ body: addMemberSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const member = await memberService.add(ctx, body<AddMemberInput>(req));
    await recordAudit(req, {
      action: 'staff.member.added',
      targetTenantId: ctx.tenantId,
      targetUserId: member.userId,
      targetLabel: member.email,
      newValue: { roleId: member.roleId, extraPermissions: member.extraPermissions, homeWorkspace: member.homeWorkspace?.id ?? null },
    });
    created(res, member);
  }),
);

router.patch(
  '/:memberId',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_EDIT),
  validate({ params: memberParams, body: updateMemberSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const input = body<UpdateMemberInput>(req);
    const member = await memberService.update(ctx, params<MemberParams>(req).memberId, input);
    await recordAudit(req, {
      action: 'staff.member.updated',
      targetTenantId: ctx.tenantId,
      targetUserId: member.userId,
      targetLabel: member.email,
      newValue: input,
    });
    ok(res, member);
  }),
);

router.delete(
  '/:memberId',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_DELETE),
  validate({ params: memberParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = getContext(req);
    const { memberId } = params<MemberParams>(req);
    const result = await memberService.remove(ctx, memberId);
    await recordAudit(req, { action: 'staff.member.removed', targetTenantId: ctx.tenantId, targetLabel: String(memberId) });
    ok(res, result);
  }),
);

export default router;
