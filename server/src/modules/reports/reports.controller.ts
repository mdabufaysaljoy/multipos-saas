import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { reportService } from './reports.service';
import type { ReportRangeInput } from './reports.validators';

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.dashboard(getContext(req), query<ReportRangeInput>(req)));
});
