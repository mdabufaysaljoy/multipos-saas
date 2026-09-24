import { z } from 'zod';
import type { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import { InventoryTransactionModel } from '../../models/InventoryTransaction';
import { PharmacyStockMovementModel } from '../../models/PharmacyStockMovement';
import { ShopStockMovementModel } from '../../models/ShopStockMovement';
import { calendarDate, objectId, paginationSchema } from '../../modules/common/common.validators';
import { resolvePage } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';

/**
 * One stock movement, as every vertical reports it.
 *
 * Each vertical keeps its own ledger, with its own columns - a Clothing row
 * names a variant and its SKU, a Pharmacy row names the batch it came out of,
 * a Super Shop row carries the unit and what the goods cost. Those columns
 * stay. What is shared is the question every ledger answers: what moved, by
 * how much, what was left, why, and who did it.
 */
export interface PosLedgerRow {
  id: string;
  at: Date;
  /** The variant, medicine or product that moved. */
  itemId: Types.ObjectId;
  /** How the till would name it: "Shirt (Red / M)", "Napa 500mg", "Keya Soap". */
  itemLabel: string;
  /** The vertical's own second line: a SKU, a batch number, a unit. */
  itemDetail: string;
  type: string;
  /** Signed: negative took stock out, positive put it back. */
  quantityChange: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  referenceType: string | null;
  referenceId: Types.ObjectId | null;
  referenceNumber: string;
  by: string;
}

/** The one query every vertical's ledger accepts. */
export const posLedgerQuerySchema = paginationSchema.extend({
  /** The variant, medicine or product to trace. */
  itemId: objectId.optional(),
  type: z.string().trim().max(40).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export type PosLedgerQuery = z.infer<typeof posLedgerQuerySchema>;

/** Which field of each vertical's ledger holds the item id. */
const ITEM_FIELD: Record<string, string> = { clothing: 'variantId', pharmacy: 'medicineId', supershop: 'productId' };

function baseFilter(ctx: TenantContext, vertical: PosVertical, input: PosLedgerQuery) {
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
  if (input.itemId) filter[ITEM_FIELD[vertical]] = input.itemId;
  if (input.type) filter.type = input.type;
  if (input.from || input.to) {
    filter.createdAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) };
  }
  return filter;
}

/**
 * The stock ledger of the current branch, whichever POS it runs.
 *
 * A Restaurant has no stock and so no ledger: it answers with an empty page
 * rather than an error, because "nothing moved" is the true answer there.
 */
export async function readPosLedger(
  ctx: TenantContext,
  vertical: PosVertical,
  input: PosLedgerQuery,
): Promise<{ items: PosLedgerRow[]; page: number; limit: number; total: number }> {
  const { page, limit, skip } = resolvePage(input);
  const empty = { items: [] as PosLedgerRow[], page, limit, total: 0 };

  if (vertical === 'clothing') {
    const filter = baseFilter(ctx, vertical, input);
    const [rows, total] = await Promise.all([
      InventoryTransactionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InventoryTransactionModel.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => ({
        id: String(row._id),
        at: row.createdAt,
        itemId: row.variantId,
        itemLabel: `${row.productNameSnapshot} (${row.variantNameSnapshot})`.replace(' ()', ''),
        itemDetail: row.skuSnapshot,
        type: row.type,
        quantityChange: row.quantityChange,
        balanceBefore: row.previousStock,
        balanceAfter: row.newStock,
        reason: row.reason,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        referenceNumber: row.referenceNumber,
        by: row.performedByNameSnapshot,
      })),
      page,
      limit,
      total,
    };
  }

  if (vertical === 'pharmacy') {
    const filter = baseFilter(ctx, vertical, input);
    const [rows, total] = await Promise.all([
      PharmacyStockMovementModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      PharmacyStockMovementModel.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => ({
        id: String(row._id),
        at: row.createdAt,
        itemId: row.medicineId,
        itemLabel: row.medicineNameSnapshot,
        itemDetail: `Batch ${row.batchNumberSnapshot}`,
        type: row.type,
        quantityChange: row.quantity,
        balanceBefore: row.balanceAfter - row.quantity,
        balanceAfter: row.balanceAfter,
        reason: row.reason,
        referenceType: row.referenceNumber ? 'sale' : null,
        referenceId: row.referenceId,
        referenceNumber: row.referenceNumber,
        by: row.createdByNameSnapshot,
      })),
      page,
      limit,
      total,
    };
  }

  if (vertical === 'supershop') {
    const filter = baseFilter(ctx, vertical, input);
    const [rows, total] = await Promise.all([
      ShopStockMovementModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      ShopStockMovementModel.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => ({
        id: String(row._id),
        at: row.createdAt,
        itemId: row.productId,
        itemLabel: row.productNameSnapshot,
        itemDetail: row.unitType === 'weight' ? 'by weight' : 'by piece',
        type: row.type,
        quantityChange: row.quantity,
        balanceBefore: row.balanceAfter - row.quantity,
        balanceAfter: row.balanceAfter,
        reason: row.reason,
        referenceType: row.referenceNumber ? 'sale' : null,
        referenceId: row.referenceId,
        referenceNumber: row.referenceNumber,
        by: row.createdByNameSnapshot,
      })),
      page,
      limit,
      total,
    };
  }

  // Restaurant, and any vertical with no stock: nothing ever moved.
  return empty;
}
