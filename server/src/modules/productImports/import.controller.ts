import type { Request, Response } from 'express';
import { getContext } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from './import.limits';
import { productImportService } from './import.service';
import { previewImportSchema, type CommitImportInput } from './import.validators';
import type { Types } from 'mongoose';

/** What the file must contain, so the page can document it without hard-coding columns. */
export const columns = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, {
    columns: productImportService.columns(),
    limits: { maxRows: MAX_IMPORT_ROWS, maxBytes: MAX_IMPORT_BYTES },
    formats: ['xlsx', 'csv'],
  });
});

export const preview = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw ApiError.badRequest('Choose an Excel (.xlsx) or CSV (.csv) file to import.');
  // Multipart fields are not validated by the route middleware, so they are
  // parsed here with the same schema.
  const options = previewImportSchema.parse({ createMissingCategories: req.body?.createMissingCategories ?? false });
  const result = await productImportService.preview(getContext(req), req.file, options);
  ok(res, result);
});

export const commit = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<CommitImportInput>(req);
  const result = await productImportService.commit(ctx, id, input);
  await recordAudit(req, {
    action: 'products.imported',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: String(id),
    // Counts only - never the imported rows.
    newValue: result.summary,
  });
  ok(res, result);
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const job = await productImportService.cancel(getContext(req), id);
  if (!job) throw ApiError.notFound('That import was not found');
  ok(res, { importId: String(job._id), status: job.status });
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const result = await productImportService.list(getContext(req), query<{ page: number; limit: number }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});
