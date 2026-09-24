import type { Response } from 'express';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { ExportJobModel } from '../../models/ExportJob';
import { StoreModel } from '../../models/Store';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';
import { resolveRange } from '../reports/reports.service';
import type { ReportRangeInput } from '../reports/reports.validators';
import { hasEntitlement } from '../../services/entitlements/entitlementEngine';
import { EXPORT_DATASETS, findDataset, type DatasetScope, type ExportDataset, type ExportSection } from './export.datasets';
import {
  EXPORT_FORMATS,
  ExportTooLargeError,
  formatDay,
  writeCsv,
  writeJson,
  writePdf,
  writeXlsx,
  type ExportFormat,
  type ExportMeta,
} from './export.formats';
import type { CreateExportInput } from './export.validators';

/**
 * Data export (Clothing POS).
 *
 * The request names a dataset from the registry and a format; everything else -
 * workspace, branch, query, columns - comes from the authenticated session and
 * the server-side registry. The file is streamed to the browser and never
 * stored, so there is no file at rest to protect or expire.
 */
class ExportService {
  /** Clothing only: the registry is built from Clothing collections. */
  private async assertClothing(ctx: TenantContext) {
    const tenant = await TenantModel.findById(ctx.tenantId).select('vertical name').lean();
    const vertical = tenant?.vertical ?? DEFAULT_POS_VERTICAL;
    if (vertical !== 'clothing') {
      throw ApiError.forbidden('Data export is available for the Clothing POS.');
    }
    return tenant;
  }

  /**
   * Branch scope, mirroring the reports rule: "all" is honoured for tenant
   * admins only; everyone else always gets their own branch, whatever the
   * request asks for.
   */
  private storeFilter(ctx: TenantContext, branch: CreateExportInput['branch']) {
    if (branch === 'all' && ctx.isAdmin) return { filter: {}, allBranches: true };
    if (branch !== 'current' && branch !== 'all' && ctx.isAdmin) return { filter: { storeId: branch }, allBranches: false };
    return { filter: { storeId: ctx.storeId }, allBranches: false };
  }

  /**
   * Whether this session may export a dataset that carries its own feature and
   * permission. `reports.export` opens the export screen; it does not open a
   * dataset the user could not read anywhere else in the app.
   */
  private async allows(ctx: TenantContext, dataset: ExportDataset): Promise<boolean> {
    const required = dataset.requires;
    if (!required) return true;
    if (required.permission && !ctx.isAdmin && !ctx.permissions.includes(required.permission)) return false;
    if (required.entitlement && !(await hasEntitlement(ctx.tenantId, required.entitlement))) return false;
    return true;
  }

  /** The datasets THIS session may actually download. */
  async catalogue(ctx: TenantContext) {
    const allowed = await Promise.all(EXPORT_DATASETS.map((dataset) => this.allows(ctx, dataset)));
    return EXPORT_DATASETS.filter((_, index) => allowed[index]).map((dataset) => ({
      key: dataset.key,
      label: dataset.label,
      description: dataset.description,
      dated: dataset.dated,
    }));
  }

  async list(ctx: TenantContext, input: { page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const filter = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    const [items, total] = await Promise.all([
      ExportJobModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ExportJobModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  /**
   * Streams one export into the response. Returns what was written so the
   * caller can log it; the history row is written here either way.
   */
  async stream(ctx: TenantContext, input: CreateExportInput, res: Response) {
    const tenant = await this.assertClothing(ctx);
    const dataset = findDataset(input.type);
    if (!dataset) throw ApiError.validation('Unknown export type');
    if (!(await this.allows(ctx, dataset))) {
      throw ApiError.forbidden(`You do not have access to the ${dataset.label.toLowerCase()} data.`);
    }

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('name currency').lean();
    if (!store) throw ApiError.notFound('Store not found');

    const { filter: storeFilter, allBranches } = this.storeFilter(ctx, input.branch);
    const report = { preset: input.preset, from: input.from, to: input.to, granularity: 'day', branch: allBranches ? 'all' : 'current', limit: 10 } as unknown as ReportRangeInput;
    const range = dataset.dated ? resolveRange(report) : null;

    const scope: DatasetScope = { ctx, storeFilter, range, report };
    const filterSummary = [
      range ? `Range: ${formatDay(range.from)} - ${formatDay(range.to)}` : 'All records',
      allBranches ? 'All branches' : `Branch: ${store.name}`,
    ].join(' · ');

    const meta: ExportMeta = {
      datasetKey: dataset.key,
      datasetLabel: dataset.label,
      storeName: allBranches ? 'All branches' : store.name,
      workspaceName: tenant?.name ?? '',
      rangeLabel: range?.label ?? null,
      filterSummary,
      generatedAt: new Date(),
      generatedBy: ctx.userName,
      currency: store.currency,
    };

    const format = input.format as ExportFormat;
    const { extension, contentType } = EXPORT_FORMATS[format];
    const stamp = meta.generatedAt.toISOString().slice(0, 10);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${dataset.key}-${stamp}.${extension}"`);
    res.setHeader('Cache-Control', 'no-store');

    let sections: ExportSection[];
    try {
      sections = await dataset.sections(scope);
    } catch (error) {
      await this.record(ctx, input, meta, allBranches, range, { rows: 0, bytes: 0 }, error);
      throw error;
    }

    try {
      const writer = { csv: writeCsv, xlsx: writeXlsx, json: writeJson, pdf: writePdf }[format];
      const result = await writer(res, sections, meta);
      await this.record(ctx, input, meta, allBranches, range, result, null);
      if (!res.writableEnded) res.end();
      return result;
    } catch (error) {
      await this.record(ctx, input, meta, allBranches, range, { rows: 0, bytes: 0 }, error);
      // Nothing sensitive in the log: dataset, format and the reason only.
      logger.error('Data export failed', { type: input.type, format: input.format, error: String(error) });
      if (res.headersSent) {
        // The download already started; end it so the browser shows a broken file rather than hanging.
        res.end();
        return { rows: 0, bytes: 0 };
      }
      if (error instanceof ExportTooLargeError) throw ApiError.badRequest(error.message, { reason: 'EXPORT_TOO_LARGE' });
      throw ApiError.internal('The export could not be generated. Please try again.');
    }
  }

  private async record(
    ctx: TenantContext,
    input: CreateExportInput,
    meta: ExportMeta,
    allBranches: boolean,
    range: { from: Date; to: Date } | null,
    result: { rows: number; bytes: number },
    error: unknown,
  ) {
    try {
      await ExportJobModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        type: input.type,
        format: input.format,
        filterSummary: meta.filterSummary,
        rangeFrom: range?.from ?? null,
        rangeTo: range?.to ?? null,
        allBranches,
        status: error ? 'failed' : 'completed',
        rowCount: result.rows,
        byteSize: result.bytes,
        error: error ? String((error as Error).message ?? error).slice(0, 300) : '',
        requestedBy: ctx.userId,
        requestedByNameSnapshot: ctx.userName,
        completedAt: new Date(),
      });
    } catch (recordError) {
      logger.error('Could not record the export history entry', { error: String(recordError) });
    }
  }
}

export const exportService = new ExportService();
