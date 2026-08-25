import { Types } from 'mongoose';
import { StoreModel } from '../../models/Store';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { codeFromName } from '../../utils/slug';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type { AuthUser, TenantContext } from '../../types/express';
import type { CreateStoreInput, UpdateStoreInput } from './stores.validators';

class StoreService {
  async list(tenantId: Types.ObjectId) {
    return StoreModel.find({ tenantId }).sort({ isDefault: -1, createdAt: 1 }).lean();
  }

  /**
   * The subset of store settings the till needs to render correctly: currency,
   * enabled tenders, tax and receipt text.
   *
   * Kept separate from the full settings document so a cashier - who has no
   * settings.view permission - can still run the POS without being handed the
   * whole configuration surface.
   */
  async posConfig(tenantId: Types.ObjectId, storeId: Types.ObjectId) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId })
      .select('name currency paymentMethods tax receipt lowStockThreshold logoUrl')
      .lean();
    if (!store) throw ApiError.notFound('Store not found');

    return {
      _id: store._id,
      name: store.name,
      currency: store.currency,
      paymentMethods: store.paymentMethods,
      tax: store.tax,
      receipt: store.receipt,
      lowStockThreshold: store.lowStockThreshold,
      logoUrl: store.logoUrl,
    };
  }

  async getById(tenantId: Types.ObjectId, storeId: Types.ObjectId) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId }).lean();
    if (!store) throw ApiError.notFound('Store not found');
    return store;
  }

  /**
   * Creates a store for the tenant. The first store becomes the default and is
   * attached to the owner, which is what completes onboarding.
   */
  async create(auth: AuthUser, input: CreateStoreInput) {
    if (!auth.tenantId) throw ApiError.forbidden('You do not belong to a workspace');
    const tenantId = auth.tenantId;

    const entitlement = await entitlementService.forTenant(tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddStore(tenantId, entitlement);

    const existingCount = await StoreModel.countDocuments({ tenantId });
    const code = (input.code ?? codeFromName(input.name)).toUpperCase();

    const duplicate = await StoreModel.findOne({ tenantId, code }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A store with this code already exists in your workspace');

    const store = await StoreModel.create({
      tenantId,
      name: input.name,
      code,
      phone: input.phone,
      email: input.email,
      address: input.address,
      currency: input.currency,
      invoicePrefix: input.invoicePrefix,
      returnPrefix: input.returnPrefix,
      logoUrl: input.logoUrl ?? null,
      lowStockThreshold: input.lowStockThreshold,
      ...(input.paymentMethods ? { paymentMethods: input.paymentMethods } : {}),
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.tax ? { tax: input.tax } : {}),
      isDefault: existingCount === 0,
      isActive: true,
    });

    if (existingCount === 0) {
      await UserModel.updateOne({ _id: auth.id }, { $set: { storeId: store._id } });
    }

    return store.toObject();
  }

  async update(ctx: TenantContext, storeId: Types.ObjectId, input: UpdateStoreInput) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId: ctx.tenantId });
    if (!store) throw ApiError.notFound('Store not found');

    if (input.code && input.code.toUpperCase() !== store.code) {
      const duplicate = await StoreModel.findOne({
        tenantId: ctx.tenantId,
        code: input.code.toUpperCase(),
        _id: { $ne: storeId },
      })
        .select('_id')
        .lean();
      if (duplicate) throw ApiError.conflict('A store with this code already exists');
      store.code = input.code.toUpperCase();
    }

    const scalarKeys = [
      'name', 'phone', 'email', 'address', 'currency',
      'invoicePrefix', 'returnPrefix', 'logoUrl', 'lowStockThreshold', 'paymentMethods',
    ] as const;

    for (const key of scalarKeys) {
      if (input[key] !== undefined) {
        (store as unknown as Record<string, unknown>)[key] = input[key];
      }
    }

    // Nested settings merge rather than replace, so a partial update to the
    // receipt block cannot silently clear the footer.
    if (input.receipt) Object.assign(store.receipt, input.receipt);
    if (input.tax) Object.assign(store.tax, input.tax);

    await store.save();
    return store.toObject();
  }
}

export const storeService = new StoreService();
