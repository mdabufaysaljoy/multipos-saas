import { env } from '../../config/env';
import {
  HardwareItemModel,
  type HardwareCategory,
  type HardwareItemDoc,
  type HardwareStatus,
} from '../../models/HardwareItem';
import { HardwarePackageModel, type HardwarePackageDoc, type HardwarePackageLine } from '../../models/HardwarePackage';
import { ApiError } from '../../utils/ApiError';
import { DEFAULT_HARDWARE_ITEMS, DEFAULT_HARDWARE_PACKAGES } from './hardware.defaults';

type ItemRecord = HardwareItemDoc & { _id: unknown };
type PackageRecord = HardwarePackageDoc & { _id: unknown };

export interface HardwareItemInput {
  slug: string;
  name: string;
  category: HardwareCategory;
  summary?: string;
  specs?: string[];
  priceMinor: number;
  imageUrl?: string;
  status?: HardwareStatus;
  sortOrder?: number;
}

export type HardwareItemUpdate = Partial<Omit<HardwareItemInput, 'slug'>>;

export interface HardwarePackageInput {
  slug: string;
  name: string;
  tagline?: string;
  description?: string;
  items: HardwarePackageLine[];
  priceMinor: number;
  imageUrl?: string;
  highlights?: string[];
  bestFor?: string[];
  featured?: boolean;
  status?: HardwareStatus;
  sortOrder?: number;
}

export type HardwarePackageUpdate = Partial<Omit<HardwarePackageInput, 'slug'>>;

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

