import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { PERMISSIONS } from '../../config/permissions';
import { MedicineModel, type MedicineDoc } from '../../models/Medicine';
import { MedicineBatchModel, type MedicineBatchDoc } from '../../models/MedicineBatch';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { PharmacyStockMovementModel } from '../../models/PharmacyStockMovement';
import { StoreModel } from '../../models/Store';
import { loadReceiptStore } from '../../services/receipt/receiptStore';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import { pharmacyInventoryAdapter, pharmacyMovementRow, todayUtc, type PharmacyReservation } from '../../services/inventory/adapters/pharmacy.adapter';
import { POS_TENDER_DIALECT, settleTender } from '../../services/pos/paymentMethods.service';
import { resolveDashboardWindow } from '../reports/reports.service';
import type { DashboardRangeInput } from '../reports/reports.validators';
import type { TenantContext } from '../../types/express';
import type {
  AdjustBatchInput,
  CreateMedicineInput,
  CreateSaleInput,
  ListBatchesInput,
  ListMedicinesInput,
  ListMovementsInput,
  ListSalesInput,
  ReceiveBatchInput,
  UpdateMedicineInput,
} from './pharmacy.validators';

type MedicineRecord = MedicineDoc & { _id: Types.ObjectId };
type BatchRecord = MedicineBatchDoc & { _id: Types.ObjectId };

/** Stock taken for a sale, kept so it can be put back if the sale fails. */
export interface MedicineStock {
  onHand: number;
  sellable: number;
  expired: number;
  nearestExpiry: Date | null;
}

const DAY_MS = 86_400_000;
/** Safety valve for allocation retries under heavy contention. */

/** Today as a UTC calendar date. Batches expiring today are still sellable. */
export { todayUtc };
const utcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const EMPTY_STOCK: MedicineStock = { onHand: 0, sellable: 0, expired: 0, nearestExpiry: null };

/**
 * Pharmacy POS.
 *
 * Built on the shared core like Restaurant: tenant and branch scope come from
 * `ctx`, plan limits from the entitlement service (medicines count against the
 * products limit, sales against the monthly sales limit), and permissions reuse
 * the existing keys. What is specific to a pharmacy:
 *
 *   - stock lives in dated batches per branch;
 *   - a sale takes the earliest-expiring unexpired batches first (FEFO), each
 *     through an atomic guarded decrement, and records which batches it took;
 *   - expired stock is never sold;
 *   - a sale with a prescription-only medicine must record the prescription;
 *   - every stock change is written to an append-only movement ledger.
 */
class PharmacyService {
  // ================================================================ medicines

