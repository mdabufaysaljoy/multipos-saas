import { z } from 'zod';
import type { Model, Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import { MedicineModel } from '../../models/Medicine';
import { MenuItemModel } from '../../models/MenuItem';
import { PosCategoryModel } from '../../models/PosCategory';
import { ShopProductModel } from '../../models/ShopProduct';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';

/** What the catalogue of one vertical looks like to this service. */
interface CatalogueModel {
  /** The items that carry a category name, e.g. Super Shop products. */
  noun: string;
  model: Model<{ category: string } & Record<string, unknown>>;
}

/**
 * The three catalogues whose items keep the category as a NAME. Clothing is not
 * here: its categories are a store-scoped entity with ids, parents and
 * snapshots, and it keeps its own module (`modules/categories`).
 */
const CATALOGUES: Partial<Record<PosVertical, CatalogueModel>> = {
  supershop: { noun: 'product', model: ShopProductModel as never },
  pharmacy: { noun: 'medicine', model: MedicineModel as never },
  restaurant: { noun: 'menu item', model: MenuItemModel as never },
};

const catalogueFor = (vertical: PosVertical): CatalogueModel => {
  const catalogue = CATALOGUES[vertical];
  if (!catalogue) throw ApiError.badRequest('This POS type does not keep a category list');
  return catalogue;
};

const name = z.string().trim().min(1, 'Give the category a name').max(60);

export const createPosCategorySchema = z.object({ name, sortOrder: z.number().int().min(0).max(1000).optional().default(0) }).strict();
export const updatePosCategorySchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional() })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');
export const listPosCategoriesSchema = z
  .object({ includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true') })
  .strict();

export type CreatePosCategoryInput = z.infer<typeof createPosCategorySchema>;
export type UpdatePosCategoryInput = z.infer<typeof updatePosCategorySchema>;
export type ListPosCategoriesInput = z.infer<typeof listPosCategoriesSchema>;

/** One row of the list, whichever POS asked for it. */
export interface PosCategoryRow {
  /** Null for a name that items use but that was never written down; it can still be renamed. */
  id: string | null;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  /** Live items carrying this name right now. */
  itemCount: number;
}

class PosCategoryService {
  private scope(ctx: TenantContext, vertical: PosVertical) {
    return { tenantId: ctx.tenantId, vertical, deletedAt: null };
  }

  /** How many live items carry each name today. */
  private async counts(ctx: TenantContext, vertical: PosVertical) {
    const { model } = catalogueFor(vertical);
    const rows = await model.aggregate<{ _id: string; count: number }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((row) => [slugify(row._id || 'General'), { name: row._id || 'General', count: row.count }]));
  }

  /**
   * The catalogue: every name written down, plus every name items actually use.
   *
   * The second half is what makes this work on a workspace that has been
   * selling for months without ever managing a category - nothing had to be
   * migrated, and nothing is lost if a row is missing.
   */
  async list(ctx: TenantContext, vertical: PosVertical, input: ListPosCategoriesInput): Promise<PosCategoryRow[]> {
    const [stored, used] = await Promise.all([
      PosCategoryModel.find(this.scope(ctx, vertical)).sort({ sortOrder: 1, name: 1 }).lean(),
      this.counts(ctx, vertical),
    ]);

    const rows: PosCategoryRow[] = stored.map((row) => ({
      id: String(row._id),
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      itemCount: used.get(row.slug)?.count ?? 0,
    }));

    const known = new Set(rows.map((row) => row.slug));
    for (const [slug, entry] of used) {
      if (known.has(slug)) continue;
      rows.push({ id: null, name: entry.name, slug, isActive: true, sortOrder: 0, itemCount: entry.count });
    }

    return rows
      .filter((row) => input.includeInactive || row.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  /** The names a till may filter by: live, in use or not, never the hidden ones. */
  async names(ctx: TenantContext, vertical: PosVertical): Promise<string[]> {
    return (await this.list(ctx, vertical, { includeInactive: false })).map((row) => row.name);
  }

  async create(ctx: TenantContext, vertical: PosVertical, input: CreatePosCategoryInput) {
    catalogueFor(vertical);
    const slug = slugify(input.name);
    const duplicate = await PosCategoryModel.findOne({ ...this.scope(ctx, vertical), slug }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A category with this name already exists');
    const created = await PosCategoryModel.create({ tenantId: ctx.tenantId, vertical, name: input.name, slug, sortOrder: input.sortOrder });
    return created.toObject();
  }

  /**
   * Renaming rewrites every live item that carries the old name, because the
   * name IS the link. Sales keep the name they were sold under: their snapshots
   * are never touched, so last month's report still reads as it did.
   */
  async update(ctx: TenantContext, vertical: PosVertical, id: Types.ObjectId, input: UpdatePosCategoryInput) {
    const { model } = catalogueFor(vertical);
    const category = await PosCategoryModel.findOne({ _id: id, ...this.scope(ctx, vertical) });
    if (!category) throw ApiError.notFound('Category not found');

    const previous = category.name;
    if (input.name && input.name !== category.name) {
      const slug = slugify(input.name);
      const duplicate = await PosCategoryModel.findOne({ ...this.scope(ctx, vertical), slug, _id: { $ne: id } }).select('_id').lean();
      if (duplicate) throw ApiError.conflict('A category with this name already exists');
      category.name = input.name;
      category.slug = slug;
    }
    if (input.isActive !== undefined) category.isActive = input.isActive;
    if (input.sortOrder !== undefined) category.sortOrder = input.sortOrder;
    await category.save();

    if (category.name !== previous) {
      await model.updateMany({ tenantId: ctx.tenantId, deletedAt: null, category: previous }, { $set: { category: category.name } });
    }

    return category.toObject();
  }

  /**
   * Removing a name is refused while items still carry it: there is nothing to
   * detach them to, so the shop must move them first. Hiding (`isActive`) is
   * the way to retire a department that still has stock against it.
   */
  async remove(ctx: TenantContext, vertical: PosVertical, id: Types.ObjectId) {
    const catalogue = catalogueFor(vertical);
    const category = await PosCategoryModel.findOne({ _id: id, ...this.scope(ctx, vertical) });
    if (!category) throw ApiError.notFound('Category not found');

    const inUse = await catalogue.model.countDocuments({ tenantId: ctx.tenantId, deletedAt: null, category: category.name });
    if (inUse > 0) {
      throw ApiError.conflict(`${inUse} ${catalogue.noun}${inUse === 1 ? '' : 's'} still use ${category.name}. Move them first, or hide the category instead.`, {
        reason: 'CATEGORY_IN_USE',
        itemCount: inUse,
      });
    }

    category.deletedAt = new Date();
    category.isActive = false;
    await category.save();
    return { id: String(category._id) };
  }

  /**
   * Called when an item is created or edited: an unknown name is added to the
   * catalogue, so the list always describes what the shop actually sells.
   * A name that exists but is hidden is refused - the till should not be able
   * to put new goods into a department the owner retired.
   */
  async assertUsable(ctx: TenantContext, vertical: PosVertical, categoryName: string) {
    if (!CATALOGUES[vertical] || !categoryName) return;
    const slug = slugify(categoryName);
    const existing = await PosCategoryModel.findOne({ ...this.scope(ctx, vertical), slug }).lean();
    if (existing?.isActive === false) {
      throw ApiError.badRequest(`${existing.name} is hidden. Pick another category, or show it again first.`, { reason: 'CATEGORY_HIDDEN' });
    }
    if (existing) return;
    // First time this name is used: write it down so it can be managed.
    await PosCategoryModel.updateOne(
      { tenantId: ctx.tenantId, vertical, slug, deletedAt: null },
      { $setOnInsert: { tenantId: ctx.tenantId, vertical, slug, name: categoryName, isActive: true, sortOrder: 0, deletedAt: null } },
      { upsert: true },
    ).catch(() => undefined);
  }
}

export const posCategoryService = new PosCategoryService();
