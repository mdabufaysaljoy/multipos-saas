import type { Types } from 'mongoose';
import { MenuItemModel } from '../../models/MenuItem';
import { MenuSubcategoryModel } from '../../models/MenuSubcategory';
import { posCategoryService } from '../../services/catalogue/posCategories.service';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';
import type { CreateSubcategoryInput, ListSubcategoriesInput, UpdateSubcategoryInput } from './restaurant.validators';

/** One row of the list, with how many live dishes actually carry the name. */
export interface MenuSubcategoryRow {
  /** Null for a name dishes use that was never written down; it can still be renamed. */
  id: string | null;
  category: string;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  itemCount: number;
}

/**
 * The subsections of the menu: Pizza -> Italian, Mexican, Naga Hot.
 *
 * Deliberately a mirror of `posCategoryService` one level down, because a
 * restaurant that already knows how sections behave should not have to learn
 * something new for subsections:
 *
 *  - the NAME is the link, so nothing had to be migrated;
 *  - a name dishes already use is in the list whether or not a row exists;
 *  - renaming rewrites the dishes that carry it, and never a past order;
 *  - a name in use cannot be deleted, only hidden.
 *
 * It differs in one way that matters: a subsection belongs to exactly ONE
 * section, so two sections may each have a "Hot" without colliding.
 */
