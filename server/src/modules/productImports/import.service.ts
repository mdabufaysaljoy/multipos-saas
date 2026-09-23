import { Types } from 'mongoose';
import { ZodError } from 'zod';
import { CategoryModel } from '../../models/Category';
import { ProductImportJobModel, type ProductImportJobDoc } from '../../models/ProductImportJob';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';
import { categoryService } from '../categories/categories.service';
import { productService } from '../products/products.service';
import { createProductSchema } from '../products/products.validators';
import { IMPORT_COLUMNS } from './import.columns';
import { MAX_IMPORT_ROWS, MAX_STORED_ERRORS, PENDING_IMPORT_TTL_MINUTES } from './import.limits';
import { formatFromFilename, parseProductSheet, type ImportFormat } from './import.parse';
import { optionsFor, validateRows, type ImportRowError, type PreparedProduct } from './import.validate';

/**
 * Bulk product import (Clothing POS, every subscription plan).
 *
 * Two steps on purpose: "validate & preview" never writes a product, and
 * "confirm" creates them through the SAME product service the New product form
 * uses - so SKU generation, barcode uniqueness, category resolution, the
 * opening-stock ledger entry, the plan's product limit and the per-product
 * transaction all behave exactly as they do for a manually created product.
 *
 * Nothing about ownership comes from the file: tenant and branch are taken from
 * the authenticated context, and id-like columns are ignored by the parser.
 */

export interface ImportFailure {
  productName: string;
  rowNumbers: number[];
  message: string;
}

