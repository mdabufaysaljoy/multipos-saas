import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, paginated } from '../../utils/apiResponse';
import { query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { readPosLedger, type PosLedgerQuery } from '../../services/inventory/posLedger';

/**
 * The stock ledger of the current branch, in the one shape every vertical
 * reports. Mounted by each POS module at `/stock-ledger`, so a single client
 * screen can show the history of a shirt, a strip of Napa or a bag of rice.
 */
export const stockLedger = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await readPosLedger(ctx, ctx.vertical, query<PosLedgerQuery>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});