class MenuSubcategoryService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  /** How many live dishes carry each (section, subsection) pair today. */
  private async counts(ctx: TenantContext) {
    const rows = await MenuItemModel.aggregate<{ _id: { category: string; subcategory: string }; count: number }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null, subcategory: { $nin: ['', null] } } },
      { $group: { _id: { category: '$category', subcategory: '$subcategory' }, count: { $sum: 1 } } },
    ]);
    return new Map(
      rows.map((row) => [
        `${slugify(row._id.category || 'General')}/${slugify(row._id.subcategory)}`,
        { category: row._id.category || 'General', name: row._id.subcategory, count: row.count },
      ]),
    );
  }

  async list(ctx: TenantContext, input: ListSubcategoriesInput): Promise<MenuSubcategoryRow[]> {
    const categorySlug = input.category ? slugify(input.category) : null;
    const [stored, used] = await Promise.all([
      MenuSubcategoryModel.find({ ...this.scope(ctx), ...(categorySlug ? { categorySlug } : {}) })
        .sort({ categorySlug: 1, sortOrder: 1, name: 1 })
        .lean(),
      this.counts(ctx),
    ]);

    const rows: MenuSubcategoryRow[] = stored.map((row) => ({
      id: String(row._id),
      category: row.categoryName,
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      itemCount: used.get(`${row.categorySlug}/${row.slug}`)?.count ?? 0,
    }));

    const known = new Set(stored.map((row) => `${row.categorySlug}/${row.slug}`));
    for (const [key, entry] of used) {
      if (known.has(key)) continue;
      if (categorySlug && !key.startsWith(`${categorySlug}/`)) continue;
      rows.push({ id: null, category: entry.category, name: entry.name, slug: key.split('/')[1], isActive: true, sortOrder: 0, itemCount: entry.count });
    }

    return rows
      .filter((row) => input.includeInactive || row.isActive)
      .sort((a, b) => a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async create(ctx: TenantContext, input: CreateSubcategoryInput) {
    // A subsection of a section nobody sells under, or one the owner retired,
    // would be unreachable. Asserting also writes an unknown section down.
    await posCategoryService.assertUsable(ctx, 'restaurant', input.category);

    const categorySlug = slugify(input.category);
    const slug = slugify(input.name);
    const duplicate = await MenuSubcategoryModel.findOne({ ...this.scope(ctx), categorySlug, slug }).select('_id').lean();
    if (duplicate) throw ApiError.conflict(`${input.category} already has a ${input.name} subsection`);

    const created = await MenuSubcategoryModel.create({
      tenantId: ctx.tenantId,
      categoryName: input.category,
      categorySlug,
      name: input.name,
      slug,
      sortOrder: input.sortOrder,
      createdBy: ctx.userId,
    });
    return created.toObject();
  }

  /**
   * Renaming rewrites every live dish that carries the old name within this
   * section. Orders keep the name they were sold under: their snapshots are
   * never touched.
   */
  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateSubcategoryInput) {
    const row = await MenuSubcategoryModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!row) throw ApiError.notFound('Subsection not found');

    const previous = row.name;
    if (input.name && input.name !== row.name) {
      const slug = slugify(input.name);
      const duplicate = await MenuSubcategoryModel.findOne({ ...this.scope(ctx), categorySlug: row.categorySlug, slug, _id: { $ne: id } })
        .select('_id')
        .lean();
      if (duplicate) throw ApiError.conflict(`${row.categoryName} already has a ${input.name} subsection`);
      row.name = input.name;
      row.slug = slug;
    }
    if (input.isActive !== undefined) row.isActive = input.isActive;
    if (input.sortOrder !== undefined) row.sortOrder = input.sortOrder;
    await row.save();

    if (row.name !== previous) {
      await MenuItemModel.updateMany(
        { tenantId: ctx.tenantId, deletedAt: null, category: row.categoryName, subcategory: previous },
        { $set: { subcategory: row.name } },
      );
    }
    return row.toObject();
  }

  /** Refused while dishes still carry it: hide it instead, or move them first. */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const row = await MenuSubcategoryModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!row) throw ApiError.notFound('Subsection not found');

    const inUse = await MenuItemModel.countDocuments({
      tenantId: ctx.tenantId,
      deletedAt: null,
      category: row.categoryName,
      subcategory: row.name,
    });
    if (inUse > 0) {
      throw ApiError.conflict(`${inUse} dish${inUse === 1 ? '' : 'es'} still use ${row.name}. Move them first, or hide the subsection instead.`, {
        reason: 'SUBCATEGORY_IN_USE',
        itemCount: inUse,
      });
    }

    row.deletedAt = new Date();
    row.isActive = false;
    await row.save();
    return { id: String(row._id) };
  }

  /**
   * Called when a dish is saved. An unknown name joins the list so it can be
   * managed; a hidden one is refused, and so is one that belongs to a different
   * section - which is what keeps the hierarchy from going crooked.
   */
  async assertUsable(ctx: TenantContext, categoryName: string, subcategoryName: string) {
    if (!subcategoryName) return;
    const categorySlug = slugify(categoryName || 'General');
    const slug = slugify(subcategoryName);

    const existing = await MenuSubcategoryModel.findOne({ ...this.scope(ctx), categorySlug, slug }).lean();
    if (existing?.isActive === false) {
      throw ApiError.badRequest(`${existing.name} is hidden. Pick another subsection, or show it again first.`, { reason: 'SUBCATEGORY_HIDDEN' });
    }
    if (existing) return;

    // The same name under a DIFFERENT section is a different subsection, and
    // saying so is more useful than silently creating a second one.
    const elsewhere = await MenuSubcategoryModel.findOne({ ...this.scope(ctx), slug, categorySlug: { $ne: categorySlug } }).lean();
    if (elsewhere) {
      throw ApiError.badRequest(`${elsewhere.name} belongs to ${elsewhere.categoryName}, not ${categoryName}.`, { reason: 'SUBCATEGORY_WRONG_CATEGORY' });
    }

    await MenuSubcategoryModel.updateOne(
      { tenantId: ctx.tenantId, categorySlug, slug, deletedAt: null },
      {
        $setOnInsert: {
          tenantId: ctx.tenantId,
          categoryName: categoryName || 'General',
          categorySlug,
          slug,
          name: subcategoryName,
          isActive: true,
          sortOrder: 0,
          createdBy: ctx.userId,
          deletedAt: null,
        },
      },
      { upsert: true },
    ).catch(() => undefined);
  }
}

export const menuSubcategoryService = new MenuSubcategoryService();
