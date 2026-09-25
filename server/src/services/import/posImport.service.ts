import { Types } from 'mongoose';
import { ZodError } from 'zod';
import { ProductImportJobModel, type ProductImportJobDoc } from '../../models/ProductImportJob';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';
import type { PosVertical } from '../../config/verticals';
import type { TenantContext } from '../../types/express';
import { posCategoryService } from '../catalogue/posCategories.service';
import { MAX_IMPORT_ROWS, MAX_STORED_ERRORS, PENDING_IMPORT_TTL_MINUTES } from '../../modules/productImports/import.limits';
import { importAdapterFor, type PosImportAdapter, type PreparedImportItem } from './posImport.adapters';
import { formatFromFilename, parseSheet } from './sheet.parse';

/**
 * Bulk import for the POS types whose catalogue is a flat list of items
 * (Super Shop, Pharmacy, Restaurant).
 *
 * The shape is Clothing's, because Clothing's shape is right: two steps, where
 * "validate & preview" writes NOTHING and "confirm" creates each item through
 * the vertical's OWN create service - so the plan's product limit, name and
 * barcode uniqueness, the category list and the opening-stock ledger behave
 * exactly as they do for an item typed in by hand.
 *
 * Nothing about ownership comes from the file: tenant and branch come from the
 * authenticated context, and id columns are ignored by the parser.
 */

export interface ImportRowIssueDto {
  rowNumber: number;
  itemName: string;
  field: string;
  message: string;
}

export interface ImportFailureDto {
  itemName: string;
  rowNumbers: number[];
  message: string;
}

