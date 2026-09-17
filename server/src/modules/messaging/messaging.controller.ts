import type { Request, Response } from 'express';
import { CustomerModel } from '../../models/Customer';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { smsService } from '../../services/sms/sms.service';
import { emailService } from '../../services/email';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type { CampaignInput, EmailCampaignInput, EstimateInput, HistoryInput, SendOneInput } from './messaging.validators';

/** Provider availability and pricing, so the UI can explain what is possible. */
export const status = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const [sms, usage] = await Promise.all([
    Promise.resolve(smsService.status()),
    smsService.usage(ctx.tenantId),
  ]);
  const pricing = await smsService.estimate('x', 1);

  // Two independent reasons a channel may be unusable, and the UI must tell
  // them apart: the PLAN does not include it (upgrade), or the PROVIDER is not
  // configured (nothing the customer can do). Collapsing them into one
  // "available" flag is what made the email editor look permanently broken.
  const entitlement = await entitlementService.forTenant(ctx.tenantId);
  const emailStatus = await emailService.statusAsync();

  ok(res, {
    sms: {
      ...sms,
      perSegmentCostMinor: pricing.perSmsCostMinor,
      includedInPlan: entitlement.features.smsMarketing,
      providerConfigured: sms.available,
      available: entitlement.features.smsMarketing && sms.available,
    },
    email: {
      ...emailStatus,
      perEmailCostMinor: await emailService.costPerEmailMinor(),
      includedInPlan: entitlement.features.emailMarketing,
      providerConfigured: emailStatus.available,
      available: entitlement.features.emailMarketing && emailStatus.available,
    },
    planName: entitlement.planName,
    usage,
  });
});

export const estimate = asyncHandler(async (req: Request, res: Response) => {
  const input = query<EstimateInput>(req);
  ok(res, await smsService.estimate(input.message, input.recipients));
});

export const sendOne = asyncHandler(async (req: Request, res: Response) => {
  created(res, await smsService.sendOne(getContext(req), body<SendOneInput>(req)));
});

export const sendCampaign = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CampaignInput>(req);

  // Resolve the audience to concrete numbers before anything is charged.
  let recipients: { phone: string; customerId?: import('mongoose').Types.ObjectId | null }[] = [];

  if (input.audience === 'all-customers') {
    const customers = await CustomerModel.find({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
      isActive: true,
    })
      .select('_id phone')
      .lean();
    recipients = customers.map((c) => ({ phone: c.phone, customerId: c._id }));
  } else {
    if (input.customerIds?.length) {
      const customers = await CustomerModel.find({
        _id: { $in: input.customerIds },
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
        .select('_id phone')
        .lean();
      recipients = customers.map((c) => ({ phone: c.phone, customerId: c._id }));
    }
  }

  // Every recipient came from a tenant-scoped customer query above, so a
  // campaign can only ever reach this workspace's own customers.

  if (recipients.length === 0) throw ApiError.badRequest('No recipients matched this campaign');

  created(res, await smsService.sendCampaign(ctx, { name: input.name, message: input.message, recipients }));
});

/** Email campaign. Only customers WITH an email address are targeted. */
export const sendEmailCampaign = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<EmailCampaignInput>(req);

  const filter: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    deletedAt: null,
    isActive: true,
    // Skipping blank addresses here means the tenant is never charged for one.
    email: { $nin: ['', null] },
  };
  if (input.audience === 'selected' && input.customerIds?.length) {
    filter._id = { $in: input.customerIds };
  }

  const customers = await CustomerModel.find(filter).select('_id email').lean();
  if (customers.length === 0) {
    throw ApiError.badRequest('None of the selected customers have an email address on file');
  }

  created(
    res,
    await smsService.sendEmailCampaign(ctx, {
      name: input.name,
      subject: input.subject,
      body: input.body,
      recipients: customers.map((c) => ({ email: c.email, customerId: c._id })),
    }),
  );
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const result = await smsService.history(getContext(req).tenantId, query<HistoryInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const campaigns = asyncHandler(async (req: Request, res: Response) => {
  const result = await smsService.campaigns(getContext(req).tenantId, query<HistoryInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});
