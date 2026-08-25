import { Types } from 'mongoose';
import { CategoryModel } from '../../models/Category';
import { ProductModel } from '../../models/Product';
import { ApiError } from '../../utils/ApiError';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';
import type { CreateCategoryInput, ListCategoriesInput, UpdateCategoryInput } from './categories.validators';

class CategoryService {
  /** Base filter. Every query starts from here so tenantId is never omitted. */
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };
  }

  async list(ctx: TenantContext, input: ListCategoriesInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (!input.includeInactive) filter.isActive = true;
    if (input.search) filter.name = searchRegex(input.search);

    const [items, total] = await Promise.all([
      CategoryModel.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      CategoryModel.countDocuments(filter),
    ]);

    // Product counts come from an aggregation rather than N queries.
    const counts = await ProductModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null, categoryId: { $in: items.map((c) => c._id) } } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]);
    const countByCategory = new Map(counts.map((c) => [String(c._id), c.count]));

    return {
      items: items.map((category) => ({ ...category, productCount: countByCategory.get(String(category._id)) ?? 0 })),
      page,
      limit,
      total,
    };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    const category = await CategoryModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!category) throw ApiError.notFound('Category not found');
    return category;
  }

  async create(ctx: TenantContext, input: CreateCategoryInput) {
    const slug = slugify(input.name);
    const duplicate = await CategoryModel.findOne({ ...this.scope(ctx), slug }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A category with this name already exists');

    if (input.parentId) await this.assertExists(ctx, input.parentId);

    const category = await CategoryModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      name: input.name,
      slug,
      description: input.description,
      parentId: input.parentId ?? null,
      isActive: input.isActive,
    });
    return category.toObject();
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateCategoryInput) {
    const category = await CategoryModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!category) throw ApiError.notFound('Category not found');

    if (input.name && input.name !== category.name) {
      const slug = slugify(input.name);
      const duplicate = await CategoryModel.findOne({ ...this.scope(ctx), slug, _id: { $ne: id } })
        .select('_id')
        .lean();
      if (duplicate) throw ApiError.conflict('A category with this name already exists');
      category.name = input.name;
      category.slug = slug;
    }

    if (input.parentId !== undefined) {
      if (input.parentId && String(input.parentId) === String(id)) {
        throw ApiError.badRequest('A category cannot be its own parent');
      }
      if (input.parentId) await this.assertExists(ctx, input.parentId);
      category.parentId = input.parentId ?? null;
    }

    if (input.description !== undefined) category.description = input.description;
    if (input.isActive !== undefined) category.isActive = input.isActive;

    await category.save();

    // Products carry a category-name snapshot for historical reporting; refresh
    // it on live products only. Sale items keep the name they were sold under.
    if (input.name) {
      await ProductModel.updateMany(
        { tenantId: ctx.tenantId, storeId: ctx.storeId, categoryId: id },
        { $set: { categoryNameSnapshot: category.name } },
      );
    }

    return category.toObject();
  }

  /**
   * Soft delete. The record stays so historical sales that reference it keep
   * resolving, and its products are simply detached rather than destroyed.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const category = await CategoryModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!category) throw ApiError.notFound('Category not found');

    const productCount = await ProductModel.countDocuments({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      categoryId: id,
      deletedAt: null,
    });

    category.deletedAt = new Date();
    category.isActive = false;
    await category.save();

    // Detach live products but preserve the name they had, so product listings
    // still read sensibly.
    await ProductModel.updateMany(
      { tenantId: ctx.tenantId, storeId: ctx.storeId, categoryId: id, deletedAt: null },
      { $set: { categoryId: null } },
    );

    return { id, detachedProducts: productCount };
  }

  private async assertExists(ctx: TenantContext, id: Types.ObjectId) {
    const exists = await CategoryModel.findOne({ _id: id, ...this.scope(ctx) }).select('_id').lean();
    if (!exists) throw ApiError.badRequest('The selected parent category does not exist');
  }
}

export const categoryService = new CategoryService();
