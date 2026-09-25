import { z } from 'zod';
import type { Types } from 'mongoose';
import { ShopBrandModel } from '../../models/ShopBrand';
import { ShopProductModel } from '../../models/ShopProduct';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';

/**
 * Brands, for Super Shop.
 *
 * Deliberately the same design as `posCategories.service`, because it is the
 * same kind of thing: the product carries the NAME, this is the list of names,
 * and the list is "every name written down, plus every name products actually
 * use". That second half is what lets a workspace that has been typing brands
 * into the product form for months start managing them with no migration and
 * nothing lost.
 *
 * One real difference from a category: a brand is OPTIONAL. A product with no
 * brand is perfectly valid - most of a supershop's shelf is unbranded - so an
 * empty name is never a row, never counted and never refused.
 *
 * Brand is INDEPENDENT of the department a product sells under. Nothing here
 * touches `category`, and the two are filtered separately at the till.
 */

const name = z.string().trim().min(1, 'Give the brand a name').max(80);

export const createShopBrandSchema = z.object({ name, sortOrder: z.number().int().min(0).max(1000).optional().default(0) }).strict();
export const updateShopBrandSchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional() })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');
export const listShopBrandsSchema = z
  .object({
    includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    search: z.string().trim().max(80).optional(),
  })
  .strict();

export type CreateShopBrandInput = z.infer<typeof createShopBrandSchema>;
export type UpdateShopBrandInput = z.infer<typeof updateShopBrandSchema>;
export type ListShopBrandsInput = z.infer<typeof listShopBrandsSchema>;

/** One row of the brand list. */
export interface ShopBrandRow {
  /** Null for a name products use that was never written down; it can still be renamed. */
  id: string | null;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  /** Live products carrying this brand right now. */
  productCount: number;
}

class ShopBrandService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  /** How many live products carry each brand today. Unbranded goods are not a brand. */
  private async counts(ctx: TenantContext) {
    const rows = await ShopProductModel.aggregate<{ _id: string; count: number }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null, brand: { $nin: ['', null] } } },
      { $group: { _id: '$brand', count: { $sum: 1 } } },
    ]);
    return new Map(rows.filter((row) => row._id).map((row) => [slugify(row._id), { name: row._id, count: row.count }]));
  }

  async list(ctx: TenantContext, input: ListShopBrandsInput): Promise<ShopBrandRow[]> {
    const [stored, used] = await Promise.all([
      ShopBrandModel.find(this.scope(ctx)).sort({ sortOrder: 1, name: 1 }).lean(),
      this.counts(ctx),
    ]);

    const rows: ShopBrandRow[] = stored.map((row) => ({
      id: String(row._id),
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      productCount: used.get(row.slug)?.count ?? 0,
    }));

    const known = new Set(rows.map((row) => row.slug));
    for (const [slug, entry] of used) {
      if (known.has(slug)) continue;
      rows.push({ id: null, name: entry.name, slug, isActive: true, sortOrder: 0, productCount: entry.count });
    }

    const needle = input.search?.toLowerCase();
    return rows
      .filter((row) => (input.includeInactive || row.isActive) && (!needle || row.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  /** The names a till may filter by: live, in use or not, never the hidden ones. */
  async names(ctx: TenantContext): Promise<string[]> {
    return (await this.list(ctx, { includeInactive: false })).map((row) => row.name);
  }

  async create(ctx: TenantContext, input: CreateShopBrandInput) {
    const slug = slugify(input.name);
    const duplicate = await ShopBrandModel.findOne({ ...this.scope(ctx), slug }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A brand with this name already exists');
    const created = await ShopBrandModel.create({ tenantId: ctx.tenantId, name: input.name, slug, sortOrder: input.sortOrder });
    return created.toObject();
  }

  /**
   * Renaming rewrites every live product carrying the old name, because the
   * name IS the link. Sales keep the brand they were sold under: their
   * snapshots are never touched, so last month's report reads as it did.
   */
  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateShopBrandInput) {
    const brand = await ShopBrandModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!brand) throw ApiError.notFound('Brand not found');

    const previous = brand.name;
    if (input.name && input.name !== brand.name) {
      const slug = slugify(input.name);
      const duplicate = await ShopBrandModel.findOne({ ...this.scope(ctx), slug, _id: { $ne: id } }).select('_id').lean();
      if (duplicate) throw ApiError.conflict('A brand with this name already exists');
      brand.name = input.name;
      brand.slug = slug;
    }
    if (input.isActive !== undefined) brand.isActive = input.isActive;
    if (input.sortOrder !== undefined) brand.sortOrder = input.sortOrder;
    await brand.save();

    if (brand.name !== previous) {
      await ShopProductModel.updateMany({ tenantId: ctx.tenantId, deletedAt: null, brand: previous }, { $set: { brand: brand.name } });
    }

    return brand.toObject();
  }

  /**
   * Removing a brand is refused while products still carry it: there is nothing
   * to detach them to, so the shop must move them first. Hiding (`isActive`) is
   * how a brand that is still on the shelf is retired.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const brand = await ShopBrandModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!brand) throw ApiError.notFound('Brand not found');

    const inUse = await ShopProductModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null, brand: brand.name });
    if (inUse > 0) {
      throw ApiError.conflict(`${inUse} product${inUse === 1 ? '' : 's'} still carry ${brand.name}. Move them first, or hide the brand instead.`, {
        reason: 'BRAND_IN_USE',
        productCount: inUse,
      });
    }

    brand.deletedAt = new Date();
    brand.isActive = false;
    await brand.save();
    return { id: String(brand._id) };
  }

  /**
   * Called when a product is created or edited: an unknown brand joins the list,
   * so it always describes what the shop actually sells. A brand that exists but
   * is hidden is refused - new goods should not go under a brand the owner
   * retired. No brand at all is not a brand, and is always allowed.
   */
  async assertUsable(ctx: TenantContext, brandName: string) {
    if (!brandName || !brandName.trim()) return;
    const slug = slugify(brandName);
    const existing = await ShopBrandModel.findOne({ ...this.scope(ctx), slug }).lean();
    if (existing?.isActive === false) {
      throw ApiError.badRequest(`${existing.name} is hidden. Pick another brand, or show it again first.`, { reason: 'BRAND_HIDDEN' });
    }
    if (existing) return;
    // First time this name is used: write it down so it can be managed.
    await ShopBrandModel.updateOne(
      { tenantId: ctx.tenantId, slug, deletedAt: null },
      { $setOnInsert: { tenantId: ctx.tenantId, slug, name: brandName.trim(), isActive: true, sortOrder: 0, deletedAt: null } },
      { upsert: true },
    ).catch(() => undefined);
  }
}

export const shopBrandService = new ShopBrandService();
