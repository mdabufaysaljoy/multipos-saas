import type { Types } from 'mongoose';
import type { Permission } from '../../config/permissions';
import { SupplierModel } from '../../models/Supplier';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextTenantSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';
import type { CreateSupplierInput, ListSuppliersInput, UpdateSupplierInput } from './suppliers.validators';

/**
 * Supplier management (Clothing POS, Professional and Enterprise).
 *
 * Suppliers belong to the WORKSPACE, not a branch: the same wholesalers supply
 * every shop of the business. Every query is therefore scoped by `tenantId`
 * alone, taken from the authenticated session - never from the request.
 *
 * The plan's supplier ceiling is enforced twice: a pre-flight count, and an
 * ordinal check after the insert that undoes a record which landed past the
 * limit. That second check is what makes two simultaneous creates on a full
 * Professional plan safe (see entitlement.service.ts).
 */

/** Everything a list row needs. Banking and tax details are deliberately absent. */
const LIST_FIELDS = 'code name type contact.name contact.phone contact.email phone email isActive createdAt updatedAt';

/** Codes are SUP-0001, SUP-0002… per workspace, from an atomic counter. */
const SUPPLIER_CODE_PREFIX = 'SUP-';
const SUPPLIER_CODE_PAD = 4;
const MAX_CODE_ATTEMPTS = 5;

/**
 * What the API returns.
 *
 * Banking details are the only sensitive part of a supplier, so they are
 * included ONLY when the caller may edit suppliers (the people who set them)
 * and never in a list. Everything else is ordinary business contact data.
 */
const present = <T extends { banking?: unknown }>(supplier: T, options: { banking: boolean }) => {
  const { banking, ...rest } = supplier;
  return {
    ...rest,
    ...(options.banking ? { banking: banking ?? {} } : {}),
  };
};

