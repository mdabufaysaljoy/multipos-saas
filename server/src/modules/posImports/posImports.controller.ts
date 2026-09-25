import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { getContext } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { ApiError } from '../../utils/ApiError';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from '../productImports/import.limits';
import { posImportService } from '../../services/import/posImport.service';
import type { CommitImportInput } from '../productImports/import.validators';

/**
 * Bulk import for Super Shop, Pharmacy and Restaurant. Mounted by each of those
 * modules at `/imports`, so the vertical gate, the entitlement and the
 * permission are the module's own; the vertical comes from the context, never
 * from the request.
 */

/** What the file must contain, so the page can document it without hard-coding columns. */
export const importColumns = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, {
    ...posImportService.columns(ctx.vertical),
    limits: { maxRows: MAX_IMPORT_ROWS, maxBytes: MAX_IMPORT_BYTES },
    formats: ['xlsx', 'csv'],
  });
});

export const previewImport = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw ApiError.badRequest('Choose an Excel (.xlsx) or CSV (.csv) file to import.');
  const ctx = getContext(req);
  ok(res, await posImportService.preview(ctx, ctx.vertical, req.file));
});

export const commitImport = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const result = await posImportService.commit(ctx, ctx.vertical, id, body<CommitImportInput>(req));
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

export const cancelImport = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const job = await posImportService.cancel(ctx, ctx.vertical, id);
  if (!job) throw ApiError.notFound('That import was not found');
  ok(res, { importId: String(job._id), status: job.status });
});

export const importHistory = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await posImportService.list(ctx, ctx.vertical, query<{ page: number; limit: number }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});
