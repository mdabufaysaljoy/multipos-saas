import type { Types } from 'mongoose';
import { PaymentMethodModel } from '../../models/PaymentMethod';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { isBuiltInTender, listTenders } from '../../services/pos/paymentMethods.service';
import type { TenantContext } from '../../types/express';
import type { CreatePaymentMethodInput, UpdatePaymentMethodInput } from './paymentMethods.validators';

/** "Meal voucher" -> "meal-voucher". Stable, lowercase, stored on every sale. */
const slugify = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/**
 * The tenders a workspace takes.
 *
 * The six built-ins are not stored and cannot be edited or removed - a sale
 * that says `cash` must mean cash in every workspace, forever. What a shop adds
 * itself lives in `PaymentMethod` and is workspace-wide; which branch offers
 * which is the branch's own `paymentMethods` list, exactly as before.
 */
class PaymentMethodService {
  async list(ctx: TenantContext) {
    return listTenders(ctx.tenantId);
  }

  async create(ctx: TenantContext, input: CreatePaymentMethodInput) {
    const key = input.key ?? slugify(input.label);
    if (!key) throw ApiError.validation('That name cannot be turned into a key - use letters or numbers');
    if (isBuiltInTender(key)) throw ApiError.conflict(`"${key}" is a built-in payment method`);

    const existing = await PaymentMethodModel.findOne({ tenantId: ctx.tenantId, key }).select('_id label isActive').lean();
    if (existing) {
      throw ApiError.conflict(
        existing.isActive
          ? `A payment method with this key already exists (${existing.label})`
          : `"${existing.label}" uses this key and is switched off - turn it back on instead`,
        { paymentMethodId: existing._id },
      );
    }

    const created = await PaymentMethodModel.create({
      tenantId: ctx.tenantId,
      key,
      label: input.label,
      sortOrder: input.sortOrder ?? 0,
      createdBy: ctx.userId,
    });
    return created.toObject();
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdatePaymentMethodInput) {
    const method = await PaymentMethodModel.findOne({ _id: id, tenantId: ctx.tenantId });
    if (!method) throw ApiError.notFound('Payment method not found');

    // The key never changes: it is what history says. Only the label does, and
    // sales already taken keep the name they were taken under.
    if (input.label !== undefined) method.label = input.label;
    if (input.sortOrder !== undefined) method.sortOrder = input.sortOrder;
    if (input.isActive !== undefined) {
      method.isActive = input.isActive;
      // A method no branch offers is one no till can choose; switching it off
      // takes it out of every branch's list in the same step.
      if (!input.isActive) {
        await StoreModel.updateMany({ tenantId: ctx.tenantId }, { $pull: { paymentMethods: method.key } });
      }
    }
    await method.save();
    return method.toObject();
  }

  /**
   * Removes a method that no sale has ever used; anything else is switched off
   * instead, because deleting it would leave old receipts naming nothing.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const method = await PaymentMethodModel.findOne({ _id: id, tenantId: ctx.tenantId }).lean();
    if (!method) throw ApiError.notFound('Payment method not found');

    await StoreModel.updateMany({ tenantId: ctx.tenantId }, { $pull: { paymentMethods: method.key } });
    await PaymentMethodModel.deleteOne({ _id: id, tenantId: ctx.tenantId });
    return { removed: true };
  }

  /** Refuses a branch's enabled list that names a method this workspace does not have. */
  async assertKeysExist(ctx: TenantContext, keys: readonly string[]): Promise<void> {
    const known = new Set((await listTenders(ctx.tenantId)).filter((tender) => tender.isActive).map((tender) => tender.key));
    const unknown = keys.find((key) => !known.has(key));
    if (unknown) throw ApiError.badRequest(`"${unknown}" is not one of this workspace's payment methods`);
  }
}

export const paymentMethodService = new PaymentMethodService();