class PosImportService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  private adapter(vertical: PosVertical): PosImportAdapter {
    const adapter = importAdapterFor(vertical);
    if (!adapter) throw ApiError.badRequest('This POS type imports through its own module');
    return adapter;
  }

  /** The columns the UI documents, straight from that vertical's registry. */
  columns(vertical: PosVertical) {
    const adapter = this.adapter(vertical);
    return {
      noun: adapter.noun,
      maxRows: MAX_IMPORT_ROWS,
      columns: adapter.registry.columns.map((column) => ({
        field: column.field,
        label: column.label,
        required: column.required,
        aliases: column.aliases,
        hint: column.hint,
      })),
    };
  }

  /**
   * Parses and validates an uploaded file and stores the result as a PENDING
   * job. No item, category or stock movement is written here.
   */
  async preview(ctx: TenantContext, vertical: PosVertical, file: { originalname: string; buffer: Buffer }) {
    const adapter = this.adapter(vertical);
    const format = formatFromFilename(file.originalname);
    if (!format) throw ApiError.badRequest('Only Excel (.xlsx) and CSV (.csv) files are supported.');

    const sheet = await parseSheet(file.buffer, format, adapter.registry);

    const items: PreparedImportItem[] = [];
    const errors: ImportRowIssueDto[] = [];
    const seen = new Map<string, number>();
    let invalidRows = 0;

    for (const row of sheet.rows) {
      const { item, issues } = adapter.prepare(row);
      // The same name twice in one file would fail on the second one anyway;
      // saying so here points at the row that caused it.
      if (item) {
        const key = item.name.toLowerCase();
        const first = seen.get(key);
        if (first) {
          issues.push({ field: 'name', message: `The same name is already on row ${first} of this file` });
        } else {
          seen.set(key, row.rowNumber);
        }
      }
      if (issues.length > 0) {
        invalidRows += 1;
        for (const issue of issues) {
          errors.push({ rowNumber: row.rowNumber, itemName: item?.name ?? '', field: issue.field, message: issue.message });
        }
        continue;
      }
      if (item) items.push(item);
    }

    // Which category names the file brings that this workspace does not have.
    const known = new Set((await posCategoryService.list(ctx, vertical, { includeInactive: true })).map((row) => row.name.toLowerCase()));
    const newCategories = [...new Set(items.map((item) => item.categoryName).filter((name) => name && !known.has(name.toLowerCase())))];

    const job = await ProductImportJobModel.create({
      ...this.scope(ctx),
      vertical,
      filename: file.originalname.slice(0, 260),
      format,
      status: 'pending',
      createMissingCategories: true,
      totalRows: sheet.rows.length,
      validRows: items.length,
      invalidRows,
      productsPlanned: items.length,
      plan: items as unknown as Record<string, unknown>[],
      rowErrors: errors.slice(0, MAX_STORED_ERRORS) as unknown as Record<string, unknown>[],
      expiresAt: new Date(Date.now() + PENDING_IMPORT_TTL_MINUTES * 60_000),
      requestedBy: ctx.userId,
      requestedByNameSnapshot: ctx.userName,
    });

    return {
      importId: String(job._id),
      filename: job.filename,
      format,
      noun: adapter.noun,
      headerRow: sheet.headerRowNumber,
      mapping: sheet.mapping,
      unmappedHeaders: sheet.mapping.filter((entry) => !entry.field && !entry.ignored).map((entry) => entry.header),
      summary: {
        totalRows: sheet.rows.length,
        validRows: items.length,
        invalidRows,
        blankRows: sheet.blankRows,
        itemsToCreate: items.length,
        categoriesToCreate: newCategories.length,
        withOpeningStock: items.filter((item) => item.opening).length,
      },
      newCategories,
      // A readable slice of what will be created, not the whole plan.
      preview: items.slice(0, 20).map((item) => ({
        rowNumber: item.rowNumber,
        name: item.name,
        detail: item.detail,
        priceMinor: item.priceMinor,
        category: item.categoryName,
        openingQuantity: item.opening?.quantity ?? 0,
      })),
      errors: errors.slice(0, MAX_STORED_ERRORS),
      errorsTruncated: errors.length > MAX_STORED_ERRORS,
      expiresAt: job.expiresAt,
    };
  }

  /**
   * Creates the items of a previewed import.
   *
   * All-or-nothing is not possible (each item is its own write, and this stack
   * has no cross-document transaction on a standalone server), so the rule is
   * explicit instead: a file with invalid rows is refused unless the user
   * confirms "import the valid rows only".
   */
  async commit(ctx: TenantContext, vertical: PosVertical, importId: Types.ObjectId, input: { skipInvalidRows: boolean }) {
    const adapter = this.adapter(vertical);
    const job = await ProductImportJobModel.findOne({ _id: importId, ...this.scope(ctx), vertical });
    if (!job) throw ApiError.notFound('That import was not found. Upload the file again.');
    if (job.status !== 'pending') throw ApiError.badRequest('That import has already been processed.');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) throw ApiError.badRequest('That import has expired. Upload the file again.');

    const plan = (job.plan ?? []) as unknown as PreparedImportItem[];
    if (plan.length === 0) throw ApiError.badRequest('There is nothing to import: no row in that file was valid.');
    if (job.invalidRows > 0 && !input.skipInvalidRows) {
      throw ApiError.badRequest(
        `${job.invalidRows} row${job.invalidRows === 1 ? '' : 's'} in that file could not be imported. Fix the file and upload it again, or confirm importing the valid rows only.`,
        { reason: 'INVALID_ROWS', invalidRows: job.invalidRows, validRows: job.validRows },
      );
    }

    const failures: ImportFailureDto[] = [];
    let created = 0;
    let stopped = '';

    for (const item of plan) {
      try {
        await adapter.create(ctx, item);
        created += 1;
      } catch (error) {
        const message = this.failureMessage(error, adapter);
        failures.push({ itemName: item.name, rowNumbers: [item.rowNumber], message });
        // The plan's item ceiling is not a per-row problem: everything after
        // this would fail the same way, so stop and say so once.
        if (error instanceof ApiError && error.code === 'LIMIT_EXCEEDED') {
          stopped = message;
          break;
        }
      }
    }

    // The categories come from the items themselves, written down as each one
    // was created (see `posCategoryService.assertUsable`), so nothing here
    // invents a category the file did not use.
    const categoriesNow = await posCategoryService.list(ctx, vertical, { includeInactive: true });

    job.status = failures.length > 0 && created === 0 ? 'failed' : 'completed';
    job.productsCreated = created;
    job.variantsCreated = created;
    job.rowsImported = created;
    job.rowsFailed = failures.length;
    job.categoriesCreated = 0;
    job.error = stopped.slice(0, 300);
    job.plan = [];
    job.expiresAt = null;
    job.completedAt = new Date();
    await job.save();

    return {
      importId: String(job._id),
      status: job.status,
      summary: {
        rowsProcessed: job.totalRows,
        rowsImported: created,
        rowsFailed: failures.length,
        rowsSkipped: job.invalidRows,
        itemsCreated: created,
        categories: categoriesNow.length,
      },
      failures,
      stopped: stopped || null,
    };
  }

  private failureMessage(error: unknown, adapter: PosImportAdapter): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return issue ? `${issue.path.join('.')}: ${issue.message}` : 'The row did not pass validation.';
    }
    logger.error('POS import: unexpected failure while creating an item', { error: String(error), vertical: adapter.vertical });
    return `The ${adapter.noun.one} could not be created.`;
  }

  async list(ctx: TenantContext, vertical: PosVertical, input: { page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const filter = { ...this.scope(ctx), vertical, status: { $ne: 'pending' } };
    const [items, total] = await Promise.all([
      ProductImportJobModel.find(filter).select('-plan -rowErrors').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProductImportJobModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async cancel(ctx: TenantContext, vertical: PosVertical, importId: Types.ObjectId): Promise<ProductImportJobDoc | null> {
    return ProductImportJobModel.findOneAndUpdate(
      { _id: importId, ...this.scope(ctx), vertical, status: 'pending' },
      { $set: { status: 'cancelled', plan: [], expiresAt: null, completedAt: new Date() } },
      { new: true },
    );
  }
}

export const posImportService = new PosImportService();
