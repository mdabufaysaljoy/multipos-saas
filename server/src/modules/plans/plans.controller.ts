import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, params } from '../../middleware/validate';
import type { CreatePlanInput, UpdatePlanInput } from './plans.validators';

/** Public pricing page data - active, public plans only. */
export const listPublic = asyncHandler(async (_req: Request, res: Response) => {
  const plans = await SubscriptionPlanModel.find({ isActive: true, isPublic: true })
    .sort({ interval: 1, sortOrder: 1 })
    .lean();
  ok(res, plans);
});

/** Platform admin view - everything, including hidden and inactive plans. */
export const listAll = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await SubscriptionPlanModel.find().sort({ interval: 1, sortOrder: 1 }).lean());
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const input = body<CreatePlanInput>(req);
  const duplicate = await SubscriptionPlanModel.findOne({ code: input.code }).select('_id').lean();
  if (duplicate) throw ApiError.conflict('A plan with this code already exists');

  const plan = await SubscriptionPlanModel.create(input);
  created(res, plan.toObject());
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<UpdatePlanInput>(req);

  const plan = await SubscriptionPlanModel.findById(id);
  if (!plan) throw ApiError.notFound('Plan not found');

  if (input.code && input.code !== plan.code) {
    const duplicate = await SubscriptionPlanModel.findOne({ code: input.code, _id: { $ne: id } }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A plan with this code already exists');
    plan.code = input.code;
  }

  const scalars = ['name', 'description', 'interval', 'priceMinor', 'currency', 'trialDays', 'isActive', 'isPublic', 'sortOrder'] as const;
  for (const key of scalars) {
    if (input[key] !== undefined) (plan as unknown as Record<string, unknown>)[key] = input[key];
  }

  // Merge nested blocks so a partial edit cannot wipe unrelated flags.
  if (input.features) Object.assign(plan.features, input.features);
  if (input.limits) Object.assign(plan.limits, input.limits);

  await plan.save();

  // NOTE: existing subscriptions keep their planSnapshot, so a price change
  // never rewrites a period a customer has already paid for.
  ok(res, plan.toObject());
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const plan = await SubscriptionPlanModel.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not found');
  ok(res, plan);
});