const presentItem = (item: ItemRecord) => ({
  id: String(item._id),
  slug: item.slug,
  name: item.name,
  category: item.category,
  summary: item.summary,
  specs: item.specs ?? [],
  priceMinor: item.priceMinor,
  imageUrl: item.imageUrl,
  status: item.status,
  sortOrder: item.sortOrder,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

export type PresentedHardwareItem = ReturnType<typeof presentItem>;

/**
 * Resolves a package's parts against the item catalogue.
 *
 * The parts carry no price of their own, so a package can never quote a
 * scanner at one price while the scanner's own card quotes another. A line
 * whose item no longer exists is dropped and reported, rather than being
 * rendered as a blank row on the public page.
 */
function presentPackage(pkg: PackageRecord, itemsBySlug: Map<string, PresentedHardwareItem>) {
  const lines: { itemSlug: string; quantity: number; item: PresentedHardwareItem }[] = [];
  const missingItems: string[] = [];

  for (const line of pkg.items ?? []) {
    const item = itemsBySlug.get(line.itemSlug);
    if (!item) {
      missingItems.push(line.itemSlug);
      continue;
    }
    lines.push({ itemSlug: line.itemSlug, quantity: line.quantity, item });
  }

  const componentsTotalMinor = lines.reduce((total, line) => total + line.item.priceMinor * line.quantity, 0);

  return {
    id: String(pkg._id),
    slug: pkg.slug,
    name: pkg.name,
    tagline: pkg.tagline,
    description: pkg.description,
    priceMinor: pkg.priceMinor,
    imageUrl: pkg.imageUrl,
    highlights: pkg.highlights ?? [],
    bestFor: pkg.bestFor ?? [],
    featured: pkg.featured,
    status: pkg.status,
    sortOrder: pkg.sortOrder,
    lines,
    /** What the same parts cost bought one by one. */
    componentsTotalMinor,
    /** Positive only when the bundle is cheaper than its parts. */
    savingsMinor: Math.max(0, componentsTotalMinor - pkg.priceMinor),
    missingItems,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
  };
}

export type PresentedHardwarePackage = ReturnType<typeof presentPackage>;

class HardwareService {
  /**
   * Inserts the published catalogue the first time this runs.
   *
   * Guarded on BOTH collections being empty, so it seeds a new deployment and
   * never resurrects something an admin deleted. Concurrent callers are safe:
   * the unique slug index makes the second insert a no-op.
   */
  async ensureSeeded(): Promise<boolean> {
    const [items, packages] = await Promise.all([
      HardwareItemModel.estimatedDocumentCount(),
      HardwarePackageModel.estimatedDocumentCount(),
    ]);
    if (items > 0 || packages > 0) return false;

    try {
      await HardwareItemModel.insertMany([...DEFAULT_HARDWARE_ITEMS], { ordered: false });
      await HardwarePackageModel.insertMany(
        DEFAULT_HARDWARE_PACKAGES.map(({ itemSlugs, ...pkg }) => ({
          ...pkg,
          items: itemSlugs.map((itemSlug) => ({ itemSlug, quantity: 1 })),
        })),
        { ordered: false },
      );
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  private async load(filter: { activeOnly: boolean }) {
    await this.ensureSeeded();
    const itemFilter = filter.activeOnly ? { status: 'active' as const } : {};
    const packageFilter = filter.activeOnly ? { status: 'active' as const } : {};
    const [items, packages] = await Promise.all([
      HardwareItemModel.find(itemFilter).sort({ sortOrder: 1, name: 1 }).lean<ItemRecord[]>(),
      HardwarePackageModel.find(packageFilter).sort({ sortOrder: 1, name: 1 }).lean<PackageRecord[]>(),
    ]);
    const presentedItems = items.map(presentItem);
    const bySlug = new Map(presentedItems.map((item) => [item.slug, item]));
    return { items: presentedItems, packages: packages.map((pkg) => presentPackage(pkg, bySlug)) };
  }

  /**
   * What anonymous visitors see: active packages and active items only.
   *
   * A package's parts are resolved from the ACTIVE items, so deactivating an
   * item also withdraws it from the bundles that contain it - the page can
   * never offer a device the platform has stopped selling.
   */
  async publicCatalogue() {
    const { items, packages } = await this.load({ activeOnly: true });
    return { currency: env.DEFAULT_CURRENCY, items, packages };
  }

  /** Everything, active or not, for the platform admin screen. */
  async adminCatalogue() {
    const { items, packages } = await this.load({ activeOnly: false });
    return { currency: env.DEFAULT_CURRENCY, items, packages };
  }

  /** Rejects a package that names a part the catalogue does not have. */
  private async assertItemsExist(lines: HardwarePackageLine[]) {
    if (lines.length === 0) return;
    const slugs = [...new Set(lines.map((line) => line.itemSlug))];
    const found = await HardwareItemModel.find({ slug: { $in: slugs } }).select('slug').lean();
    const known = new Set(found.map((item) => item.slug));
    const unknown = slugs.filter((slug) => !known.has(slug));
    if (unknown.length > 0) throw ApiError.validation('Unknown hardware item', { items: unknown.join(', ') });
  }

  async createItem(input: HardwareItemInput) {
    try {
      const item = await HardwareItemModel.create(input);
      return presentItem(item.toObject() as ItemRecord);
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('A hardware item with this slug already exists', { slug: input.slug });
      throw error;
    }
  }

  async updateItem(slug: string, input: HardwareItemUpdate) {
    const before = await HardwareItemModel.findOne({ slug }).lean<ItemRecord>();
    if (!before) throw ApiError.notFound('Hardware item not found');
    const after = await HardwareItemModel.findOneAndUpdate(
      { slug },
      { $set: input },
      { returnDocument: 'after', runValidators: true },
    ).lean<ItemRecord>();
    if (!after) throw ApiError.notFound('Hardware item not found');
    return { before: presentItem(before), after: presentItem(after) };
  }

  /**
   * Removing an item that a package is built from would leave that package
   * quoting a setup with a hole in it, so it is refused by name. Deactivating
   * is the reversible way to stop selling something.
   */
  async deleteItem(slug: string) {
    const item = await HardwareItemModel.findOne({ slug }).lean<ItemRecord>();
    if (!item) throw ApiError.notFound('Hardware item not found');
    const usedBy = await HardwarePackageModel.find({ 'items.itemSlug': slug }).select('name').lean();
    if (usedBy.length > 0) {
      throw ApiError.conflict(
        `${item.name} is part of ${usedBy.map((pkg) => pkg.name).join(', ')}. Remove it from those packages first, or deactivate it instead.`,
      );
    }
    await HardwareItemModel.deleteOne({ slug });
    return presentItem(item);
  }

  async createPackage(input: HardwarePackageInput) {
    await this.assertItemsExist(input.items);
    try {
      const pkg = await HardwarePackageModel.create(input);
      return (await this.packageDetail(pkg.slug))!;
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('A package with this slug already exists', { slug: input.slug });
      throw error;
    }
  }

  async updatePackage(slug: string, input: HardwarePackageUpdate) {
    if (input.items) await this.assertItemsExist(input.items);
    const before = await this.packageDetail(slug);
    if (!before) throw ApiError.notFound('Package not found');
    const updated = await HardwarePackageModel.findOneAndUpdate(
      { slug },
      { $set: input },
      { returnDocument: 'after', runValidators: true },
    ).lean<PackageRecord>();
    if (!updated) throw ApiError.notFound('Package not found');
    return { before, after: (await this.packageDetail(slug))! };
  }

  async deletePackage(slug: string) {
    const pkg = await this.packageDetail(slug);
    if (!pkg) throw ApiError.notFound('Package not found');
    await HardwarePackageModel.deleteOne({ slug });
    return pkg;
  }

  async packageDetail(slug: string): Promise<PresentedHardwarePackage | null> {
    const pkg = await HardwarePackageModel.findOne({ slug }).lean<PackageRecord>();
    if (!pkg) return null;
    const items = await HardwareItemModel.find().sort({ sortOrder: 1, name: 1 }).lean<ItemRecord[]>();
    const bySlug = new Map(items.map((item) => [item.slug, presentItem(item)]));
    return presentPackage(pkg, bySlug);
  }
}

export const hardwareService = new HardwareService();