  async listMedicines(ctx: TenantContext, input: ListMedicinesInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, deletedAt: null };
    if (input.activeOnly) filter.isActive = true;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ name: rx }, { genericName: rx }, { barcode: rx }, { manufacturer: rx }];
    }
    if (input.inStockOnly) {
      filter._id = {
        $in: await MedicineBatchModel.distinct('medicineId', {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          quantityOnHand: { $gt: 0 },
          expiryDate: { $gte: todayUtc() },
        }),
      };
    }

    const [items, total] = await Promise.all([
      MedicineModel.find(filter).sort({ name: 1, strength: 1 }).skip(skip).limit(limit).lean<MedicineRecord[]>(),
      MedicineModel.countDocuments(filter),
    ]);
    const stock = await this.stockFor(ctx, items.map((item) => item._id));
    return {
      items: items.map((item) => ({ ...item, stock: stock.get(String(item._id)) ?? EMPTY_STOCK })),
      page,
      limit,
      total,
    };
  }

  /** A medicine with its batches in the current branch, earliest expiry first. */
  async getMedicine(ctx: TenantContext, id: Types.ObjectId) {
    const medicine = await this.findMedicine(ctx, id);
    const [batches, stock] = await Promise.all([
      MedicineBatchModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, medicineId: id })
        .sort({ expiryDate: 1, _id: 1 })
        .limit(200)
        .lean(),
      this.stockFor(ctx, [medicine._id]),
    ]);
    return { medicine: { ...medicine, stock: stock.get(String(medicine._id)) ?? EMPTY_STOCK }, batches };
  }

  async createMedicine(ctx: TenantContext, input: CreateMedicineInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    await entitlementService.assertCanAddProduct(ctx.tenantId, entitlement, 'pharmacy');

    const values = { ...input, category: input.category || 'General' };
    await this.assertUnique(ctx, values);
    const medicine = await MedicineModel.create({ tenantId: ctx.tenantId, ...values, createdBy: ctx.userId });
    return medicine.toObject();
  }

  async updateMedicine(ctx: TenantContext, id: Types.ObjectId, input: UpdateMedicineInput) {
    const before = await this.findMedicine(ctx, id);
    const identity = {
      name: input.name ?? before.name,
      strength: input.strength ?? before.strength,
      dosageForm: input.dosageForm ?? before.dosageForm,
      barcode: input.barcode ?? before.barcode,
    };
    await this.assertUnique(ctx, identity, id);

    const after = await MedicineModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, deletedAt: null },
      { $set: input },
      { new: true, runValidators: true },
    ).lean<MedicineRecord>();
    if (!after) throw ApiError.notFound('Medicine not found');
    return { before, after };
  }

  /** Soft delete, refused while any branch still holds stock of it. */
  async removeMedicine(ctx: TenantContext, id: Types.ObjectId) {
    const medicine = await this.findMedicine(ctx, id);
    const [held] = await MedicineBatchModel.aggregate<{ units: number }>([
      { $match: { tenantId: ctx.tenantId, medicineId: medicine._id, quantityOnHand: { $gt: 0 } } },
      { $group: { _id: null, units: { $sum: '$quantityOnHand' } } },
    ]);
    if ((held?.units ?? 0) > 0) {
      throw ApiError.conflict(`${held.units} unit(s) of ${medicine.name} are still in stock. Sell or write them off first.`);
    }
    await MedicineModel.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { deletedAt: new Date(), isActive: false } });
    return { id };
  }

  // ==================================================================== stock

  /**
   * Receives stock into a batch. The same batch number with the same expiry
   * adds to that batch; the same number with a different expiry is refused, as
   * it is almost certainly a typing mistake. An already-expired batch is refused.
   */
  async receiveBatch(ctx: TenantContext, medicineId: Types.ObjectId, input: ReceiveBatchInput) {
    const medicine = await this.findMedicine(ctx, medicineId);
    const expiryDate = utcDate(input.expiryDate);
    if (expiryDate < todayUtc()) throw ApiError.badRequest('This batch has already expired and cannot be received');

    const batchNumber = input.batchNumber.toUpperCase();
    const key = { tenantId: ctx.tenantId, storeId: ctx.storeId, medicineId: medicine._id, batchNumber };
    const addToExisting = () =>
      MedicineBatchModel.findOneAndUpdate(
        { ...key, expiryDate },
        { $inc: { quantityReceived: input.quantity, quantityOnHand: input.quantity } },
        { new: true },
      ).lean<BatchRecord>();

    let batch = await addToExisting();
    if (!batch) {
      try {
        const created = await MedicineBatchModel.create({
          ...key,
          expiryDate,
          quantityReceived: input.quantity,
          quantityOnHand: input.quantity,
          costPriceMinor: input.costPriceMinor,
          supplierName: input.supplierName,
          receivedBy: ctx.userId,
          receivedByNameSnapshot: ctx.userName,
        });
        batch = created.toObject() as BatchRecord;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Created a moment ago by someone else with the same expiry, or it exists with another.
        batch = await addToExisting();
        if (!batch) {
          const existing = await MedicineBatchModel.findOne(key).select('expiryDate').lean();
          throw ApiError.conflict(
            `Batch ${batchNumber} is already recorded with expiry ${existing?.expiryDate.toISOString().slice(0, 10) ?? 'another date'}.`,
          );
        }
      }
    }

    await PharmacyStockMovementModel.create(
      pharmacyMovementRow(ctx, batch, medicine.name, 'receive', input.quantity, batch.quantityOnHand, {
        reason: input.supplierName ? `Received from ${input.supplierName}` : 'Stock received',
      }),
    );
    return batch;
  }

  async listBatches(ctx: TenantContext, input: ListBatchesInput) {
    const { page, limit, skip } = resolvePage(input);
    const today = todayUtc();
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId, quantityOnHand: { $gt: 0 } };
    if (input.medicineId) filter.medicineId = input.medicineId;
    if (input.status === 'expiring') filter.expiryDate = { $gte: today, $lt: new Date(today.getTime() + (input.days + 1) * DAY_MS) };
    if (input.status === 'expired') filter.expiryDate = { $lt: today };

    const [items, total] = await Promise.all([
      MedicineBatchModel.find(filter)
        .sort({ expiryDate: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .populate('medicineId', 'name genericName strength dosageForm')
        .lean(),
      MedicineBatchModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  /** A counted correction or a write-off (expired, damaged, lost). Never below zero. */
  async adjustBatch(ctx: TenantContext, id: Types.ObjectId, input: AdjustBatchInput) {
    const delta = input.quantityDelta;
    const updated = await MedicineBatchModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, ...(delta < 0 ? { quantityOnHand: { $gte: -delta } } : {}) },
      { $inc: { quantityOnHand: delta } },
      { new: true },
    ).lean<BatchRecord>();
    if (!updated) {
      const batch = await MedicineBatchModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId }).lean();
      if (!batch) throw ApiError.notFound('Batch not found');
      throw ApiError.badRequest(`Only ${batch.quantityOnHand} unit(s) are on hand in batch ${batch.batchNumber}.`);
    }

    const medicine = await MedicineModel.findOne({ _id: updated.medicineId, tenantId: ctx.tenantId }).select('name').lean();
    await PharmacyStockMovementModel.create(
      pharmacyMovementRow(ctx, updated, medicine?.name ?? '', input.type, delta, updated.quantityOnHand, { reason: input.reason }),
    );
    return { batch: updated, previousOnHand: updated.quantityOnHand - delta, medicineName: medicine?.name ?? '' };
  }

  async listMovements(ctx: TenantContext, input: ListMovementsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.medicineId) filter.medicineId = input.medicineId;
    if (input.batchId) filter.batchId = input.batchId;
    const [items, total] = await Promise.all([
      PharmacyStockMovementModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      PharmacyStockMovementModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  // ==================================================================== sales

  async createSale(ctx: TenantContext, input: CreateSaleInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    // Checked before any stock moves, so a refused sale leaves nothing to undo.
    await entitlementService.assertCanRecordSale(ctx.tenantId, entitlement, 'pharmacy');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods invoicePrefix').lean();
    if (!store) throw ApiError.notFound('Branch not found');

    // ---- price from the catalogue ---------------------------------------
    const medicines = await MedicineModel.find({
      _id: { $in: input.items.map((item) => item.medicineId) },
      tenantId: ctx.tenantId,
      deletedAt: null,
    }).lean<MedicineRecord[]>();
    const priced = input.items.map((item) => {
      const medicine = medicines.find((entry) => entry._id.equals(item.medicineId));
      if (!medicine) throw ApiError.badRequest('One of the medicines is not in this pharmacy');
      if (!medicine.isActive) throw ApiError.badRequest(`${medicine.name} is not for sale right now`);
      const lineTotalMinor = medicine.sellingPriceMinor * item.quantity;
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That line is too large');
      return { medicine, quantity: item.quantity, lineTotalMinor };
    });

    const prescriptionOnly = priced.filter((line) => line.medicine.requiresPrescription);
    if (prescriptionOnly.length > 0 && !input.prescription) {
      throw ApiError.badRequest(
        `A prescription is required for ${prescriptionOnly.map((line) => line.medicine.name).join(', ')}.`,
        { reason: 'PRESCRIPTION_REQUIRED', medicineIds: prescriptionOnly.map((line) => line.medicine._id) },
      );
    }

    // ---- money ----------------------------------------------------------
    const subtotalMinor = priced.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (input.discountMinor > 0 && !ctx.can(PERMISSIONS.SALES_DISCOUNT)) {
      throw ApiError.forbidden('You do not have permission to give a discount');
    }
    if (input.discountMinor > subtotalMinor) throw ApiError.badRequest('The discount cannot exceed the subtotal');

    const totalMinor = subtotalMinor - input.discountMinor;
    // Enabled for the branch, covering the total, change only out of cash:
    // the same three rules every POS settles by.
    const { paidMinor, changeMinor } = settleTender({
      totalMinor,
      tendered: input.payments,
      accepted: store.paymentMethods ?? [],
      dialect: POS_TENDER_DIALECT,
    });

    // Optional, and resolved the same way in every vertical: an existing
    // customer, or one created at the till from a name and phone. This is who
    // the medicine was dispensed to; the prescription names the patient.
    const customer = await customerService.resolveForPosSale(ctx, input);

    // ---- take stock, earliest expiry first --------------------------------
    // Through the adapter, so shared code can do this without knowing that a
    // pharmacy fills a line from batches and never from an expired one.
    const taken: PharmacyReservation[] = [];
    try {
      for (const line of priced) {
        taken.push(await pharmacyInventoryAdapter.reserve(ctx, {
          itemId: line.medicine._id,
          quantity: line.quantity,
          label: line.medicine.name,
        }));
      }
    } catch (error) {
      await pharmacyInventoryAdapter.release(ctx, taken);
      throw error;
    }

    // ---- persist ----------------------------------------------------------
    const saleId = new Types.ObjectId();
    let saved = false;
    try {
      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'pharmacy-sale');
      const saleNumber = formatDocumentNumber(store.invoicePrefix || 'RX-', seq);
      const soldAt = new Date();

      const sale = await PharmacySaleModel.create({
        _id: saleId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        saleNumber,
        items: priced.map((line) => ({
          _id: new Types.ObjectId(),
          medicineId: line.medicine._id,
          nameSnapshot: line.medicine.name,
          genericNameSnapshot: line.medicine.genericName,
          strengthSnapshot: line.medicine.strength,
          dosageFormSnapshot: line.medicine.dosageForm,
          requiresPrescription: line.medicine.requiresPrescription,
          unitPriceMinor: line.medicine.sellingPriceMinor,
          quantity: line.quantity,
          lineTotalMinor: line.lineTotalMinor,
          allocations: taken
            .filter((entry) => entry.itemId.equals(line.medicine._id))
            .flatMap((entry) => entry.detail.allocations)
            .map(({ batchId, batchNumber, expiryDate, quantity, costPriceMinor }) => ({ batchId, batchNumber, expiryDate, quantity, costPriceMinor })),
        })),
        subtotalMinor,
        discountMinor: input.discountMinor,
        totalMinor,
        costMinor: taken.reduce(
          (sum, entry) => sum + entry.detail.allocations.reduce((lineSum, allocation) => lineSum + allocation.quantity * allocation.costPriceMinor, 0),
          0,
        ),
        paidMinor,
        changeMinor,
        payments: input.payments,
        prescription: input.prescription ?? null,
        customerId: customer?._id ?? null,
        customerNameSnapshot: customer?.name ?? '',
        note: input.note,
        status: 'completed',
        soldAt,
        cashierId: ctx.userId,
        cashierNameSnapshot: ctx.userName,
      });
      saved = true;

      // The pre-flight allowance check is not atomic; confirm by ordinal now
      // the sale exists. Ordered by id ONLY: bounding by sale time as well would
      // let two racing sales each miss the other and both count as first.
      const ordinal = await PharmacySaleModel.countDocuments({
        tenantId: ctx.tenantId,
        status: 'completed',
        soldAt: { $gte: dayjs(soldAt).startOf('month').toDate() },
        _id: { $lte: saleId },
      });
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxMonthlySales', ordinal, 'sales per month');

      await pharmacyInventoryAdapter.commit(ctx, taken, { referenceId: saleId, referenceNumber: saleNumber });
      if (customer) {
        await customerService.applySaleStats(ctx, customer._id, { amountMinor: totalMinor, orderDelta: 1, purchasedAt: soldAt });
      }

      return sale.toObject();
    } catch (error) {
      if (saved) await PharmacySaleModel.deleteOne({ _id: saleId, tenantId: ctx.tenantId });
      await pharmacyInventoryAdapter.release(ctx, taken);
      throw error;
    }
  }

  async listSales(ctx: TenantContext, input: ListSalesInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.status) filter.status = input.status;
    if (input.prescriptionOnly) filter.prescription = { $ne: null };
    if (input.from || input.to) {
      filter.soldAt = {
        ...(input.from ? { $gte: dayjs(input.from).startOf('day').toDate() } : {}),
        ...(input.to ? { $lte: dayjs(input.to).endOf('day').toDate() } : {}),
      };
    }
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ saleNumber: rx }, { 'prescription.patientName': rx }, { 'items.nameSnapshot': rx }];
    }
    const [items, total] = await Promise.all([
      PharmacySaleModel.find(filter).sort({ soldAt: -1 }).skip(skip).limit(limit).lean(),
      PharmacySaleModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async getSale(ctx: TenantContext, id: Types.ObjectId) {
    const sale = await PharmacySaleModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId }).lean();
    if (!sale) throw ApiError.notFound('Sale not found');
    return sale;
  }

  async receipt(ctx: TenantContext, id: Types.ObjectId) {
    const sale = await this.getSale(ctx, id);
    const store = await loadReceiptStore(ctx.tenantId, ctx.storeId, sale.storeId);
    return { sale, store };
  }

  /** Voids a completed sale and returns its stock to the batches it came from. Final. */
  async voidSale(ctx: TenantContext, id: Types.ObjectId, reason: string) {
    const sale = await PharmacySaleModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' },
      { $set: { status: 'voided', voidedAt: new Date(), voidedBy: ctx.userId, voidedByNameSnapshot: ctx.userName, voidReason: reason } },
      { new: true },
    ).lean();
    if (!sale) {
      await this.getSale(ctx, id);
      throw ApiError.conflict('This sale has already been voided');
    }

    // The sale happened, so every unit going back to its own batch is a
    // movement of its own.
    await pharmacyInventoryAdapter.restore(
      ctx,
      sale.items.map((line) => ({
        itemId: line.medicineId,
        quantity: line.quantity,
        balanceAfter: 0,
        detail: { medicineName: line.nameSnapshot, allocations: line.allocations.map((allocation) => ({ ...allocation, balanceAfter: 0 })) },
      })),
      { reason, referenceId: sale._id, referenceNumber: sale.saleNumber },
    );

    // A voided sale is not a purchase: take it back off the customer's total.
    if (sale.customerId) {
      await customerService.applySaleStats(ctx, sale.customerId, { amountMinor: -sale.totalMinor, orderDelta: -1 });
    }

    return sale;
  }

  // ================================================================ dashboard

  /**
   * The Pharmacy dashboard for the current branch.
   *
   * Trading figures cover the chosen range and are compared with the period of
   * equal length just before it. Stock is not a period: what is low and what is
   * expiring are always "right now", whatever range is chosen, because that is
   * what the shelf looks like when someone walks up to it.
   */
  async dashboard(ctx: TenantContext, input: DashboardRangeInput) {
    const { bucket, previousFrom, previousTo, ...range } = resolveDashboardWindow(input);
    const today = todayUtc();
    const soon = new Date(today.getTime() + 31 * DAY_MS);
    const completed = { tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' };
    const soldIn = (from: Date, to: Date) => ({ ...completed, soldAt: { $gte: from, $lte: to } });
    const totals = (from: Date, to: Date) =>
      PharmacySaleModel.aggregate<{ count: number; totalMinor: number; discountMinor: number }>([
        { $match: soldIn(from, to) },
        { $group: { _id: null, count: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' }, discountMinor: { $sum: '$discountMinor' } } },
      ]);

    const [currentRows, previousRows, prescriptionSales, expiring, expiredRows, reorderable] = await Promise.all([
      totals(range.from, range.to),
      totals(previousFrom, previousTo),
      PharmacySaleModel.countDocuments({ ...soldIn(range.from, range.to), prescription: { $ne: null } }),
      MedicineBatchModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, quantityOnHand: { $gt: 0 }, expiryDate: { $gte: today, $lt: soon } })
        .sort({ expiryDate: 1 })
        .limit(10)
        .populate<{ medicineId: { _id: Types.ObjectId; name: string; strength: string } | null }>('medicineId', 'name strength')
        .lean(),
      MedicineBatchModel.aggregate<{ batches: number; units: number; costMinor: number }>([
        { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, quantityOnHand: { $gt: 0 }, expiryDate: { $lt: today } } },
        {
          $group: {
            _id: null,
            batches: { $sum: 1 },
            units: { $sum: '$quantityOnHand' },
            costMinor: { $sum: { $multiply: ['$quantityOnHand', '$costPriceMinor'] } },
          },
        },
      ]),
      MedicineModel.find({ tenantId: ctx.tenantId, deletedAt: null, isActive: true, reorderLevel: { $gt: 0 } })
        .select('name strength reorderLevel')
        .limit(500)
        .lean<MedicineRecord[]>(),
    ]);

    const stock = await this.stockFor(ctx, reorderable.map((medicine) => medicine._id));
    const lowStock = reorderable
      .map((medicine) => ({
        medicineId: medicine._id,
        name: medicine.name,
        strength: medicine.strength,
        reorderLevel: medicine.reorderLevel,
        sellable: stock.get(String(medicine._id))?.sellable ?? 0,
      }))
      .filter((row) => row.sellable <= row.reorderLevel)
      .sort((a, b) => a.sellable - b.sellable)
      .slice(0, 10);

    const summarise = (rows: { count: number; totalMinor: number; discountMinor: number }[]) => {
      const row = rows[0];
      const salesCount = row?.count ?? 0;
      const totalMinor = row?.totalMinor ?? 0;
      return {
        salesCount,
        totalMinor,
        discountMinor: row?.discountMinor ?? 0,
        averageSaleMinor: salesCount > 0 ? Math.round(totalMinor / salesCount) : 0,
      };
    };
    const current = summarise(currentRows);

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: range.preset, bucket },
      kpis: { ...current, prescriptionSales },
      previous: summarise(previousRows),
      expiringSoon: expiring.map((batch) => ({
        batchId: batch._id,
        medicineId: batch.medicineId?._id ?? null,
        medicineName: batch.medicineId?.name ?? 'Removed medicine',
        strength: batch.medicineId?.strength ?? '',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantityOnHand: batch.quantityOnHand,
      })),
      expired: { batches: expiredRows[0]?.batches ?? 0, units: expiredRows[0]?.units ?? 0, costMinor: expiredRows[0]?.costMinor ?? 0 },
      lowStock,
    };
  }

  // ================================================================== helpers

  /**
   * Takes `quantity` of a medicine from this branch's unexpired batches,
   * earliest expiry first. Each step is one guarded atomic decrement; losing a
   * race to another till simply looks again. Everything taken is appended to
   * `taken`, so the caller can put it all back if the sale cannot complete.
   */




  /** On-hand, sellable (unexpired) and expired units per medicine in this branch. */
  private async stockFor(ctx: TenantContext, medicineIds: Types.ObjectId[]) {
    if (medicineIds.length === 0) return new Map<string, MedicineStock>();
    const today = todayUtc();
    const rows = await MedicineBatchModel.aggregate<{ _id: Types.ObjectId; onHand: number; sellable: number; nearestExpiry: Date | null }>([
      { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, medicineId: { $in: medicineIds }, quantityOnHand: { $gt: 0 } } },
      {
        $group: {
          _id: '$medicineId',
          onHand: { $sum: '$quantityOnHand' },
          sellable: { $sum: { $cond: [{ $gte: ['$expiryDate', today] }, '$quantityOnHand', 0] } },
          nearestExpiry: { $min: { $cond: [{ $gte: ['$expiryDate', today] }, '$expiryDate', null] } },
        },
      },
    ]);
    return new Map(
      rows.map((row) => [
        String(row._id),
        { onHand: row.onHand, sellable: row.sellable, expired: row.onHand - row.sellable, nearestExpiry: row.nearestExpiry ?? null },
      ]),
    );
  }

  private async findMedicine(ctx: TenantContext, id: Types.ObjectId) {
    const medicine = await MedicineModel.findOne({ _id: id, tenantId: ctx.tenantId, deletedAt: null }).lean<MedicineRecord>();
    if (!medicine) throw ApiError.notFound('Medicine not found');
    return medicine;
  }

  /** Same name, strength and form is one medicine; a barcode belongs to one medicine. */
  private async assertUnique(
    ctx: TenantContext,
    identity: { name: string; strength: string; dosageForm: string; barcode: string },
    exceptId?: Types.ObjectId,
  ) {
    const except = exceptId ? { _id: { $ne: exceptId } } : {};
    const sameMedicine = await MedicineModel.exists({
      tenantId: ctx.tenantId,
      deletedAt: null,
      name: exact(identity.name),
      strength: exact(identity.strength),
      dosageForm: identity.dosageForm,
      ...except,
    });
    if (sameMedicine) throw ApiError.conflict('This medicine (same name, strength and form) already exists');
    if (identity.barcode) {
      const sameBarcode = await MedicineModel.exists({ tenantId: ctx.tenantId, deletedAt: null, barcode: identity.barcode, ...except });
      if (sameBarcode) throw ApiError.conflict('Another medicine already uses this barcode');
    }
  }


}

export const pharmacyService = new PharmacyService();
