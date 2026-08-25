import { Types } from 'mongoose';
import { DEFAULT_VARIANT_NAME } from '../../config/constants';
import { CategoryModel } from '../../models/Category';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { SaleModel } from '../../models/Sale';
import { ApiError } from '../../utils/ApiError';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { codeFromName } from '../../utils/slug';
import { withTransaction } from '../../utils/tx';
import { inventoryService } from '../../services/inventory/inventory.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type { TenantContext } from '../../types/express';
import type {
  CreateProductInput,
  ListProductsInput,
  PosSearchInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from './products.validators';

/**
 * EAN-13 check digit: weight the first 12 digits 1,3,1,3... and take the
 * complement of the sum modulo 10.
 */
function eanCheckDigit(body: string): number {
  const sum = body
    .split('')
    .reduce((acc, digit, index) => acc + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** Builds "Black / M" from the variant's attribute pairs. */
const variantLabel = (attributes: { name: string; value: string }[]): string =>
  attributes.length === 0 ? DEFAULT_VARIANT_NAME : attributes.map((a) => a.value).join(' / ');

/** Derives a readable SKU suffix, e.g. BLACK/M -> BLK-M. */
const variantSkuSuffix = (attributes: { name: string; value: string }[], index: number): string =>
  attributes.length === 0
    ? 'STD'
    : attributes.map((a) => codeFromName(a.value, 3)).join('-') || `V${index + 1}`;

class ProductService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };
  }

  async list(ctx: TenantContext, input: ListProductsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (!input.includeInactive) filter.isActive = true;
    if (input.categoryId) filter.categoryId = input.categoryId;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ name: rx }, { sku: rx }, { brand: rx }];
    }

    const sortField = input.sort && ['name', 'createdAt', 'updatedAt', 'sku'].includes(input.sort) ? input.sort : 'createdAt';
    const sort: Record<string, 1 | -1> = { [sortField]: input.order === 'asc' ? 1 : -1 };

    const [items, total] = await Promise.all([
      ProductModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      ProductModel.countDocuments(filter),
    ]);

    const withVariants = await this.attachVariantSummaries(ctx, items);

    // Stock filters apply to the aggregate across a product's variants.
    const filtered = withVariants.filter((product) => {
      if (input.outOfStockOnly) return product.totalStock === 0;
      if (input.lowStockOnly) return product.hasLowStock;
      return true;
    });

    return { items: filtered, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    const product = await ProductModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!product) throw ApiError.notFound('Product not found');

    const variants = await ProductVariantModel.find({
      tenantId: ctx.tenantId,
      productId: id,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    return { ...product, variants };
  }

  /**
   * Creates a product together with its sellable variants. SKUs are generated
   * when omitted and checked for collisions up front, so a partially created
   * product cannot be left behind by a duplicate-key error mid-loop.
   */
  async create(ctx: TenantContext, input: CreateProductInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanAddProduct(ctx.tenantId, entitlement);

    const baseSku = input.sku ?? (await this.generateBaseSku(ctx, input.name));
    const category = await this.resolveCategory(ctx, input.categoryId ?? null);

    const variantDrafts = input.variants.map((variant, index) => ({
      ...variant,
      name: variant.name?.trim() || variantLabel(variant.attributes),
      sku: variant.sku ?? `${baseSku}-${variantSkuSuffix(variant.attributes, index)}`,
    }));

    this.assertNoDuplicateSkusWithin(variantDrafts.map((v) => v.sku));
    await this.assertSkusAvailable(ctx, [baseSku], variantDrafts.map((v) => v.sku));

    // Barcodes: unique within the submission, and unused elsewhere.
    const submittedBarcodes = variantDrafts.map((v) => v.barcode).filter(Boolean) as string[];
    if (new Set(submittedBarcodes).size !== submittedBarcodes.length) {
      throw ApiError.conflict('The same barcode was given to more than one variant');
    }
    for (const barcode of submittedBarcodes) await this.assertBarcodeAvailable(ctx, barcode);

    const productId = new Types.ObjectId();

    const result = await withTransaction(async (session) => {
      const [product] = await ProductModel.create(
        [
          {
            _id: productId,
            tenantId: ctx.tenantId,
            storeId: ctx.storeId,
            name: input.name,
            sku: baseSku,
            categoryId: category?._id ?? null,
            categoryNameSnapshot: category?.name ?? '',
            description: input.description,
            brand: input.brand,
            images: input.images,
            options: input.options,
            hasVariants: input.options.length > 0,
            isActive: input.isActive,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session },
      );

      const variants = await ProductVariantModel.create(
        variantDrafts.map((variant) => ({
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          productId,
          productNameSnapshot: input.name,
          name: variant.name,
          attributes: variant.attributes,
          sku: variant.sku,
          barcode: variant.barcode || null,
          sellingPriceMinor: variant.sellingPriceMinor,
          costPriceMinor: variant.costPriceMinor,
          stock: variant.stock,
          lowStockThreshold: variant.lowStockThreshold,
          isActive: variant.isActive,
        })),
        { session },
      );

      // Opening balances become ledger entries so stock is auditable from day one.
      for (const variant of variants) {
        await inventoryService.recordInitialStock(
          ctx,
          {
            _id: variant._id,
            productId,
            name: variant.name,
            sku: variant.sku,
            productNameSnapshot: variant.productNameSnapshot,
          },
          variant.stock,
          session,
        );
      }

      return { product: product.toObject(), variants: variants.map((v) => v.toObject()) };
    });

    return { ...result.product, variants: result.variants };
  }

  async update(ctx: TenantContext, id: Types.ObjectId, input: UpdateProductInput) {
    const product = await ProductModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!product) throw ApiError.notFound('Product not found');

    if (input.sku && input.sku !== product.sku) {
      await this.assertSkusAvailable(ctx, [input.sku], [], id);
      product.sku = input.sku;
    }

    if (input.categoryId !== undefined) {
      const category = await this.resolveCategory(ctx, input.categoryId ?? null);
      product.categoryId = category?._id ?? null;
      product.categoryNameSnapshot = category?.name ?? '';
    }

    if (input.name !== undefined) product.name = input.name;
    if (input.description !== undefined) product.description = input.description;
    if (input.brand !== undefined) product.brand = input.brand;
    if (input.images !== undefined) product.images = input.images as never;
    if (input.options !== undefined) {
      product.options = input.options as never;
      product.hasVariants = input.options.length > 0;
    }
    if (input.isActive !== undefined) product.isActive = input.isActive;
    product.updatedBy = ctx.userId;

    await product.save();

    // Keep the denormalised name on live variants in step. Sale items are NOT
    // touched - they hold their own snapshot and must never change.
    if (input.name !== undefined) {
      await ProductVariantModel.updateMany(
        { tenantId: ctx.tenantId, productId: id },
        { $set: { productNameSnapshot: input.name } },
      );
    }

    if (input.isActive === false) {
      await ProductVariantModel.updateMany(
        { tenantId: ctx.tenantId, productId: id, deletedAt: null },
        { $set: { isActive: false } },
      );
    }

    return this.getById(ctx, id);
  }

  /**
   * Soft delete. The document is retained so that sales referencing it continue
   * to resolve, and its snapshots on those sales are unaffected either way.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const product = await ProductModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!product) throw ApiError.notFound('Product not found');

    const now = new Date();
    product.deletedAt = now;
    product.isActive = false;
    product.updatedBy = ctx.userId;
    await product.save();

    await ProductVariantModel.updateMany(
      { tenantId: ctx.tenantId, productId: id, deletedAt: null },
      { $set: { deletedAt: now, isActive: false } },
    );

    const soldCount = await SaleModel.countDocuments({ tenantId: ctx.tenantId, 'items.productId': id });

    return {
      id,
      softDeleted: true,
      // Surfaced so the UI can reassure the admin that history is intact.
      historicalSalesPreserved: soldCount,
    };
  }

  async addVariant(ctx: TenantContext, productId: Types.ObjectId, input: VariantInput) {
    const product = await ProductModel.findOne({ _id: productId, ...this.scope(ctx) }).lean();
    if (!product) throw ApiError.notFound('Product not found');

    const existingCount = await ProductVariantModel.countDocuments({ tenantId: ctx.tenantId, productId });
    const name = input.name?.trim() || variantLabel(input.attributes);
    const sku = input.sku ?? `${product.sku}-${variantSkuSuffix(input.attributes, existingCount)}`;

    await this.assertSkusAvailable(ctx, [], [sku]);
    if (input.barcode) await this.assertBarcodeAvailable(ctx, input.barcode);

    const variant = await ProductVariantModel.create({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      productId,
      productNameSnapshot: product.name,
      name,
      attributes: input.attributes,
      sku,
      barcode: input.barcode || null,
      sellingPriceMinor: input.sellingPriceMinor,
      costPriceMinor: input.costPriceMinor,
      stock: input.stock,
      lowStockThreshold: input.lowStockThreshold,
      isActive: input.isActive,
    });

    await inventoryService.recordInitialStock(
      ctx,
      { _id: variant._id, productId, name: variant.name, sku: variant.sku, productNameSnapshot: product.name },
      variant.stock,
    );

    return variant.toObject();
  }

  /** Updates variant details. Stock is intentionally not settable here. */
  async updateVariant(ctx: TenantContext, productId: Types.ObjectId, variantId: Types.ObjectId, input: UpdateVariantInput) {
    const variant = await ProductVariantModel.findOne({
      _id: variantId,
      productId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
    });
    if (!variant) throw ApiError.notFound('Variant not found');

    if (input.sku && input.sku !== variant.sku) {
      await this.assertSkusAvailable(ctx, [], [input.sku], undefined, variantId);
      variant.sku = input.sku;
    }

    if (input.attributes !== undefined) {
      variant.attributes = input.attributes as never;
      if (input.name === undefined) variant.name = variantLabel(input.attributes);
    }
    if (input.name !== undefined) variant.name = input.name.trim() || variantLabel(variant.attributes);
    if (input.barcode !== undefined) {
      if (input.barcode) await this.assertBarcodeAvailable(ctx, input.barcode, variantId);
      variant.barcode = input.barcode || null;
    }
    if (input.sellingPriceMinor !== undefined) variant.sellingPriceMinor = input.sellingPriceMinor;
    if (input.costPriceMinor !== undefined) variant.costPriceMinor = input.costPriceMinor;
    if (input.lowStockThreshold !== undefined) variant.lowStockThreshold = input.lowStockThreshold;
    if (input.isActive !== undefined) variant.isActive = input.isActive;

    await variant.save();
    return variant.toObject();
  }

  async removeVariant(ctx: TenantContext, productId: Types.ObjectId, variantId: Types.ObjectId) {
    const liveCount = await ProductVariantModel.countDocuments({ tenantId: ctx.tenantId, productId, deletedAt: null });
    if (liveCount <= 1) {
      throw ApiError.badRequest('A product must keep at least one variant. Deactivate the product instead.');
    }

    const variant = await ProductVariantModel.findOne({
      _id: variantId,
      productId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    });
    if (!variant) throw ApiError.notFound('Variant not found');

    variant.deletedAt = new Date();
    variant.isActive = false;
    await variant.save();

    return { id: variantId, softDeleted: true };
  }

  /**
   * Flat variant list for the POS search box. Returns sellable units directly,
   * which is what the cashier actually adds to the cart.
   */
  async posSearch(ctx: TenantContext, input: PosSearchInput) {
    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
      isActive: true,
    };

    if (input.q) {
      const rx = searchRegex(input.q);
      // An exact barcode match is the common scanner path; keep it cheap.
      filter.$or = [{ productNameSnapshot: rx }, { name: rx }, { sku: rx }, { barcode: input.q.trim() }];
    }
    if (input.inStockOnly) filter.stock = { $gt: 0 };

    let variants = await ProductVariantModel.find(filter).limit(input.limit).sort({ productNameSnapshot: 1, name: 1 }).lean();

    // Category is a product-level attribute, so filter after the variant query.
    if (input.categoryId) {
      const productIds = await ProductModel.find({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        categoryId: input.categoryId,
        deletedAt: null,
      })
        .select('_id')
        .lean();
      const allowed = new Set(productIds.map((p) => String(p._id)));
      variants = variants.filter((v) => allowed.has(String(v.productId)));
    }

    const products = await ProductModel.find({
      _id: { $in: [...new Set(variants.map((v) => v.productId))] },
      tenantId: ctx.tenantId,
      deletedAt: null,
      isActive: true,
    })
      .select('_id name brand images categoryId categoryNameSnapshot')
      .lean();

    const productById = new Map(products.map((p) => [String(p._id), p]));

    return variants
      .filter((variant) => productById.has(String(variant.productId)))
      .map((variant) => {
        const product = productById.get(String(variant.productId))!;
        return {
          variantId: variant._id,
          productId: variant.productId,
          productName: product.name,
          variantName: variant.name,
          attributes: variant.attributes,
          sku: variant.sku,
          barcode: variant.barcode,
          brand: product.brand,
          categoryId: product.categoryId,
          categoryName: product.categoryNameSnapshot,
          imageUrl: product.images?.find((i) => i.isPrimary)?.url ?? product.images?.[0]?.url ?? null,
          sellingPriceMinor: variant.sellingPriceMinor,
          costPriceMinor: variant.costPriceMinor,
          stock: variant.stock,
          lowStockThreshold: variant.lowStockThreshold,
        };
      });
  }

  // ---------------------------------------------------------------- helpers

  private async attachVariantSummaries(ctx: TenantContext, products: { _id: Types.ObjectId }[]) {
    const ids = products.map((p) => p._id);
    const variants = await ProductVariantModel.find({
      tenantId: ctx.tenantId,
      productId: { $in: ids },
      deletedAt: null,
    })
      .select('productId name sku sellingPriceMinor costPriceMinor stock lowStockThreshold isActive attributes')
      .lean();

    const byProduct = new Map<string, typeof variants>();
    for (const variant of variants) {
      const key = String(variant.productId);
      const bucket = byProduct.get(key);
      if (bucket) bucket.push(variant);
      else byProduct.set(key, [variant]);
    }

    return products.map((product) => {
      const group = byProduct.get(String(product._id)) ?? [];
      const prices = group.map((v) => v.sellingPriceMinor);
      return {
        ...product,
        variants: group,
        variantCount: group.length,
        totalStock: group.reduce((sum, v) => sum + v.stock, 0),
        minPriceMinor: prices.length ? Math.min(...prices) : 0,
        maxPriceMinor: prices.length ? Math.max(...prices) : 0,
        hasLowStock: group.some((v) => v.lowStockThreshold > 0 && v.stock <= v.lowStockThreshold),
      };
    });
  }

  private async resolveCategory(ctx: TenantContext, categoryId: Types.ObjectId | null) {
    if (!categoryId) return null;
    const category = await CategoryModel.findOne({
      _id: categoryId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
    })
      .select('_id name')
      .lean();
    if (!category) throw ApiError.badRequest('The selected category does not exist');
    return category;
  }

  private assertNoDuplicateSkusWithin(skus: string[]) {
    const seen = new Set<string>();
    for (const sku of skus) {
      if (seen.has(sku)) throw ApiError.conflict(`Duplicate SKU "${sku}" in the submitted variants`);
      seen.add(sku);
    }
  }

  /** Pre-flight collision check so we fail before writing anything. */
  private async assertSkusAvailable(
    ctx: TenantContext,
    productSkus: string[],
    variantSkus: string[],
    excludeProductId?: Types.ObjectId,
    excludeVariantId?: Types.ObjectId,
  ) {
    if (productSkus.length) {
      const clash = await ProductModel.findOne({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        deletedAt: null,
        sku: { $in: productSkus },
        ...(excludeProductId ? { _id: { $ne: excludeProductId } } : {}),
      })
        .select('sku')
        .lean();
      if (clash) throw ApiError.conflict(`SKU "${clash.sku}" is already used by another product`);
    }

    if (variantSkus.length) {
      const clash = await ProductVariantModel.findOne({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        deletedAt: null,
        sku: { $in: variantSkus },
        ...(excludeVariantId ? { _id: { $ne: excludeVariantId } } : {}),
      })
        .select('sku')
        .lean();
      if (clash) throw ApiError.conflict(`SKU "${clash.sku}" is already used by another variant`);
    }
  }

  /**
   * Issues a globally unique EAN-13 barcode.
   *
   * Uses a "200" prefix, which GS1 reserves for in-store/restricted circulation
   * codes, so a generated label can never collide with a real manufacturer's
   * product. The 13th digit is a proper EAN-13 check digit, so ordinary
   * retail scanners read it without special configuration.
   */
  async generateBarcode(ctx: TenantContext): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const body = `200${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
      const candidate = `${body}${eanCheckDigit(body)}`;

      const taken = await ProductVariantModel.findOne({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        barcode: candidate,
        deletedAt: null,
      })
        .select('_id')
        .lean();

      if (!taken) return candidate;
    }
    throw ApiError.internal('Could not allocate a unique barcode. Please try again.');
  }

  /** Rejects a barcode already in use by another live variant. */
  private async assertBarcodeAvailable(
    ctx: TenantContext,
    barcode: string,
    excludeVariantId?: Types.ObjectId,
  ): Promise<void> {
    const clash = await ProductVariantModel.findOne({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      barcode,
      deletedAt: null,
      ...(excludeVariantId ? { _id: { $ne: excludeVariantId } } : {}),
    })
      .select('sku productNameSnapshot')
      .lean();

    if (clash) {
      throw ApiError.conflict(
        `Barcode "${barcode}" is already used by ${clash.productNameSnapshot} (${clash.sku})`,
      );
    }
  }

  private async generateBaseSku(ctx: TenantContext, name: string): Promise<string> {
    const base = codeFromName(name, 6);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
      const taken = await ProductModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null, sku: candidate })
        .select('_id')
        .lean();
      if (!taken) return candidate;
    }
    return `${base}-${Date.now().toString(36).toUpperCase()}`;
  }
}

export const productService = new ProductService();
