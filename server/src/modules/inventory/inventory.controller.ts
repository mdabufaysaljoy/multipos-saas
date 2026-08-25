import type { Request, Response } from 'express';
import { InventoryTransactionModel } from '../../models/InventoryTransaction';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { inventoryService } from '../../services/inventory/inventory.service';
import type { AdjustStockInput, LedgerInput, ListStockInput } from './inventory.validators';

/** Stock-on-hand view: one row per sellable variant. */
export const listStock = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = query<ListStockInput>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    deletedAt: null,
  };

  if (input.search) {
    const rx = searchRegex(input.search);
    filter.$or = [{ productNameSnapshot: rx }, { name: rx }, { sku: rx }, { barcode: input.search.trim() }];
  }
  if (input.outOfStockOnly) filter.stock = { $lte: 0 };

  if (input.categoryId) {
    const productIds = await ProductModel.find({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      categoryId: input.categoryId,
      deletedAt: null,
    })
      .select('_id')
      .lean();
    filter.productId = { $in: productIds.map((p) => p._id) };
  }

  // "Low stock" compares two fields, which needs $expr rather than a plain match.
  if (input.lowStockOnly) {
    filter.$expr = { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] };
  }

  // Sorting is done by the database so it stays correct across pages.
  const SORTS: Record<string, Record<string, 1 | -1>> = {
    name: { productNameSnapshot: 1, name: 1 },
    stockAsc: { stock: 1, productNameSnapshot: 1 },
    stockDesc: { stock: -1, productNameSnapshot: 1 },
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    valueDesc: { sellingPriceMinor: -1 },
  };
  const sort = SORTS[input.sortBy] ?? SORTS.stockAsc;

  const [items, total] = await Promise.all([
    ProductVariantModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    ProductVariantModel.countDocuments(filter),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

export const adjust = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await inventoryService.adjust(ctx, body<AdjustStockInput>(req)));
});

/** The audit trail for a variant or the whole store. */
export const ledger = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = query<LedgerInput>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
  if (input.variantId) filter.variantId = input.variantId;
  if (input.productId) filter.productId = input.productId;
  if (input.type) filter.type = input.type;
  if (input.from || input.to) {
    filter.createdAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) };
  }

  const [items, total] = await Promise.all([
    InventoryTransactionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    InventoryTransactionModel.countDocuments(filter),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

/** Counters for the inventory dashboard cards. */
export const summary = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const base = { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };

  const [totals] = await ProductVariantModel.aggregate<{
    totalUnits: number;
    stockValueMinor: number;
    retailValueMinor: number;
    variantCount: number;
  }>([
    { $match: base },
    {
      $group: {
        _id: null,
        totalUnits: { $sum: '$stock' },
        stockValueMinor: { $sum: { $multiply: ['$stock', '$costPriceMinor'] } },
        retailValueMinor: { $sum: { $multiply: ['$stock', '$sellingPriceMinor'] } },
        variantCount: { $sum: 1 },
      },
    },
  ]);

  const [outOfStock, lowStock] = await Promise.all([
    ProductVariantModel.countDocuments({ ...base, stock: { $lte: 0 } }),
    ProductVariantModel.countDocuments({
      ...base,
      $expr: { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }, { $gt: ['$stock', 0] }] },
    }),
  ]);

  ok(res, {
    totalUnits: totals?.totalUnits ?? 0,
    stockValueMinor: totals?.stockValueMinor ?? 0,
    retailValueMinor: totals?.retailValueMinor ?? 0,
    variantCount: totals?.variantCount ?? 0,
    outOfStock,
    lowStock,
  });
});
