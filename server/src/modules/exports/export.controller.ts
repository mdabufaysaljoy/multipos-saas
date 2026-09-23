import type { Request, Response } from 'express';
import { getContext } from '../../middleware/tenant';
import { body, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { EXPORT_DATASETS } from './export.datasets';
import { PDF_ROW_LIMIT, ROW_LIMIT } from './export.limits';
import { exportService } from './export.service';
import type { CreateExportInput } from './export.validators';

/** What the UI may offer: the registry itself, never a free-text collection. */
export const datasets = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, {
    datasets: EXPORT_DATASETS.map((dataset) => ({ key: dataset.key, label: dataset.label, description: dataset.description, dated: dataset.dated })),
    formats: [
      { key: 'csv', label: 'CSV', description: 'Compatible with Excel and Google Sheets.' },
      { key: 'xlsx', label: 'Excel', description: 'Native .xlsx spreadsheet.' },
      { key: 'json', label: 'JSON', description: 'Structured machine-readable data.' },
      { key: 'pdf', label: 'PDF', description: 'Human-readable report.' },
    ],
    limits: { rows: ROW_LIMIT, pdfRows: PDF_ROW_LIMIT },
  });
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const result = await exportService.list(getContext(req), query<{ page: number; limit: number }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CreateExportInput>(req);
  const result = await exportService.stream(ctx, input, res);
  // Counts only - never the exported data.
  await recordAudit(req, {
    action: 'data.exported',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${input.type}.${input.format}`,
    newValue: { rows: result.rows, bytes: result.bytes, preset: input.preset, branch: input.branch },
  });
});
