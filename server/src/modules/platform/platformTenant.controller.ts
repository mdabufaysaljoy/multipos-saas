import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { SALE_STATUS } from '../../config/constants';
import { CategoryModel } from '../../models/Category';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { RoleModel } from '../../models/Role';
import { SaleModel } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { PRIMARY_FIRST, SubscriptionModel } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { ROLES } from '../../config/constants';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { getContext } from '../../middleware/tenant';
import { recordAudit } from '../../services/audit/audit.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { walletService } from '../../services/wallet/wallet.service';
import { productService } from '../products/products.service';
import { staffService } from '../staff/staff.service';
import { storeService } from '../stores/stores.service';
import { body, params } from '../../middleware/validate';

/**
 * Everything a platform admin needs to see about one workspace before acting
 * on it: who owns it, what they pay, and how big they are.
 */
export const workspaceOverview = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);

  const [tenant, subscription, stores, usage, wallet] = await Promise.all([
    TenantModel.findById(ctx.tenantId).lean(),
    SubscriptionModel.findOne({ tenantId: ctx.tenantId }).sort(PRIMARY_FIRST).lean(),
    StoreModel.find({ tenantId: ctx.tenantId, deletedAt: null }).lean(),
    entitlementService.usage(ctx.tenantId),
    walletService.balance(ctx.tenantId),
  ]);

  if (!tenant) throw ApiError.notFound('Workspace not found');

  const [owner, staffCount, categoryCount, variantCount, salesRow] = await Promise.all([
    UserModel.findById(tenant.ownerUserId).select('name email phone isActive lastLoginAt').lean(),
    UserModel.countDocuments({ tenantId: ctx.tenantId, role: ROLES.STAFF, deletedAt: null }),
    CategoryModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null }),
    ProductVariantModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null }),
    SaleModel.aggregate<{ orders: number; grossMinor: number; cogsMinor: number }>([
      { $match: { tenantId: ctx.tenantId, status: SALE_STATUS.COMPLETED } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          grossMinor: { $sum: '$totalMinor' },
          cogsMinor: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
              },
            },
          },
        },
      },
    ]),
  ]);

  const entitlement = await entitlementService.forTenant(ctx.tenantId);
  const sales = salesRow[0];

  ok(res, {
    tenant: {
      id: tenant._id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      contactEmail: tenant.contactEmail,
      contactPhone: tenant.contactPhone,
      createdAt: tenant.createdAt,
    },
    owner,
    subscription: subscription
      ? {
          id: subscription._id,
          plan: subscription.planSnapshot,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          autoRenew: subscription.autoRenew,
        }
      : null,
    entitlement,
    wallet,
    counts: {
      branches: stores.length,
      activeBranches: stores.filter((s) => s.isActive).length,
      staff: staffCount,
      products: usage.products,
      variants: variantCount,
      categories: categoryCount,
      orders: sales?.orders ?? 0,
    },
    performance: {
      grossSalesMinor: sales?.grossMinor ?? 0,
      // Profit uses the cost captured at sale time, never today's cost.
      grossProfitMinor: (sales?.grossMinor ?? 0) - (sales?.cogsMinor ?? 0),
    },
    stores: stores.map((store) => ({
      id: store._id,
      name: store.name,
      code: store.code,
      isActive: store.isActive,
      isDefault: store.isDefault,
      phone: store.phone,
      address: store.address,
    })),
  });
});

export const listStores = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await storeService.list(ctx.tenantId));
});

/**
 * Branch creation on the tenant's behalf.
 *
 * Plan limits still apply: a platform admin performing setup should not
 * silently give a Starter customer three branches. `override: true` is the
 * explicit, audited escape hatch for paid setup work.
 */
export const createStore = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<Record<string, unknown> & { override?: boolean }>(req);

  const tenant = await TenantModel.findById(ctx.tenantId).select('ownerUserId name').lean();
  if (!tenant) throw ApiError.notFound('Workspace not found');

  if (!input.override) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    await entitlementService.assertCanAddStore(ctx.tenantId, entitlement);
  }

  const store = await StoreModel.create({
    tenantId: ctx.tenantId,
    name: String(input.name),
    code: String(input.code ?? String(input.name).slice(0, 6)).toUpperCase(),
    phone: (input.phone as string) ?? '',
    email: (input.email as string) ?? '',
    address: (input.address as string) ?? '',
    currency: (input.currency as string) ?? 'BDT',
    isDefault: (await StoreModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null })) === 0,
    isActive: true,
  });

  await recordAudit(req, {
    action: 'CREATE_BRANCH',
    targetTenantId: ctx.tenantId,
    targetStoreId: store._id,
    targetLabel: store.name,
    newValue: { code: store.code, override: Boolean(input.override) },
  });

  created(res, store.toObject());
});

