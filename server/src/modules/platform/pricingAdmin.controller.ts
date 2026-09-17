import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { pricingService } from '../../services/pricing/pricing.service';
import type { ListPricesQuery, SchedulePriceBody, UpdateCatalogPlanBody } from '../pricing/pricing.validators';

// Every route here sits behind `requirePlatformAdmin` (platform.routes).
const actorOf = (req: Request) => ({ id: req.auth?.id ?? null, name: req.auth?.name ?? 'platform admin' });

export const listPlans = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await pricingService.listPlans());
});

export const updatePlan = asyncHandler(async (req: Request, res: Response) => {
  const { code } = params<{ code: string }>(req);
  const input = body<UpdateCatalogPlanBody>(req);
  const { before, after } = await pricingService.updatePlan(code, input);
  await recordAudit(req, {
    action: 'pricing.plan_updated',
    targetLabel: code,
    oldValue: { displayName: before.displayName, description: before.description, status: before.status, sortOrder: before.sortOrder },
    newValue: input,
  });
  ok(res, after);
});

export const listPrices = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pricingService.listPrices(query<ListPricesQuery>(req)));
});

export const schedulePrice = asyncHandler(async (req: Request, res: Response) => {
  const input = body<SchedulePriceBody>(req);
  const price = await pricingService.schedulePrice(input, actorOf(req));
  await recordAudit(req, {
    action: 'pricing.price_scheduled',
    targetLabel: `${price.posProductCode}/${price.planCode}/${price.billingCycle}`,
    newValue: {
      priceId: String(price._id),
      amountMinor: price.amountMinor,
      currency: price.currency,
      effectiveFrom: price.effectiveFrom,
      note: price.note,
    },
  });
  created(res, price);
});

export const setPriceActive = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { active } = body<{ active: boolean }>(req);
  const { before, after } = await pricingService.setPriceActive(id, active);
  if (before.active !== after.active) {
    await recordAudit(req, {
      action: active ? 'pricing.price_activated' : 'pricing.price_deactivated',
      targetLabel: `${after.posProductCode}/${after.planCode}/${after.billingCycle}`,
      oldValue: { active: before.active },
      newValue: { active: after.active, priceId: String(after._id), amountMinor: after.amountMinor },
    });
  }
  ok(res, after);
});

export const cancelScheduledPrice = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const cancelled = await pricingService.cancelScheduledPrice(id);
  await recordAudit(req, {
    action: 'pricing.price_cancelled',
    targetLabel: `${cancelled.posProductCode}/${cancelled.planCode}/${cancelled.billingCycle}`,
    oldValue: { priceId: String(cancelled._id), amountMinor: cancelled.amountMinor, effectiveFrom: cancelled.effectiveFrom },
  });
  ok(res, { id: cancelled._id });
});
