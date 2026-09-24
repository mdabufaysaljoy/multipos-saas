import { Types } from 'mongoose';
import { MedicineModel } from '../../../models/Medicine';
import { MedicineBatchModel, type MedicineBatchDoc } from '../../../models/MedicineBatch';
import { PharmacyStockMovementModel, type StockMovementType } from '../../../models/PharmacyStockMovement';
import type { BatchAllocation } from '../../../models/PharmacySale';
import { ApiError } from '../../../utils/ApiError';
import type { TenantContext } from '../../../types/express';
import type { InventoryAdapter, Reservation, StockDescription, StockMoveRef, StockRequest } from '../adapter';

type BatchRecord = MedicineBatchDoc & { _id: Types.ObjectId };

/** Midnight UTC today: the boundary an expiry date is compared against. */
export const todayUtc = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

/** A pathological catalogue cannot spin the allocator forever. */
const MAX_ALLOCATION_STEPS = 200;

/** Which batches a line was drawn from - the dispensing record the sale keeps. */
export interface PharmacyStockDetail {
  medicineName: string;
  allocations: (BatchAllocation & { balanceAfter: number })[];
}

export type PharmacyReservation = Reservation<PharmacyStockDetail>;

/** One ledger row, in the shape `PharmacyStockMovement` stores. */
export function pharmacyMovementRow(
  ctx: TenantContext,
  batch: { _id: Types.ObjectId; medicineId: Types.ObjectId; batchNumber: string },
  medicineName: string,
  type: StockMovementType,
  quantity: number,
  balanceAfter: number,
  extra: { reason?: string; referenceId?: Types.ObjectId | null; referenceNumber?: string } = {},
) {
  return {
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    medicineId: batch.medicineId,
    batchId: batch._id,
    batchNumberSnapshot: batch.batchNumber,
    medicineNameSnapshot: medicineName,
    type,
    quantity,
    balanceAfter,
    reason: extra.reason ?? '',
    referenceId: extra.referenceId ?? null,
    referenceNumber: extra.referenceNumber ?? '',
    createdBy: ctx.userId,
    createdByNameSnapshot: ctx.userName,
  };
}

/**
 * Pharmacy stock: batches, earliest expiry first, never expired, never negative.
 *
 * A line is filled from as many batches as it takes. Each step is one guarded
 * atomic decrement, so losing a race to another till simply looks again; what
 * was taken is remembered batch by batch, because that is both how it goes back
 * and what has to be printed on the receipt.
 */
class PharmacyInventoryAdapter implements InventoryAdapter<PharmacyStockDetail> {
  readonly vertical = 'pharmacy' as const;
  readonly tracksStock = true;

