import type { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import { ReturnModel } from '../../models/Return';
import type { TenantContext } from '../../types/express';

/** What came back in a period, as every vertical's report needs it. */
export interface ReturnFigures {
  /** How many returns were processed. */
  count: number;
  /** Money given back. */
  totalMinor: number;
  /** Cost of the goods that came back, so profit can lose it too. */
  costMinor: number;
  /** How many units came back. */
  units: number;
}

export const NO_RETURNS: ReturnFigures = { count: 0, totalMinor: 0, costMinor: 0, units: 0 };

/**
 * Returns recorded against this branch in a period.
 *
 * A sale's figures say what was charged. What was actually KEPT is that less
 * what came back, which is why every report that claims to be "net" has to ask
 * this. Clothing has always done it; the other three started recording returns
 * in task 08 and report them from here.
 */
export async function returnFiguresFor(
  ctx: TenantContext,
  vertical: PosVertical,
  range: { from: Date; to: Date },
): Promise<ReturnFigures> {
  const [row] = await ReturnModel.aggregate<ReturnFigures>([
    { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, vertical, returnedAt: { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalMinor: { $sum: '$totalMinor' },
        units: { $sum: { $sum: '$items.quantity' } },
        // Only goods that went back on the shelf take their cost back with them;
        // a refunded item that was thrown away still cost the shop what it cost.
        costMinor: {
          $sum: {
            $sum: {
              $map: {
                input: '$items',
                as: 'item',
                // The cost the return recorded, already in the vertical's own
                // unit. Returns written before that existed fall back to
                // quantity x unit cost, which is what they have always reported.
                in: {
                  $cond: [
                    '$$item.restock',
                    { $ifNull: ['$$item.costMinor', { $multiply: ['$$item.quantity', { $ifNull: ['$$item.costPriceMinorSnapshot', 0] }] }] },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
    },
  ]);
  return { count: row?.count ?? 0, totalMinor: row?.totalMinor ?? 0, costMinor: row?.costMinor ?? 0, units: row?.units ?? 0 };
}

/** Money and cost returned per day, keyed the way a trend groups its buckets. */
export async function returnsByDay(
  ctx: TenantContext,
  vertical: PosVertical,
  range: { from: Date; to: Date },
  timezone: string,
): Promise<Map<string, { totalMinor: number; costMinor: number }>> {
  const rows = await ReturnModel.aggregate<{ _id: string; totalMinor: number; costMinor: number }>([
    { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, vertical, returnedAt: { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$returnedAt', timezone } },
        totalMinor: { $sum: '$totalMinor' },
        // Only restocked goods give their cost back, as in `returnFiguresFor`.
        costMinor: {
          $sum: {
            $sum: {
              $map: {
                input: '$items',
                as: 'item',
                // The cost the return recorded, already in the vertical's own
                // unit. Returns written before that existed fall back to
                // quantity x unit cost, which is what they have always reported.
                in: {
                  $cond: [
                    '$$item.restock',
                    { $ifNull: ['$$item.costMinor', { $multiply: ['$$item.quantity', { $ifNull: ['$$item.costPriceMinorSnapshot', 0] }] }] },
                    0,
                  ],
                },
              },
            },
          },
        },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id, { totalMinor: row.totalMinor, costMinor: row.costMinor }]));
}

/** Ids are not exported anywhere; this keeps the aggregate's type honest. */
export type ReturnId = Types.ObjectId;

/** The most recent returns of a period, for a report to list. */
export async function recentReturns(
  ctx: TenantContext,
  vertical: PosVertical,
  range: { from: Date; to: Date },
  limit = 10,
) {
  const rows = await ReturnModel.find({
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    vertical,
    returnedAt: { $gte: range.from, $lte: range.to },
  })
    .sort({ returnedAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  return rows.map((row) => ({
    _id: row._id,
    returnNumber: row.returnNumber,
    saleNumber: row.saleNumberSnapshot,
    totalMinor: row.totalMinor,
    reason: row.reason,
    refundMethod: row.refundMethod,
    refundMethodLabel: row.refundMethodLabel ?? row.refundMethod,
    returnedAt: row.returnedAt,
    by: row.processedByNameSnapshot,
    units: row.items.reduce((sum, item) => sum + item.quantity, 0),
    /** Goods refunded but not put back: damaged, opened, expired. */
    notRestockedUnits: row.items.filter((item) => !item.restock).reduce((sum, item) => sum + item.quantity, 0),
  }));
}
