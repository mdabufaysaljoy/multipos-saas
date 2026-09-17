import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import {
  posCatalogService,
  type CreatePosProductInput,
  type UpdatePosProductInput,
} from '../../services/posCatalog/posCatalog.service';

// Every route here sits behind `requirePlatformAdmin` (platform.routes) and a
// strict validator, so `code` is already a well-formed catalog code.
const codeOf = (req: Request) => String(req.params.code);

export const list = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await posCatalogService.list());
});

export const detail = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await posCatalogService.detail(codeOf(req)));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const product = await posCatalogService.create(body<CreatePosProductInput>(req));
  await recordAudit(req, { action: 'pos_product.created', targetLabel: product.code, newValue: product });
  created(res, product);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const input = body<UpdatePosProductInput>(req);
  const { before, after } = await posCatalogService.update(codeOf(req), input);
  const statusChanged = before.status !== after.status;
  await recordAudit(req, {
    action: statusChanged ? (after.status === 'active' ? 'pos_product.activated' : 'pos_product.deactivated') : 'pos_product.updated',
    targetLabel: after.code,
    oldValue: { name: before.name, description: before.description, status: before.status, icon: before.icon, configuration: before.configuration },
    newValue: input,
  });
  ok(res, after);
});
