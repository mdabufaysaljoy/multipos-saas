import type { Types } from 'mongoose';
import { z } from 'zod';
import { MedicineModel } from '../../models/Medicine';
import { PharmacyManufacturerModel } from '../../models/PharmacyManufacturer';
import type { TenantContext } from '../../types/express';
import { ApiError } from '../../utils/ApiError';
import { slugify } from '../../utils/slug';

const name = z.string().trim().min(1, 'Give the manufacturer a name').max(120);

export const createPharmacyManufacturerSchema = z
  .object({ name, sortOrder: z.number().int().min(0).max(1000).optional().default(0) })
  .strict();
export const updatePharmacyManufacturerSchema = z
  .object({ name: name.optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional() })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');
export const listPharmacyManufacturersSchema = z
  .object({
    includeInactive: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    search: z.string().trim().max(120).optional(),
  })
  .strict();

export type CreatePharmacyManufacturerInput = z.infer<typeof createPharmacyManufacturerSchema>;
export type UpdatePharmacyManufacturerInput = z.infer<typeof updatePharmacyManufacturerSchema>;
export type ListPharmacyManufacturersInput = z.infer<typeof listPharmacyManufacturersSchema>;

export interface PharmacyManufacturerRow {
  id: string | null;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  medicineCount: number;
}

class PharmacyManufacturerService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, deletedAt: null };
  }

  private async counts(ctx: TenantContext) {
    const rows = await MedicineModel.aggregate<{ _id: string; count: number }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null, manufacturer: { $nin: ['', null] } } },
      { $group: { _id: '$manufacturer', count: { $sum: 1 } } },
    ]);
    return new Map(rows.filter((row) => row._id).map((row) => [slugify(row._id), { name: row._id, count: row.count }]));
  }

  async list(ctx: TenantContext, input: ListPharmacyManufacturersInput): Promise<PharmacyManufacturerRow[]> {
    const [stored, used] = await Promise.all([
      PharmacyManufacturerModel.find(this.scope(ctx)).sort({ sortOrder: 1, name: 1 }).lean(),
      this.counts(ctx),
    ]);
    const rows: PharmacyManufacturerRow[] = stored.map((row) => ({
      id: String(row._id),
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      medicineCount: used.get(row.slug)?.count ?? 0,
    }));
    const known = new Set(rows.map((row) => row.slug));
    for (const [slug, entry] of used) {
      if (!known.has(slug)) rows.push({ id: null, name: entry.name, slug, isActive: true, sortOrder: 0, medicineCount: entry.count });
    }
    const needle = input.search?.toLowerCase();
    return rows
      .filter((row) => (input.includeInactive || row.isActive) && (!needle || row.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async names(ctx: TenantContext) {
    return (await this.list(ctx, { includeInactive: false })).map((row) => row.name);
  }

  async create(ctx: TenantContext, input: CreatePharmacyManufacturerInput) {
    const slug = slugify(input.name);
    if (await PharmacyManufacturerModel.exists({ ...this.scope(ctx), slug })) {
      throw ApiError.conflict('A manufacturer with this name already exists');
    }
    const created = await PharmacyManufacturerModel.create({ tenantId: ctx.tenantId, name: input.name, slug, sortOrder: input.sortOrder });
    return created.toObject();
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdatePharmacyManufacturerInput) {
    const manufacturer = await PharmacyManufacturerModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!manufacturer) throw ApiError.notFound('Manufacturer not found');
    const previous = manufacturer.name;
    if (input.name && input.name !== manufacturer.name) {
      const slug = slugify(input.name);
      if (await PharmacyManufacturerModel.exists({ ...this.scope(ctx), slug, _id: { $ne: id } })) {
        throw ApiError.conflict('A manufacturer with this name already exists');
      }
      manufacturer.name = input.name;
      manufacturer.slug = slug;
    }
    if (input.isActive !== undefined) manufacturer.isActive = input.isActive;
    if (input.sortOrder !== undefined) manufacturer.sortOrder = input.sortOrder;
    await manufacturer.save();
    if (manufacturer.name !== previous) {
      await MedicineModel.updateMany(
        { tenantId: ctx.tenantId, deletedAt: null, manufacturer: previous },
        { $set: { manufacturer: manufacturer.name } },
      );
    }
    return manufacturer.toObject();
  }

  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const manufacturer = await PharmacyManufacturerModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!manufacturer) throw ApiError.notFound('Manufacturer not found');
    const inUse = await MedicineModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null, manufacturer: manufacturer.name });
    if (inUse > 0) {
      throw ApiError.conflict(
        `${inUse} medicine${inUse === 1 ? '' : 's'} still use ${manufacturer.name}. Move them first, or hide the manufacturer instead.`,
        { reason: 'MANUFACTURER_IN_USE', medicineCount: inUse },
      );
    }
    manufacturer.deletedAt = new Date();
    manufacturer.isActive = false;
    await manufacturer.save();
    return { id: String(manufacturer._id) };
  }

  async assertUsable(ctx: TenantContext, manufacturerName: string) {
    if (!manufacturerName?.trim()) return;
    const normalizedName = manufacturerName.trim();
    const slug = slugify(normalizedName);
    const existing = await PharmacyManufacturerModel.findOne({ ...this.scope(ctx), slug }).lean();
    if (existing?.isActive === false) {
      throw ApiError.badRequest(`${existing.name} is hidden. Pick another manufacturer, or show it again first.`, {
        reason: 'MANUFACTURER_HIDDEN',
      });
    }
    if (existing) return;
    await PharmacyManufacturerModel.updateOne(
      { tenantId: ctx.tenantId, slug, deletedAt: null },
      { $setOnInsert: { tenantId: ctx.tenantId, slug, name: normalizedName, isActive: true, sortOrder: 0, deletedAt: null } },
      { upsert: true },
    ).catch(() => undefined);
  }
}

export const pharmacyManufacturerService = new PharmacyManufacturerService();
