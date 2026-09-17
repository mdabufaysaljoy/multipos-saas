import { DEFAULT_POS_VERTICAL, hasPosModule, type PosVertical } from '../../config/verticals';
import {
  PosProductModel,
  type PosProductConfiguration,
  type PosProductDoc,
  type PosProductIcon,
  type PosProductStatus,
} from '../../models/PosProduct';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';

type DefaultProduct = Pick<PosProductDoc, 'code' | 'name' | 'description' | 'status' | 'icon' | 'configuration'>;

/**
 * The catalog every deployment starts with. All four ship a POS module and
 * start active. Existing deployments keep whatever status an admin set
 * (defaults never overwrite), so a type added later is activated there from
 * the admin panel.
 */
export const DEFAULT_POS_PRODUCTS: readonly DefaultProduct[] = [
  {
    code: 'clothing',
    name: 'Clothing',
    description: 'Fashion and apparel retail with sizes, colours, barcodes, stock and returns.',
    status: 'active',
    icon: 'shirt',
    configuration: { sortOrder: 10, highlights: ['Size and colour variants', 'Barcode labels', 'Exchanges and returns'] },
  },
  {
    code: 'restaurant',
    name: 'Restaurant',
    description: 'Dine-in, takeaway and delivery with tables, kitchen tickets and shift close.',
    status: 'active',
    icon: 'utensils',
    configuration: { sortOrder: 20, highlights: ['Tables and orders', 'Kitchen tickets', 'Shift close reports'] },
  },
  {
    code: 'pharmacy',
    name: 'Pharmacy',
    description: 'Medicine retail with batches, expiry dates, first-expiry-first-out sales and prescriptions.',
    status: 'active',
    icon: 'pill',
    configuration: { sortOrder: 30, highlights: ['Batch and expiry tracking', 'Never sells expired stock', 'Prescription records'] },
  },
  {
    code: 'supershop',
    name: 'Supershop',
    description: 'Grocery and general retail with barcode checkout, goods sold by weight and VAT on every receipt.',
    status: 'active',
    icon: 'shopping-cart',
    configuration: { sortOrder: 40, highlights: ['Barcode scanning', 'Sell by piece or by weight', 'VAT-inclusive pricing'] },
  },
];

type ProductRecord = PosProductDoc & { _id: unknown };

export interface CreatePosProductInput {
  code: string;
  name: string;
  description?: string;
  status?: PosProductStatus;
  icon?: PosProductIcon;
  configuration?: Partial<PosProductConfiguration>;
}

export type UpdatePosProductInput = Partial<Omit<CreatePosProductInput, 'code'>>;

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number })?.code === 11000 ||
  ((error as { writeErrors?: { code?: number }[] })?.writeErrors ?? []).every((e) => e.code === 11000);

/**
 * Inserts any missing default product. Never overwrites one that exists, so an
 * admin's changes (a renamed product, a deactivation) survive restarts and
 * migrations. Safe to run concurrently. Returns how many were created.
 */
export async function ensureDefaultPosProducts(): Promise<number> {
  try {
    const result = await PosProductModel.bulkWrite(
      DEFAULT_POS_PRODUCTS.map((product) => ({
        updateOne: { filter: { code: product.code }, update: { $setOnInsert: product }, upsert: true },
      })),
      { ordered: false },
    );
    return result.upsertedCount;
  } catch (error) {
    // Another process inserted the same default at the same moment.
    if (isDuplicateKey(error)) return 0;
    throw error;
  }
}

/** Workspaces that predate verticals have no value stored and are Clothing. */
const workspaceFilterFor = (code: string) =>
  code === DEFAULT_POS_VERTICAL ? { $or: [{ vertical: code }, { vertical: null }] } : { vertical: code };

