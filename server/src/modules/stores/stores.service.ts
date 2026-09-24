import { assertEntitlement, hasEntitlement } from '../../services/entitlements/entitlementEngine';
import { DEFAULT_LOYALTY_SETTINGS } from '../loyalty/loyalty.service';
import { Types } from 'mongoose';
import { DEFAULT_LABEL_SETTINGS, StoreModel } from '../../models/Store';
import { SaleModel } from '../../models/Sale';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { listTenders } from '../../services/pos/paymentMethods.service';
import { paymentMethodService } from '../paymentMethods/paymentMethods.service';
import { codeFromName } from '../../utils/slug';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { droppedKeys, releaseStorageUrls } from '../../services/storage/cleanup.service';
import type { AuthUser, TenantContext } from '../../types/express';
import type { CreateStoreInput, UpdateStoreInput } from './stores.validators';

class StoreService {
  async list(tenantId: Types.ObjectId) {
    return StoreModel.find({ tenantId, deletedAt: null }).sort({ isDefault: -1, createdAt: 1 }).lean();
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
    const store = await StoreModel.findOne({ _id: storeId, tenantId, deletedAt: null })
      .select('name currency paymentMethods tax receipt lowStockThreshold logoUrl receiptLogoUrl loyalty labels')
      .lean();
    if (!store) throw ApiError.notFound('Store not found');

    // What each enabled tender is called here, so the till shows the shop's own
    // names. `paymentMethods` stays a list of keys: it is what every existing
    // client reads, and what a sale records.
    const tenders = (await listTenders(tenantId))
      .filter((tender) => tender.isActive && store.paymentMethods.includes(tender.key))
      .map(({ key, label }) => ({ key, label }));

    return {
      _id: store._id,
      name: store.name,
      currency: store.currency,
      paymentMethods: store.paymentMethods,
      tenders,
      tax: store.tax,
      receipt: store.receipt,
      lowStockThreshold: store.lowStockThreshold,
      logoUrl: store.logoUrl,
      receiptLogoUrl: store.receiptLogoUrl,
      // Every till prints labels, so the sizes travel with the POS config.
      labels: { ...DEFAULT_LABEL_SETTINGS, ...(store.labels ?? {}) },
      // What the till needs to show and redeem points. Off unless the plan includes it AND the owner enabled it.
      loyalty: {
        available: Boolean(store.loyalty?.enabled) && (await hasEntitlement(tenantId, 'loyalty')),
        pointValueMinor: store.loyalty?.pointValueMinor ?? 100,
        earnSpendMinor: store.loyalty?.earnSpendMinor ?? 10_000,
        membershipFeeMinor: store.loyalty?.membershipFeeMinor ?? 0,
      },
    };
  }