class SupplierService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  /** Whether this session may see banking details. */
  private canSeeBanking(ctx: TenantContext, permission: Permission) {
    return ctx.isAdmin || ctx.permissions.includes(permission);
  }

  async list(ctx: TenantContext, input: ListSuppliersInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (input.status === 'active') filter.isActive = true;
    if (input.status === 'inactive') filter.isActive = false;
    if (input.type) filter.type = input.type;
    if (input.search) {
      const rx = searchRegex(input.search);
      // The five things a person searches a supplier list by.
      filter.$or = [{ name: rx }, { code: rx }, { phone: rx }, { email: rx }, { 'contact.name': rx }, { 'contact.phone': rx }];
    }

    const sortField = input.sort && ['name', 'createdAt', 'updatedAt', 'code'].includes(input.sort) ? input.sort : 'createdAt';
    const sort: Record<string, 1 | -1> = { [sortField]: input.order === 'asc' ? 1 : -1 };

    const [items, total] = await Promise.all([
      SupplierModel.find(filter).select(LIST_FIELDS).sort(sort).skip(skip).limit(limit).lean(),
      SupplierModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId, permission: Permission) {
    const supplier = await SupplierModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!supplier) throw ApiError.notFound('Supplier not found');
    return present(supplier, { banking: this.canSeeBanking(ctx, permission) });
  }

  async create(ctx: TenantContext, input: CreateSupplierInput, permission: Permission) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddSupplier(ctx.tenantId, entitlement);

    await this.assertNotDuplicate(ctx, input);

    const supplier = await this.insertWithCode(ctx, input);

    // The pre-flight count is not atomic, so confirm by ordinal now that the
    // record exists: racing creates each get a distinct, stable position and
    // only the ones past the ceiling undo themselves.
    const ordinal = await SupplierModel.countDocuments({
      tenantId: ctx.tenantId,
      deletedAt: null,
      isActive: true,
      _id: { $lte: supplier._id },
    });
    try {
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxSuppliers', ordinal, 'suppliers');
    } catch (error) {
      await SupplierModel.deleteOne({ _id: supplier._id, tenantId: ctx.tenantId });
      throw error;
    }

    return present(supplier.toObject(), { banking: this.canSeeBanking(ctx, permission) });
  }

  /**
   * Inserts with a generated code, retrying on the unique index.
   *
   * The counter is atomic, so a collision only happens if a code was created by
   * some other path (a restored backup, a manual fix); retrying costs nothing
   * and keeps a duplicate-key error from ever reaching the user.
   */
  private async insertWithCode(ctx: TenantContext, input: CreateSupplierInput) {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const seq = await nextTenantSequence(ctx.tenantId, 'supplier');
      const code = formatDocumentNumber(SUPPLIER_CODE_PREFIX, seq, SUPPLIER_CODE_PAD);
      try {
        return await SupplierModel.create({
          ...input,
          code,
          // Last word, so the workspace can only ever be the session's.
          tenantId: ctx.tenantId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        });
      } catch (error) {
        if (!this.isDuplicateCode(error)) throw error;
      }
    }
    throw ApiError.internal('Could not allocate a supplier code. Please try again.');
  }

  private isDuplicateCode(error: unknown): boolean {
    const candidate = error as { code?: number; keyPattern?: Record<string, unknown> };
    return candidate?.code === 11000 && Boolean(candidate.keyPattern?.code);
  }

  /**
   * Duplicate protection, kept deliberately narrow: the same NAME together with
   * the same phone or email is almost certainly the same company typed twice.
   * A similar name alone is not - "ABC Garments" and "ABC Garments Ltd." are
   * allowed to be two businesses.
   */
  private async assertNotDuplicate(ctx: TenantContext, input: CreateSupplierInput | UpdateSupplierInput, excludeId?: Types.ObjectId) {
    const name = input.name?.trim();
    if (!name) return;
    const phone = input.phone?.trim() || input.contact?.phone?.trim() || '';
    const email = input.email?.trim() || input.contact?.email?.trim() || '';
    if (!phone && !email) return;

    const signals: Record<string, unknown>[] = [];
    if (phone) signals.push({ phone }, { 'contact.phone': phone });
    if (email) signals.push({ email }, { 'contact.email': email });

    const duplicate = await SupplierModel.findOne({
      ...this.scope(ctx),
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      $or: signals,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
      .select('code name')
      .lean();

    if (duplicate) {
      throw ApiError.conflict(`"${duplicate.name}" is already saved with this phone number or email (${duplicate.code}).`, {
        supplierCode: duplicate.code,
      });
    }
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateSupplierInput, permission: Permission) {
    const supplier = await SupplierModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!supplier) throw ApiError.notFound('Supplier not found');

    await this.assertNotDuplicate(ctx, { ...input, name: input.name ?? supplier.name }, id);

    // Whole-object fields are merged, so a form that posts only the contact
    // block never wipes the address.
    const { contact, address, banking, ...rest } = input;
    if (contact) supplier.set('contact', { ...supplier.contact, ...contact });
    if (address) supplier.set('address', { ...supplier.address, ...address });
    if (banking) supplier.set('banking', { ...supplier.banking, ...banking });
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) supplier.set(key, value);
    }
    supplier.updatedBy = ctx.userId;
    await supplier.save();

    return present(supplier.toObject(), { banking: this.canSeeBanking(ctx, permission) });
  }

  /**
   * Retires a supplier without destroying it: the record stays searchable and
   * any future purchase history keeps pointing at a real supplier. Reactivating
   * has to fit the plan's ceiling, since an inactive supplier frees its slot.
   */
  async setStatus(ctx: TenantContext, id: Types.ObjectId, isActive: boolean) {
    const supplier = await SupplierModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!supplier) throw ApiError.notFound('Supplier not found');
    if (supplier.isActive === isActive) return supplier.toObject();

    if (isActive) {
      const entitlement = await entitlementService.forTenant(ctx.tenantId);
      await entitlementService.assertCanAddSupplier(ctx.tenantId, entitlement);
    }

    supplier.isActive = isActive;
    supplier.updatedBy = ctx.userId;
    await supplier.save();
    return supplier.toObject();
  }

  /**
   * Soft delete, like every other record here: the row stays for history and
   * its code is freed for reuse. Nothing references a supplier yet; when the
   * purchase modules arrive they will read soft-deleted suppliers happily.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const supplier = await SupplierModel.findOneAndUpdate(
      { _id: id, ...this.scope(ctx) },
      { $set: { deletedAt: new Date(), isActive: false, updatedBy: ctx.userId } },
      { new: true },
    )
      .select('code name')
      .lean();
    if (!supplier) throw ApiError.notFound('Supplier not found');
    return { id, code: supplier.code, softDeleted: true };
  }

  /**
   * The counters the page shows: how many suppliers exist and how many the plan
   * allows. Also what tells a downgraded workspace why it cannot add more.
   */
  async summary(ctx: TenantContext) {
    const [entitlement, active, inactive] = await Promise.all([
      entitlementService.forTenant(ctx.tenantId),
      entitlementService.countSuppliers(ctx.tenantId),
      SupplierModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null, isActive: false }),
    ]);
    const max = entitlement.limits?.maxSuppliers ?? 0;
    return {
      active,
      inactive,
      total: active + inactive,
      max: max === -1 ? null : max,
      unlimited: max === -1,
      remaining: max === -1 ? null : Math.max(0, max - active),
      overLimit: max !== -1 && active > max,
      planName: entitlement.planName,
    };
  }
}

export const supplierService = new SupplierService();