// --------------------------------------------------------------------------
// Audited wrappers. The work itself is delegated to the SAME tenant services
// the store admin uses; these only add the audit trail.
// --------------------------------------------------------------------------

export const auditedDeleteStore = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const before = await StoreModel.findOne({ _id: id, tenantId: ctx.tenantId }).select('name code').lean();
  const result = await storeService.remove(ctx, id);
  await recordAudit(req, {
    action: 'DELETE_BRANCH',
    targetTenantId: ctx.tenantId,
    targetStoreId: id,
    targetLabel: before?.name ?? String(id),
    oldValue: before,
  });
  ok(res, result);
});

export const auditedCreateProduct = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const product = await productService.create(ctx, body(req));
  await recordAudit(req, {
    action: 'CREATE_PRODUCT',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: product.name,
    newValue: { sku: product.sku, variants: product.variants?.length ?? 0 },
  });
  created(res, product);
});

export const auditedUpdateProduct = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const before = await ProductModel.findOne({ _id: id, tenantId: ctx.tenantId }).select('name sku isActive').lean();
  const product = await productService.update(ctx, id, body(req));
  await recordAudit(req, {
    action: 'UPDATE_PRODUCT',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: product.name,
    oldValue: before,
    newValue: { name: product.name, sku: product.sku, isActive: product.isActive },
  });
  ok(res, product);
});

export const auditedDeleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const before = await ProductModel.findOne({ _id: id, tenantId: ctx.tenantId }).select('name sku').lean();
  const result = await productService.remove(ctx, id);
  await recordAudit(req, {
    action: 'DELETE_PRODUCT',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: before?.name ?? String(id),
    oldValue: before,
  });
  ok(res, result);
});

export const auditedCreateStaff = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const staff = await staffService.create(ctx, body(req));
  await recordAudit(req, {
    action: 'CREATE_STAFF',
    targetTenantId: ctx.tenantId,
    targetUserId: new Types.ObjectId(String(staff.id)),
    targetLabel: staff.email,
  });
  created(res, staff);
});

export const auditedUpdateStaff = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const staff = await staffService.update(ctx, id, body(req));
  await recordAudit(req, {
    action: 'UPDATE_STAFF',
    targetTenantId: ctx.tenantId,
    targetUserId: id,
    targetLabel: staff.email,
    newValue: { isActive: staff.isActive, roleId: staff.roleId },
  });
  ok(res, staff);
});

export const auditedCreateRole = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<{ name: string; description?: string; permissions: string[] }>(req);

  const duplicate = await RoleModel.findOne({ tenantId: ctx.tenantId, name: input.name }).select('_id').lean();
  if (duplicate) throw ApiError.conflict('A role with this name already exists');

  const role = await RoleModel.create({ ...input, tenantId: ctx.tenantId, isSystem: false });
  await recordAudit(req, {
    action: 'UPDATE_ROLE',
    targetTenantId: ctx.tenantId,
    targetLabel: role.name,
    newValue: { permissions: role.permissions.length },
  });
  created(res, role.toObject());
});

export const auditedUpdateRole = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<Record<string, unknown>>(req);

  const role = await RoleModel.findOne({ _id: id, tenantId: ctx.tenantId });
  if (!role) throw ApiError.notFound('Role not found');

  const before = { name: role.name, permissions: role.permissions.length };
  if (input.name !== undefined) role.name = String(input.name);
  if (input.description !== undefined) role.description = String(input.description);
  if (Array.isArray(input.permissions)) role.permissions = input.permissions as string[];
  if (input.isActive !== undefined) role.isActive = Boolean(input.isActive);
  await role.save();

  // Holders must re-read their permissions on the next request.
  await UserModel.updateMany({ tenantId: ctx.tenantId, roleId: id }, { $inc: { permissionVersion: 1 } });

  await recordAudit(req, {
    action: 'UPDATE_ROLE',
    targetTenantId: ctx.tenantId,
    targetLabel: role.name,
    oldValue: before,
    newValue: { name: role.name, permissions: role.permissions.length },
  });

  ok(res, role.toObject());
});
