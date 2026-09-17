import { Types, type ClientSession } from 'mongoose';
import { CustomerModel } from '../../models/Customer';
import { SaleModel } from '../../models/Sale';
import { ApiError } from '../../utils/ApiError';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { sessionOpt } from '../../utils/tx';
import type { TenantContext } from '../../types/express';
import type { CreateCustomerInput, ListCustomersInput, UpdateCustomerInput } from './customers.validators';

class CustomerService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };
  }

  async list(ctx: TenantContext, input: ListCustomersInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (!input.includeInactive) filter.isActive = true;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }

    const sortField = input.sort && ['name', 'createdAt', 'totalSpentMinor', 'lastPurchaseAt'].includes(input.sort)
      ? input.sort
      : 'createdAt';

    const [items, total] = await Promise.all([
      CustomerModel.find(filter).sort({ [sortField]: input.order === 'asc' ? 1 : -1 }).skip(skip).limit(limit).lean(),
      CustomerModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    const customer = await CustomerModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!customer) throw ApiError.notFound('Customer not found');

    const recentSales = await SaleModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, customerId: id })
      .sort({ soldAt: -1 })
      .limit(10)
      .select('saleNumber soldAt totalMinor status paymentMethod returnedTotalMinor')
      .lean();

    return { ...customer, recentSales };
  }

  async create(ctx: TenantContext, input: CreateCustomerInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    await entitlementService.assertCanAddCustomer(ctx.tenantId, entitlement);

    const duplicate = await CustomerModel.findOne({ ...this.scope(ctx), phone: input.phone }).select('_id name').lean();
    if (duplicate) {
      throw ApiError.conflict(`A customer with this phone number already exists (${duplicate.name})`, {
        customerId: duplicate._id,
      });
    }

    const customer = await CustomerModel.create({
      ...input,
      // Last word, so the workspace and branch can only ever be the session's.
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
    });

    // The pre-flight count is not atomic; confirm by ordinal now the record
    // exists, and undo it if this one landed past the ceiling.
    const ordinal = await CustomerModel.countDocuments({
      tenantId: ctx.tenantId,
      deletedAt: null,
      isActive: true,
      _id: { $lte: customer._id },
    });
    try {
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxCustomers', ordinal, 'customer profiles');
    } catch (error) {
      await CustomerModel.deleteOne({ _id: customer._id, tenantId: ctx.tenantId });
      throw error;
    }

    return customer.toObject();
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateCustomerInput) {
    if (input.phone) {
      const duplicate = await CustomerModel.findOne({ ...this.scope(ctx), phone: input.phone, _id: { $ne: id } })
        .select('_id')
        .lean();
      if (duplicate) throw ApiError.conflict('Another customer already uses this phone number');
    }

    const customer = await CustomerModel.findOneAndUpdate(
      { _id: id, ...this.scope(ctx) },
      { $set: input },
      { new: true },
    ).lean();

    if (!customer) throw ApiError.notFound('Customer not found');
    return customer;
  }

  /** Soft delete keeps the customer resolvable from historical sales. */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const customer = await CustomerModel.findOneAndUpdate(
      { _id: id, ...this.scope(ctx) },
      { $set: { deletedAt: new Date(), isActive: false } },
      { new: true },
    ).lean();
    if (!customer) throw ApiError.notFound('Customer not found');
    return { id, softDeleted: true };
  }

  /**
   * Resolves the customer attached to a sale. Customers are OPTIONAL at
   * checkout: a missing id simply yields null and the sale proceeds.
   */
  async resolveForSale(ctx: TenantContext, customerId?: Types.ObjectId | null) {
    if (!customerId) return null;
    const customer = await CustomerModel.findOne({ _id: customerId, ...this.scope(ctx) })
      .select('_id name phone email')
      .lean();
    if (!customer) throw ApiError.badRequest('The selected customer no longer exists');
    return customer;
  }

  /** Finds an existing customer by phone or creates one during checkout. */
  async findOrCreateByPhone(
    ctx: TenantContext,
    input: { name: string; phone: string; email?: string },
    session?: ClientSession,
  ) {
    const existing = await CustomerModel.findOne({ ...this.scope(ctx), phone: input.phone })
      .select('_id name phone email')
      .session(session ?? null)
      .lean();
    if (existing) return existing;

    const [created] = await CustomerModel.create(
      [
        {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          name: input.name,
          phone: input.phone,
          email: input.email ?? '',
        },
      ],
      { session },
    );
    return { _id: created._id, name: created.name, phone: created.phone, email: created.email };
  }

  /** Keeps lifetime-value counters current after a sale or a return. */
  async applySaleStats(
    ctx: TenantContext,
    customerId: Types.ObjectId,
    delta: { amountMinor: number; orderDelta: number; purchasedAt?: Date },
    session?: ClientSession,
  ) {
    await CustomerModel.updateOne(
      { _id: customerId, tenantId: ctx.tenantId },
      {
        $inc: { totalSpentMinor: delta.amountMinor, orderCount: delta.orderDelta },
        ...(delta.purchasedAt ? { $set: { lastPurchaseAt: delta.purchasedAt } } : {}),
      },
      sessionOpt(session),
    );
  }
}

export const customerService = new CustomerService();