function present(product: ProductRecord, workspaceCount: number, planCount = 0) {
  return {
    id: product._id,
    code: product.code,
    name: product.name,
    description: product.description,
    status: product.status,
    icon: product.icon,
    configuration: {
      sortOrder: product.configuration?.sortOrder ?? 100,
      highlights: product.configuration?.highlights ?? [],
    },
    /** A POS module exists in the codebase, so workspaces of this type can run. */
    moduleAvailable: hasPosModule(product.code),
    /** The product new signups and legacy workspaces fall back to; cannot be deactivated. */
    isDefault: product.code === DEFAULT_POS_VERTICAL,
    workspaceCount,
    /** Plans sold only to this POS type. Shared plans are not counted. */
    planCount,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

class PosCatalogService {
  /**
   * The POS type for a NEW workspace, checked against the catalog. The client's
   * value is only a request:
   *   - unknown code         -> 422
   *   - inactive product     -> 400
   *   - no POS module yet    -> 400
   */
  async resolveForNewWorkspace(code: string): Promise<PosVertical> {
    await ensureDefaultPosProducts();
    const product = await PosProductModel.findOne({ code: String(code) }).lean();
    if (!product) throw ApiError.validation('Unknown POS type', { vertical: code });
    if (product.status !== 'active') {
      throw ApiError.badRequest(`${product.name} POS is not offered right now.`, { vertical: code });
    }
    if (!hasPosModule(product.code)) {
      throw ApiError.badRequest(`${product.name} POS is not available yet.`, { vertical: code });
    }
    return product.code;
  }

  /** What a customer may choose from: active products, marked by whether they can be opened today. */
  async customerOptions() {
    await ensureDefaultPosProducts();
    const products = await PosProductModel.find({ status: 'active' }).sort({ 'configuration.sortOrder': 1, name: 1 }).lean();
    return products.map((product) => ({
      vertical: product.code,
      label: product.name,
      description: product.description,
      icon: product.icon,
      highlights: product.configuration?.highlights ?? [],
      available: hasPosModule(product.code),
    }));
  }

  async list() {
    await ensureDefaultPosProducts();
    const [products, counts, planCounts] = await Promise.all([
      PosProductModel.find().sort({ 'configuration.sortOrder': 1, name: 1 }).lean<ProductRecord[]>(),
      TenantModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: { $ifNull: ['$vertical', DEFAULT_POS_VERTICAL] }, count: { $sum: 1 } } },
      ]),
      SubscriptionPlanModel.aggregate<{ _id: string; count: number }>([
        { $match: { posProductCode: { $type: 'string' } } },
        { $group: { _id: '$posProductCode', count: { $sum: 1 } } },
      ]),
    ]);
    const byCode = new Map(counts.map((row) => [row._id, row.count]));
    const plansByCode = new Map(planCounts.map((row) => [row._id, row.count]));
    return products.map((product) => present(product, byCode.get(product.code) ?? 0, plansByCode.get(product.code) ?? 0));
  }

  async detail(code: string) {
    await ensureDefaultPosProducts();
    const product = await PosProductModel.findOne({ code }).lean<ProductRecord>();
    if (!product) throw ApiError.notFound('POS type not found');
    const [workspaceCount, planCount] = await Promise.all([
      TenantModel.countDocuments(workspaceFilterFor(code)),
      SubscriptionPlanModel.countDocuments({ posProductCode: code }),
    ]);
    return present(product, workspaceCount, planCount);
  }

  async create(input: CreatePosProductInput) {
    await ensureDefaultPosProducts();
    try {
      const product = await PosProductModel.create({
        code: input.code,
        name: input.name,
        description: input.description ?? '',
        status: input.status ?? 'inactive',
        icon: input.icon ?? 'store',
        configuration: { sortOrder: input.configuration?.sortOrder ?? 100, highlights: input.configuration?.highlights ?? [] },
      });
      return present(product.toObject() as ProductRecord, 0);
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('A POS type with this code already exists', { code: input.code });
      throw error;
    }
  }

  /** Name, description, icon, status and configuration. The code never changes. */
  async update(code: string, input: UpdatePosProductInput) {
    await ensureDefaultPosProducts();
    const before = await PosProductModel.findOne({ code }).lean<ProductRecord>();
    if (!before) throw ApiError.notFound('POS type not found');
    if (input.status === 'inactive' && code === DEFAULT_POS_VERTICAL) {
      throw ApiError.conflict('The default POS type cannot be deactivated: new signups and older workspaces rely on it.');
    }

    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (input.icon !== undefined) set.icon = input.icon;
    if (input.status !== undefined) set.status = input.status;
    if (input.configuration?.sortOrder !== undefined) set['configuration.sortOrder'] = input.configuration.sortOrder;
    if (input.configuration?.highlights !== undefined) set['configuration.highlights'] = input.configuration.highlights;
    if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');

    const after = await PosProductModel.findOneAndUpdate({ code }, { $set: set }, { new: true, runValidators: true }).lean<ProductRecord>();
    if (!after) throw ApiError.notFound('POS type not found');
    const [workspaceCount, planCount] = await Promise.all([
      TenantModel.countDocuments(workspaceFilterFor(code)),
      SubscriptionPlanModel.countDocuments({ posProductCode: code }),
    ]);
    return { before: present(before, workspaceCount, planCount), after: present(after, workspaceCount, planCount) };
  }
}

export const posCatalogService = new PosCatalogService();
