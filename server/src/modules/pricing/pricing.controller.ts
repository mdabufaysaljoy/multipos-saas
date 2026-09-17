import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { pricingService } from '../../services/pricing/pricing.service';
import type { CatalogQuery, QuoteBody, WorkspaceQuoteBody } from './pricing.validators';

/** Public: the plans and prices for one POS type. */
export const catalog = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pricingService.catalog(query<CatalogQuery>(req).posType));
});

/** Public: the server's price for a POS type, plan and cycle. */
export const quote = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pricingService.quote(body<QuoteBody>(req)));
});

/** Signed in: the price for THIS workspace's POS type, which is never taken from the request. */
export const workspaceQuote = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  // An existing workspace keeps its prices even if its POS type stops taking new workspaces.
  ok(res, await pricingService.quote({ ...body<WorkspaceQuoteBody>(req), posType: ctx.vertical }, new Date(), { allowInactivePosProduct: true }));
});
