import { Types } from 'mongoose';
import { PERMISSIONS } from '../../config/permissions';
import { CustomerModel } from '../../models/Customer';
import { MedicineModel } from '../../models/Medicine';
import { MedicineBatchModel } from '../../models/MedicineBatch';
import { PharmacyHeldSaleModel } from '../../models/PharmacyHeldSale';
import type { TenantContext } from '../../types/express';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { todayUtc } from '../../services/inventory/adapters/pharmacy.adapter';
import type { HoldPharmacySaleInput } from './pharmacy.validators';

const MAX_HOLDS = 50;
const expiryFromNow = () => new Date(Date.now() + 7 * 86_400_000);

class PharmacyHeldSalesService {
  private scope(ctx: TenantContext) { return { tenantId: ctx.tenantId, storeId: ctx.storeId }; }

  async hold(ctx: TenantContext, input: HoldPharmacySaleInput) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) throw ApiError.forbidden('You do not have permission to take a sale');
    if (await PharmacyHeldSaleModel.countDocuments(this.scope(ctx)) >= MAX_HOLDS) {
      throw ApiError.conflict(`This branch already has ${MAX_HOLDS} held sales. Finish or delete one first.`);
    }
    const medicines = await MedicineModel.find({
      _id: { $in: input.items.map((item) => item.medicineId) }, tenantId: ctx.tenantId, deletedAt: null,
    }).lean();
    const items = input.items.map((item) => {
      const medicine = medicines.find((row) => row._id.equals(item.medicineId));
      if (!medicine || !medicine.isActive) throw ApiError.badRequest('One of the medicines is no longer available');
      return { medicineId: medicine._id, quantity: item.quantity, nameSnapshot: medicine.name, strengthSnapshot: medicine.strength, unitPriceMinorSnapshot: medicine.sellingPriceMinor };
    });
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinorSnapshot, 0);
    if (input.discountMinor > subtotal) throw ApiError.badRequest('The discount cannot exceed the subtotal');
    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'pharmacy-hold');
    const created = await PharmacyHeldSaleModel.create({
      ...this.scope(ctx), holdNumber: formatDocumentNumber('HOLD-', seq), items,
      customerId: input.customerId ?? null,
      customerDraft: input.customer ? { name: input.customer.name, phone: input.customer.phone } : null,
      discountMinor: input.discountMinor, prescription: input.prescription ?? null,
      loyaltyCardNumber: input.loyaltyCardNumber, note: input.note,
      estimatedTotalMinor: subtotal - input.discountMinor,
      heldBy: ctx.userId, heldByNameSnapshot: ctx.userName, expiresAt: expiryFromNow(),
    });
    return created.toObject();
  }

  async list(ctx: TenantContext) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE) && !ctx.can(PERMISSIONS.SALES_VIEW)) throw ApiError.forbidden('You do not have permission to see held sales');
    const rows = await PharmacyHeldSaleModel.find(this.scope(ctx)).sort({ createdAt: -1 }).limit(MAX_HOLDS).lean();
    const customerIds = rows.flatMap((row) => row.customerId ? [row.customerId] : []);
    const names = new Map((await CustomerModel.find({ _id: { $in: customerIds }, ...this.scope(ctx), deletedAt: null }).select('name').lean()).map((row) => [String(row._id), row.name]));
    return rows.map((row) => ({
      _id: row._id, holdNumber: row.holdNumber, itemCount: row.items.length,
      estimatedTotalMinor: row.estimatedTotalMinor,
      customerName: row.customerDraft?.name ?? (row.customerId ? names.get(String(row.customerId)) ?? '' : ''),
      heldBy: row.heldBy, heldByNameSnapshot: row.heldByNameSnapshot,
      createdAt: row.createdAt, expiresAt: row.expiresAt,
    }));
  }

  async resume(ctx: TenantContext, id: Types.ObjectId) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) throw ApiError.forbidden('You do not have permission to take a sale');
    const held = await PharmacyHeldSaleModel.findOneAndDelete({ _id: id, ...this.scope(ctx) }).lean();
    if (!held) throw ApiError.notFound('That held sale is no longer available');
    const medicines = await MedicineModel.find({ _id: { $in: held.items.map((row) => row.medicineId) }, tenantId: ctx.tenantId, deletedAt: null, isActive: true }).lean();
    const today = todayUtc();
    const stockRows = await MedicineBatchModel.aggregate<{ _id: Types.ObjectId; sellable: number; nearestExpiry: Date | null }>([
      { $match: { ...this.scope(ctx), medicineId: { $in: medicines.map((row) => row._id) }, expiryDate: { $gte: today } } },
      { $group: { _id: '$medicineId', sellable: { $sum: '$quantityOnHand' }, nearestExpiry: { $min: '$expiryDate' } } },
    ]);
    const stock = new Map(stockRows.map((row) => [String(row._id), { onHand: row.sellable, sellable: Math.max(0, row.sellable), expired: 0, nearestExpiry: row.nearestExpiry }]));
    const items = [];
    const dropped: string[] = [];
    for (const line of held.items) {
      const medicine = medicines.find((row) => row._id.equals(line.medicineId));
      if (!medicine) { dropped.push(`${line.nameSnapshot} ${line.strengthSnapshot}`.trim()); continue; }
      items.push({ quantity: line.quantity, medicine: { ...medicine, stock: stock.get(String(medicine._id)) ?? { onHand: 0, sellable: 0, expired: 0, nearestExpiry: null } }, priceChanged: medicine.sellingPriceMinor !== line.unitPriceMinorSnapshot });
    }
    const savedCustomer = held.customerId ? await CustomerModel.findOne({ _id: held.customerId, ...this.scope(ctx), deletedAt: null }).select('name phone email').lean() : null;
    return {
      holdNumber: held.holdNumber, items, dropped, discountMinor: held.discountMinor,
      prescription: held.prescription, loyaltyCardNumber: held.loyaltyCardNumber, note: held.note,
      customer: savedCustomer ? { id: String(savedCustomer._id), name: savedCustomer.name, phone: savedCustomer.phone, email: savedCustomer.email } : held.customerDraft ? { name: held.customerDraft.name, phone: held.customerDraft.phone } : null,
    };
  }

  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const held = await PharmacyHeldSaleModel.findOne({ _id: id, ...this.scope(ctx) }).select('heldBy holdNumber').lean();
    if (!held) throw ApiError.notFound('Held sale not found');
    if (!held.heldBy.equals(ctx.userId) && !ctx.can(PERMISSIONS.SALES_CANCEL)) throw ApiError.forbidden('You need permission to discard another cashier’s held sale');
    await PharmacyHeldSaleModel.deleteOne({ _id: id, ...this.scope(ctx) });
    return { id: String(id), holdNumber: held.holdNumber };
  }
}

export const pharmacyHeldSalesService = new PharmacyHeldSalesService();
