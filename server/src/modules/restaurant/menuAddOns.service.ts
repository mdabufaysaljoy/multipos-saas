import type { Types } from 'mongoose';
import { MenuAddOnModel } from '../../models/MenuAddOn';
import { MenuItemModel } from '../../models/MenuItem';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';
import type { CreateAddOnInput, ListAddOnsInput, UpdateAddOnInput } from './restaurant.validators';

/** One entry of the list, with how many live dishes currently offer it. */
export interface MenuAddOnRow {
  id: string;
  name: string;
  slug: string;
  defaultPriceMinor: number;
  isActive: boolean;
  sortOrder: number;
  itemCount: number;
}

/**
 * The workspace's reusable extras: define "Extra cheese" once, then pick it on
 * every dish that offers it.
 *
 * The same discipline as the section list, with one difference
 * that matters: an extra carries a PRICE, and attaching it to a dish copies
 * that price rather than pointing at it. So editing the list changes what the
 * next dish suggests, never what a dish already charges and never a past order.
 * That is deliberate - the same extra is worth different money on different
 * dishes, and a menu edit must not silently reprice the whole kitchen.
 */
class MenuAddOnService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  /** How many live dishes offer each extra, counted by the link and by name. */
  private async counts(ctx: TenantContext) {
    const rows = await MenuItemModel.aggregate<{ _id: string; count: number }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null } },
      { $unwind: '$addOnGroups' },
      { $unwind: '$addOnGroups.options' },
      { $group: { _id: { item: '$_id', name: '$addOnGroups.options.name' } } },
      { $group: { _id: '$_id.name', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map((row) => [slugify(row._id), row.count]));
  }

  async list(ctx: TenantContext, input: ListAddOnsInput): Promise<MenuAddOnRow[]> {
    const [stored, used] = await Promise.all([
      MenuAddOnModel.find(this.scope(ctx)).sort({ sortOrder: 1, name: 1 }).lean(),
      this.counts(ctx),
    ]);
    return stored
      .filter((row) => input.includeInactive || row.isActive)
      .map((row) => ({
        id: String(row._id),
        name: row.name,
        slug: row.slug,
        defaultPriceMinor: row.defaultPriceMinor,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        itemCount: used.get(row.slug) ?? 0,
      }));
  }

  async create(ctx: TenantContext, input: CreateAddOnInput) {
    const slug = slugify(input.name);
    const duplicate = await MenuAddOnModel.findOne({ ...this.scope(ctx), slug }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('An extra with this name already exists');
    const created = await MenuAddOnModel.create({
      tenantId: ctx.tenantId,
      name: input.name,
      slug,
      defaultPriceMinor: input.defaultPriceMinor,
      sortOrder: input.sortOrder,
      createdBy: ctx.userId,
    });
    return created.toObject();
  }

  /**
   * Renaming rewrites the dishes that offer it, so the menu stays consistent.
   * Changing the price does NOT: a dish charges what it charges, and a past
   * order is never touched.
   */
  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateAddOnInput) {
    const row = await MenuAddOnModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!row) throw ApiError.notFound('Extra not found');

    const previous = row.name;
    if (input.name && input.name !== row.name) {
      const slug = slugify(input.name);
      const duplicate = await MenuAddOnModel.findOne({ ...this.scope(ctx), slug, _id: { $ne: id } }).select('_id').lean();
      if (duplicate) throw ApiError.conflict('An extra with this name already exists');
      row.name = input.name;
      row.slug = slug;
    }
    if (input.defaultPriceMinor !== undefined) row.defaultPriceMinor = input.defaultPriceMinor;
    if (input.isActive !== undefined) row.isActive = input.isActive;
    if (input.sortOrder !== undefined) row.sortOrder = input.sortOrder;
    await row.save();

    if (row.name !== previous) {
      await MenuItemModel.updateMany(
        { tenantId: ctx.tenantId, deletedAt: null, 'addOnGroups.options.name': previous },
        { $set: { 'addOnGroups.$[].options.$[option].name': row.name } },
        { arrayFilters: [{ 'option.name': previous }] },
      );
    }
    return row.toObject();
  }

  /** Refused while dishes still offer it: hide it instead, or take it off them first. */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const row = await MenuAddOnModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!row) throw ApiError.notFound('Extra not found');

    const inUse = await MenuItemModel.countDocuments({
      tenantId: ctx.tenantId,
      deletedAt: null,
      'addOnGroups.options.name': row.name,
    });
    if (inUse > 0) {
      throw ApiError.conflict(`${inUse} dish${inUse === 1 ? '' : 'es'} still offer ${row.name}. Take it off them first, or hide it instead.`, {
        reason: 'ADDON_IN_USE',
        itemCount: inUse,
      });
    }

    row.deletedAt = new Date();
    row.isActive = false;
    await row.save();
    return { id: String(row._id) };
  }

  /**
   * Called when a dish is saved: every extra it offers joins the list, so one
   * typed straight onto a dish can be picked on the next one without anybody
   * visiting a management screen. A hidden extra is refused - the owner took it
   * off the menu deliberately.
   *
   * Returns the library id for each name, so the dish can remember where its
   * extras came from.
   */
  async registerUsed(
    ctx: TenantContext,
    options: { name: string; priceMinor: number }[],
  ): Promise<Map<string, Types.ObjectId>> {
    const bySlug = new Map<string, { name: string; priceMinor: number }>();
    for (const option of options) {
      if (option.name) bySlug.set(slugify(option.name), option);
    }
    if (bySlug.size === 0) return new Map();

    const existing = await MenuAddOnModel.find({ ...this.scope(ctx), slug: { $in: [...bySlug.keys()] } }).lean();
    const hidden = existing.find((row) => !row.isActive);
    if (hidden) {
      throw ApiError.badRequest(`${hidden.name} is hidden. Pick another extra, or show it again first.`, { reason: 'ADDON_HIDDEN' });
    }

    const known = new Map(existing.map((row) => [row.slug, row._id]));
    for (const [slug, option] of bySlug) {
      if (known.has(slug)) continue;
      const created = await MenuAddOnModel.findOneAndUpdate(
        { tenantId: ctx.tenantId, slug, deletedAt: null },
        {
          $setOnInsert: {
            tenantId: ctx.tenantId,
            name: option.name,
            slug,
            defaultPriceMinor: option.priceMinor,
            isActive: true,
            sortOrder: 0,
            createdBy: ctx.userId,
            deletedAt: null,
          },
        },
        { upsert: true, new: true },
      ).lean();
      if (created) known.set(slug, created._id);
    }
    return known;
  }
}

export const menuAddOnService = new MenuAddOnService();
