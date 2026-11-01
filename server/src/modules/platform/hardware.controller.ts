import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import {
  hardwareService,
  type HardwareItemInput,
  type HardwareItemUpdate,
  type HardwarePackageInput,
  type HardwarePackageUpdate,
} from '../../services/hardware/hardware.service';

/**
 * The hardware catalogue a platform admin manages: the devices sold on their
 * own, and the packages built from them. Every route here sits behind
 * `requirePlatformAdmin` (platform.routes) and a strict validator, so `slug` has
 * already been checked by the time it arrives.
 *
 * Catalogue changes are audited: a price on the public website is a public
 * promise, and "who changed it, from what" must be answerable afterwards.
 */
const slugOf = (req: Request) => String(req.params.slug);

export const catalogue = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await hardwareService.adminCatalogue());
});

export const createItem = asyncHandler(async (req: Request, res: Response) => {
  const item = await hardwareService.createItem(body<HardwareItemInput>(req));
  await recordAudit(req, { action: 'hardware_item.created', targetLabel: item.slug, newValue: item });
  created(res, item);
});

export const updateItem = asyncHandler(async (req: Request, res: Response) => {
  const input = body<HardwareItemUpdate>(req);
  const { before, after } = await hardwareService.updateItem(slugOf(req), input);
  await recordAudit(req, { action: 'hardware_item.updated', targetLabel: after.slug, oldValue: before, newValue: input });
  ok(res, after);
});

export const deleteItem = asyncHandler(async (req: Request, res: Response) => {
  const item = await hardwareService.deleteItem(slugOf(req));
  await recordAudit(req, { action: 'hardware_item.deleted', targetLabel: item.slug, oldValue: item });
  ok(res, item);
});

export const createPackage = asyncHandler(async (req: Request, res: Response) => {
  const pkg = await hardwareService.createPackage(body<HardwarePackageInput>(req));
  await recordAudit(req, { action: 'hardware_package.created', targetLabel: pkg.slug, newValue: pkg });
  created(res, pkg);
});

export const updatePackage = asyncHandler(async (req: Request, res: Response) => {
  const input = body<HardwarePackageUpdate>(req);
  const { before, after } = await hardwareService.updatePackage(slugOf(req), input);
  await recordAudit(req, { action: 'hardware_package.updated', targetLabel: after.slug, oldValue: before, newValue: input });
  ok(res, after);
});

export const deletePackage = asyncHandler(async (req: Request, res: Response) => {
  const pkg = await hardwareService.deletePackage(slugOf(req));
  await recordAudit(req, { action: 'hardware_package.deleted', targetLabel: pkg.slug, oldValue: pkg });
  ok(res, pkg);
});