  async getById(tenantId: Types.ObjectId, storeId: Types.ObjectId) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId, deletedAt: null }).lean();
    if (!store) throw ApiError.notFound('Store not found');
    // Older stores have no label block yet; the settings screen always gets a complete one.
    return { ...store, labels: { ...DEFAULT_LABEL_SETTINGS, ...(store.labels ?? {}) } };
  }

  /**
   * Creates a store for the tenant. The first store becomes the default and is
   * attached to the owner, which is what completes onboarding.
   */
  async create(auth: AuthUser, input: CreateStoreInput) {
    if (!auth.tenantId) throw ApiError.forbidden('You do not belong to a workspace');
    const tenantId = auth.tenantId;

    const existingCount = await StoreModel.countDocuments({ tenantId, deletedAt: null });
    // The FIRST store is part of having a workspace at all, not a plan feature:
    // without one, the workspace cannot even reach its wallet or subscription
    // page to buy a plan. It is exempt from the plan checks; every further
    // store is not. Selling still requires a usable subscription regardless.
    const isFirstStore = existingCount === 0;

    const entitlement = await entitlementService.forTenant(tenantId);
    if (!isFirstStore) {
      entitlementService.assertUsable(entitlement);
      await entitlementService.assertCanAddStore(tenantId, entitlement);
    }
    const code = (input.code ?? codeFromName(input.name)).toUpperCase();

    const duplicate = await StoreModel.findOne({ tenantId, code, deletedAt: null }).select('_id').lean();
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
      receiptLogoUrl: input.receiptLogoUrl ?? null,
      lowStockThreshold: input.lowStockThreshold,
      ...(input.paymentMethods ? { paymentMethods: input.paymentMethods } : {}),
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.tax ? { tax: input.tax } : {}),
      isDefault: existingCount === 0,
      isActive: true,
    });

    // Ordinal confirmation, because the pre-flight count is not atomic.
    const ordinal = await StoreModel.countDocuments({
      tenantId,
      isActive: true,
      deletedAt: null,
      _id: { $lte: store._id },
    });
    try {
      // A concurrent racer for the first slot is still held to the plan.
      if (!(isFirstStore && ordinal === 1)) {
        entitlementService.assertOrdinalWithinLimit(entitlement, 'maxStores', ordinal, 'stores');
      }
    } catch (error) {
      await StoreModel.deleteOne({ _id: store._id, tenantId });
      throw error;
    }

    if (isFirstStore) {
      // Becomes the user's home branch ONLY if this is the user's own
      // workspace. An account owner setting up another workspace must not have
      // their home branch replaced by a branch that belongs somewhere else.
      await UserModel.updateOne({ _id: auth.id, tenantId }, { $set: { storeId: store._id } });
    }

    return store.toObject();
  }

  async update(ctx: TenantContext, storeId: Types.ObjectId, input: UpdateStoreInput) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId: ctx.tenantId, deletedAt: null });
    if (!store) throw ApiError.notFound('Store not found');

    if (input.code && input.code.toUpperCase() !== store.code) {
      const duplicate = await StoreModel.findOne({
        tenantId: ctx.tenantId,
        code: input.code.toUpperCase(),
        deletedAt: null,
        _id: { $ne: storeId },
      })
        .select('_id')
        .lean();
      if (duplicate) throw ApiError.conflict('A store with this code already exists');
      store.code = input.code.toUpperCase();
    }

    // Branding images are files. Swapping one out should release the old one
    // rather than leaving it to consume quota forever.
    const previousBranding = { logoUrl: store.logoUrl, receiptLogoUrl: store.receiptLogoUrl };

    const scalarKeys = [
      'name', 'phone', 'email', 'address', 'currency',
      'invoicePrefix', 'returnPrefix', 'logoUrl', 'receiptLogoUrl', 'lowStockThreshold', 'paymentMethods',
    ] as const;

    // A branch can only enable tenders this workspace actually has; a typo here
    // would otherwise be a method no till could ever use.
    if (input.paymentMethods) await paymentMethodService.assertKeysExist(ctx, input.paymentMethods);

    for (const key of scalarKeys) {
      if (input[key] !== undefined) {
        (store as unknown as Record<string, unknown>)[key] = input[key];
      }
    }

    // Nested settings merge rather than replace, so a partial update to the
    // receipt block cannot silently clear the footer.
    if (input.receipt) Object.assign(store.receipt, input.receipt);
    if (input.tax) Object.assign(store.tax, input.tax);
    // Stores created before label settings existed have no block, so merge onto the defaults.
    if (input.labels) store.set('labels', { ...DEFAULT_LABEL_SETTINGS, ...(store.labels ?? {}), ...input.labels });
    if (input.loyalty) {
      // Loyalty rules are part of the plan, not just the settings screen.
      await assertEntitlement(ctx.tenantId, 'loyalty');
      // Stores created before loyalty existed have no block at all, so merge onto the defaults.
      store.set('loyalty', { ...DEFAULT_LOYALTY_SETTINGS, ...(store.loyalty ?? {}), ...input.loyalty });
    }

    if (input.isActive !== undefined && input.isActive !== store.isActive) {
      if (!input.isActive) {
        // A workspace must always keep at least one usable branch.
        const activeCount = await StoreModel.countDocuments({ tenantId: ctx.tenantId, isActive: true, deletedAt: null });
        if (activeCount <= 1) {
          throw ApiError.badRequest('You cannot deactivate your only active branch');
        }
        if (store.isDefault) {
          throw ApiError.badRequest('The main branch cannot be deactivated. Make another branch the main one first.');
        }
      }
      store.isActive = input.isActive;
    }

    await store.save();

    // After the save: a failed write must not destroy a logo still in use.
    await releaseStorageUrls(
      ctx.tenantId,
      droppedKeys(
        [previousBranding.logoUrl, previousBranding.receiptLogoUrl],
        [store.logoUrl, store.receiptLogoUrl],
      ),
    );

    return store.toObject();
  }

  /**
   * Deletes a branch.
   *
   * Soft delete, for the same reason products are: sales, returns and inventory
   * transactions reference the store, and destroying it would break historical
   * reporting. The record is hidden everywhere, its code is freed for reuse,
   * and every past sale still resolves.
   */
  async remove(ctx: TenantContext, storeId: Types.ObjectId) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId: ctx.tenantId, deletedAt: null });
    if (!store) throw ApiError.notFound('Branch not found');

    if (store.isDefault) {
      throw ApiError.badRequest(
        'The main branch cannot be deleted. Make another branch the main one first, then delete this one.',
      );
    }

    const liveCount = await StoreModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null });
    if (liveCount <= 1) throw ApiError.badRequest('You cannot delete your only branch');

    // Surfaced so the UI can reassure the owner that nothing is lost.
    const [saleCount, staffCount] = await Promise.all([
      SaleModel.countDocuments({ tenantId: ctx.tenantId, storeId }),
      UserModel.countDocuments({ tenantId: ctx.tenantId, storeId, deletedAt: null }),
    ]);

    store.deletedAt = new Date();
    store.isActive = false;
    await store.save();

    // Staff whose home branch was this one are moved to the main branch so they
    // are not stranded without a place to work.
    const fallback = await StoreModel.findOne({ tenantId: ctx.tenantId, deletedAt: null })
      .sort({ isDefault: -1, createdAt: 1 })
      .select('_id')
      .lean();

    if (fallback) {
      await UserModel.updateMany(
        { tenantId: ctx.tenantId, storeId, deletedAt: null },
        { $set: { storeId: fallback._id }, $inc: { permissionVersion: 1 } },
      );
      await UserModel.updateMany({ tenantId: ctx.tenantId, storeAccess: storeId }, { $pull: { storeAccess: storeId } });
    }

    return {
      id: storeId,
      softDeleted: true,
      historicalSalesPreserved: saleCount,
      staffReassigned: staffCount,
    };
  }

  /** Promotes a branch to be the tenant's main one. */
  async makeDefault(ctx: TenantContext, storeId: Types.ObjectId) {
    const store = await StoreModel.findOne({ _id: storeId, tenantId: ctx.tenantId, deletedAt: null });
    if (!store) throw ApiError.notFound('Branch not found');
    if (!store.isActive) throw ApiError.badRequest('Activate the branch before making it the main one');

    await StoreModel.updateMany({ tenantId: ctx.tenantId }, { $set: { isDefault: false } });
    store.isDefault = true;
    await store.save();

    return store.toObject();
  }
}

export const storeService = new StoreService();