  async reserve(ctx: TenantContext, request: StockRequest): Promise<PharmacyReservation> {
    const today = todayUtc();
    const allocations: PharmacyStockDetail['allocations'] = [];
    let remaining = request.quantity;

    for (let step = 0; remaining > 0 && step < MAX_ALLOCATION_STEPS; step += 1) {
      const batch = await MedicineBatchModel.findOne({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        medicineId: request.itemId,
        quantityOnHand: { $gt: 0 },
        expiryDate: { $gte: today },
      })
        .sort({ expiryDate: 1, _id: 1 })
        .lean<BatchRecord>();
      if (!batch) break;

      const take = Math.min(remaining, batch.quantityOnHand);
      const updated = await MedicineBatchModel.findOneAndUpdate(
        { _id: batch._id, tenantId: ctx.tenantId, storeId: ctx.storeId, quantityOnHand: { $gte: take }, expiryDate: { $gte: today } },
        { $inc: { quantityOnHand: -take } },
        { new: true },
      ).lean<BatchRecord>();
      if (!updated) continue;

      allocations.push({
        batchId: batch._id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: take,
        costPriceMinor: batch.costPriceMinor,
        balanceAfter: updated.quantityOnHand,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      // Put back whatever this line already took before refusing it.
      await this.releaseAllocations(ctx, allocations);
      const available = request.quantity - remaining;
      throw ApiError.badRequest(`Only ${available} unexpired unit(s) of ${request.label} are in stock in this branch.`, {
        medicineId: request.itemId,
        requested: request.quantity,
        available,
      });
    }

    return {
      itemId: request.itemId,
      quantity: request.quantity,
      balanceAfter: allocations.at(-1)?.balanceAfter ?? 0,
      detail: { medicineName: request.label, allocations },
    };
  }

  /** A sale that never happened leaves no trace: stock back, no ledger row. */
  async release(ctx: TenantContext, reservations: PharmacyReservation[]): Promise<void> {
    for (const reservation of reservations) await this.releaseAllocations(ctx, reservation.detail.allocations);
    reservations.length = 0;
  }

  async commit(ctx: TenantContext, reservations: PharmacyReservation[], ref: StockMoveRef): Promise<void> {
    const rows = reservations.flatMap((reservation) =>
      reservation.detail.allocations.map((allocation) =>
        pharmacyMovementRow(
          ctx,
          { _id: allocation.batchId, medicineId: reservation.itemId, batchNumber: allocation.batchNumber },
          reservation.detail.medicineName,
          'sale',
          -allocation.quantity,
          allocation.balanceAfter,
          { reason: ref.reason, referenceId: ref.referenceId, referenceNumber: ref.referenceNumber },
        ),
      ),
    );
    if (rows.length > 0) await PharmacyStockMovementModel.insertMany(rows);
  }

  /**
   * A completed sale coming back. Every unit returns to the batch it came from
   * - a pharmacy may not mix batches - and each batch gets its own ledger row.
   */
  async restore(ctx: TenantContext, reservations: PharmacyReservation[], ref: StockMoveRef): Promise<void> {
    const rows = [];
    for (const reservation of reservations) {
      for (const allocation of reservation.detail.allocations) {
        const batch = await MedicineBatchModel.findOneAndUpdate(
          { _id: allocation.batchId, tenantId: ctx.tenantId, storeId: ctx.storeId },
          { $inc: { quantityOnHand: allocation.quantity } },
          { new: true },
        ).lean<BatchRecord>();
        if (!batch) continue;
        rows.push(
          pharmacyMovementRow(ctx, batch, reservation.detail.medicineName, 'void', allocation.quantity, batch.quantityOnHand, {
            reason: ref.reason,
            referenceId: ref.referenceId,
            referenceNumber: ref.referenceNumber,
          }),
        );
      }
    }
    if (rows.length > 0) await PharmacyStockMovementModel.insertMany(rows);
  }

  async describe(ctx: TenantContext, itemId: Types.ObjectId): Promise<StockDescription | null> {
    const medicine = await MedicineModel.findOne({ _id: itemId, tenantId: ctx.tenantId, deletedAt: null }).select('name strength').lean();
    if (!medicine) return null;
    const [row] = await MedicineBatchModel.aggregate<{ sellable: number }>([
      { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, medicineId: itemId, expiryDate: { $gte: todayUtc() } } },
      { $group: { _id: null, sellable: { $sum: '$quantityOnHand' } } },
    ]);
    return { itemId, label: `${medicine.name} ${medicine.strength}`.trim(), onHand: row?.sellable ?? 0 };
  }

  private async releaseAllocations(ctx: TenantContext, allocations: { batchId: Types.ObjectId; quantity: number }[]): Promise<void> {
    await Promise.all(
      allocations.map((allocation) =>
        MedicineBatchModel.updateOne({ _id: allocation.batchId, tenantId: ctx.tenantId }, { $inc: { quantityOnHand: allocation.quantity } }),
      ),
    );
    allocations.length = 0;
  }
}

export const pharmacyInventoryAdapter = new PharmacyInventoryAdapter();