class ProductImportService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  /** The columns the UI documents, straight from the registry. */
  columns() {
    return IMPORT_COLUMNS.map((column) => ({
      field: column.field,
      label: column.label,
      required: column.required,
      aliases: column.aliases,
      hint: column.hint,
    }));
  }

  /**
   * Parses and validates an uploaded file and stores the result as a PENDING
   * job. No product, variant, category or stock movement is written here.
   */
  async preview(
    ctx: TenantContext,
    file: { originalname: string; buffer: Buffer; size: number },
    options: { createMissingCategories: boolean },
  ) {
    const format = formatFromFilename(file.originalname);
    if (!format) throw ApiError.badRequest('Only Excel (.xlsx) and CSV (.csv) files are supported.');

    const sheet = await parseProductSheet(file.buffer, format);
    const validation = await validateRows(ctx, sheet.rows, options);

    const job = await ProductImportJobModel.create({
      ...this.scope(ctx),
      filename: file.originalname.slice(0, 260),
      format,
      status: 'pending',
      createMissingCategories: options.createMissingCategories,
      totalRows: validation.totalRows,
      validRows: validation.validRows,
      invalidRows: validation.invalidRows,
      productsPlanned: validation.products.length,
      plan: validation.products as unknown as Record<string, unknown>[],
      rowErrors: validation.errors.slice(0, MAX_STORED_ERRORS) as unknown as Record<string, unknown>[],
      expiresAt: new Date(Date.now() + PENDING_IMPORT_TTL_MINUTES * 60_000),
      requestedBy: ctx.userId,
      requestedByNameSnapshot: ctx.userName,
    });

    return {
      importId: String(job._id),
      filename: job.filename,
      format,
      headerRow: sheet.headerRowNumber,
      mapping: sheet.mapping,
      unmappedHeaders: sheet.mapping.filter((entry) => !entry.field && !entry.ignored).map((entry) => entry.header),
      summary: {
        totalRows: validation.totalRows,
        validRows: validation.validRows,
        invalidRows: validation.invalidRows,
        blankRows: sheet.blankRows,
        productsToCreate: validation.products.length,
        variantsToCreate: validation.validRows,
        categoriesToCreate: validation.missingCategories.length,
      },
      missingCategories: validation.missingCategories,
      // A readable slice of what will be created, not the whole plan.
      preview: validation.products.slice(0, 20).map((product) => ({
        name: product.name,
        brand: product.brand,
        category: product.categoryName,
        variants: product.variants.slice(0, 10).map((variant) => ({
          name: variant.name,
          sku: variant.sku ?? '',
          barcode: variant.barcode ?? '',
          sellingPriceMinor: variant.sellingPriceMinor,
          stock: variant.stock,
        })),
        variantCount: product.variants.length,
      })),
      errors: validation.errors.slice(0, MAX_STORED_ERRORS),
      errorsTruncated: validation.errors.length > MAX_STORED_ERRORS,
      expiresAt: job.expiresAt,
    };
  }

  /**
   * Creates the products of a previewed import.
   *
   * All-or-nothing is not possible across products (each product is its own
   * transaction, and the stack has no cross-document one on a standalone
   * server), so the rule is explicit instead: a file with invalid rows is
   * refused unless the user confirms "import the valid rows only".
   */
  async commit(ctx: TenantContext, importId: Types.ObjectId, input: { skipInvalidRows: boolean }) {
    const job = await ProductImportJobModel.findOne({ _id: importId, ...this.scope(ctx) });
    if (!job) throw ApiError.notFound('That import was not found. Upload the file again.');
    if (job.status !== 'pending') throw ApiError.badRequest('That import has already been processed.');
    if (job.expiresAt && job.expiresAt.getTime() < Date.now()) throw ApiError.badRequest('That import has expired. Upload the file again.');

    const plan = (job.plan ?? []) as unknown as PreparedProduct[];
    if (plan.length === 0) throw ApiError.badRequest('There is nothing to import: no row in that file was valid.');
    if (job.invalidRows > 0 && !input.skipInvalidRows) {
      throw ApiError.badRequest(
        `${job.invalidRows} row${job.invalidRows === 1 ? '' : 's'} in that file could not be imported. Fix the file and upload it again, or confirm importing the valid rows only.`,
        { reason: 'INVALID_ROWS', invalidRows: job.invalidRows, validRows: job.validRows },
      );
    }

    const categories = await this.resolveCategories(ctx, plan, job.createMissingCategories);

    const failures: ImportFailure[] = [];
    let productsCreated = 0;
    let variantsCreated = 0;
    let stopped = '';

    for (const product of plan) {
      try {
        // The import data goes through the product API's own schema first, so a
        // bulk create can never take a shape a manual create would refuse.
        const input = createProductSchema.parse({
          name: product.name,
          // A string: the product schema parses ids exactly as the API does.
          categoryId: categories.idOf.get(slugify(product.categoryName))?.toString() ?? null,
          description: product.description,
          brand: product.brand,
          images: [],
          options: optionsFor(product),
          isActive: product.isActive,
          variants: product.variants.map((variant) => ({
            name: variant.name,
            attributes: variant.attributes,
            ...(variant.sku ? { sku: variant.sku } : {}),
            barcode: variant.barcode,
            sellingPriceMinor: variant.sellingPriceMinor,
            costPriceMinor: variant.costPriceMinor,
            stock: variant.stock,
            lowStockThreshold: variant.lowStockThreshold,
            isActive: variant.isActive,
          })),
        });
        await productService.create(ctx, input);
        productsCreated += 1;
        variantsCreated += product.variants.length;
      } catch (error) {
        const message = this.failureMessage(error);
        failures.push({ productName: product.name, rowNumbers: product.rowNumbers, message });
        // The plan's product ceiling is not a per-row problem: everything after
        // this would fail the same way, so stop and say so once.
        if (error instanceof ApiError && error.code === 'LIMIT_EXCEEDED') {
          stopped = message;
          break;
        }
      }
    }

    const rowsImported = variantsCreated;
    const rowsFailed = failures.reduce((total, failure) => total + failure.rowNumbers.length, 0);

    job.status = failures.length > 0 && productsCreated === 0 ? 'failed' : 'completed';
    job.productsCreated = productsCreated;
    job.variantsCreated = variantsCreated;
    job.rowsImported = rowsImported;
    job.rowsFailed = rowsFailed;
    job.categoriesCreated = categories.created;
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
        rowsImported,
        rowsFailed,
        rowsSkipped: job.invalidRows,
        productsCreated,
        variantsCreated,
        categoriesCreated: categories.created,
      },
      failures,
      stopped: stopped || null,
    };
  }

  /**
   * Categories are resolved INSIDE the current branch, by name. An id in the
   * file is never used: the parser drops id columns, and a category from
   * another workspace therefore cannot be attached to an imported product.
   */
  private async resolveCategories(ctx: TenantContext, plan: PreparedProduct[], createMissing: boolean) {
    const wanted = [...new Set(plan.map((product) => product.categoryName).filter(Boolean))];
    const existing = await CategoryModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null })
      .select('name slug')
      .lean();
    const idOf = new Map<string, Types.ObjectId>(existing.map((category) => [category.slug, category._id]));

    let created = 0;
    for (const name of wanted) {
      const slug = slugify(name);
      if (idOf.has(slug)) continue;
      if (!createMissing) throw ApiError.badRequest(`Category "${name}" does not exist in this branch.`);
      // The ordinary category service: same validation, same branch, same rules.
      const category = await categoryService.create(ctx, { name, description: '', parentId: undefined, isActive: true });
      idOf.set(slug, category._id as Types.ObjectId);
      created += 1;
    }

    return { idOf, created };
  }

  private failureMessage(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      return issue ? `${issue.path.join('.')}: ${issue.message}` : 'The row did not pass product validation.';
    }
    logger.error('Product import: unexpected failure while creating a product', { error: String(error) });
    return 'The product could not be created.';
  }

  async list(ctx: TenantContext, input: { page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const filter = { ...this.scope(ctx), status: { $ne: 'pending' } };
    const [items, total] = await Promise.all([
      ProductImportJobModel.find(filter).select('-plan -rowErrors').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProductImportJobModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async cancel(ctx: TenantContext, importId: Types.ObjectId): Promise<ProductImportJobDoc | null> {
    return ProductImportJobModel.findOneAndUpdate(
      { _id: importId, ...this.scope(ctx), status: 'pending' },
      { $set: { status: 'cancelled', plan: [], expiresAt: null, completedAt: new Date() } },
      { new: true },
    );
  }

  readonly maxRows = MAX_IMPORT_ROWS;
}

export const productImportService = new ProductImportService();
export type ImportRowErrorDto = ImportRowError;
export type { ImportFormat };
