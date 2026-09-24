import { CategoryModel } from '../../models/Category';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { parseMajorToMinor } from '../../utils/money';
import { slugify } from '../../utils/slug';
import type { TenantContext } from '../../types/express';
import type { ImportField } from './import.columns';
import type { ParsedRow } from './import.parse';

/**
 * Validation: parsed rows in, products ready for the product service out.
 *
 * Every rule here mirrors the rules the manual "New product" form already obeys
 * (`products.validators.ts` and the product/variant schemas). Nothing is
 * written; the caller decides what to do with the result.
 */

export interface ImportRowError {
  rowNumber: number;
  productName: string;
  variantName: string;
  field: ImportField | 'row';
  message: string;
}

export interface PreparedVariant {
  rowNumber: number;
  name: string;
  attributes: { name: string; value: string }[];
  sku?: string;
  barcode: string | null;
  sellingPriceMinor: number;
  costPriceMinor: number;
  stock: number;
  lowStockThreshold: number;
  isActive: boolean;
}

export interface PreparedProduct {
  name: string;
  brand: string;
  description: string;
  categoryName: string;
  isActive: boolean;
  variants: PreparedVariant[];
  /** File rows this product came from, for the summary and error report. */
  rowNumbers: number[];
}

export interface ValidationResult {
  products: PreparedProduct[];
  errors: ImportRowError[];
  totalRows: number;
  validRows: number;
  /** Rows with at least one error. A row can fail several checks at once. */
  invalidRows: number;
  /** Categories named in the file that do not exist in this branch yet. */
  missingCategories: string[];
}

export interface ValidateOptions {
  /** Create categories the file names but the branch does not have yet. */
  createMissingCategories: boolean;
}

const MAX_PRODUCT_NAME = 200;
const MAX_VARIANT_NAME = 160;
const MAX_BRAND = 120;
const MAX_DESCRIPTION = 2000;
const MAX_SKU = 64;
const MAX_BARCODE = 64;
const MAX_ATTRIBUTES = 5;
const MAX_OPTIONS = 3;
const MAX_OPTION_VALUES = 50;
const MAX_ATTRIBUTE_NAME = 40;
const MAX_ATTRIBUTE_VALUE = 60;
const SKU_PATTERN = /^[A-Z0-9._-]+$/;
const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'active', 'enabled', 'on']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'inactive', 'disabled', 'off', 'archived']);

const text = (row: ParsedRow, field: ImportField): string => (row.values[field] ?? '').trim();

/** "Color: Black; Size: M" - exactly what the product export writes. */
function parseAttributes(raw: string): { name: string; value: string }[] | null {
  const segments = raw
    .split(/[;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return [];
  const attributes: { name: string; value: string }[] = [];
  for (const segment of segments) {
    const at = segment.indexOf(':');
    if (at <= 0) return null;
    const name = segment.slice(0, at).trim();
    const value = segment.slice(at + 1).trim();
    if (!name || !value) return null;
    if (name.length > MAX_ATTRIBUTE_NAME || value.length > MAX_ATTRIBUTE_VALUE) return null;
    attributes.push({ name, value });
  }
  return attributes;
}

const parseBoolean = (raw: string): boolean | null => {
  const lower = raw.toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  return null;
};

const parseWholeNumber = (raw: string): number | null => {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
};

export async function validateRows(
  ctx: TenantContext,
  rows: ParsedRow[],
  options: ValidateOptions,
): Promise<ValidationResult> {
  const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };
  const errors: ImportRowError[] = [];

  // ---- one bulk lookup per uniqueness rule, never a query per row ----
  const names = [...new Set(rows.map((row) => text(row, 'productName')).filter(Boolean))];
  const skus = [...new Set(rows.map((row) => text(row, 'sku').toUpperCase()).filter(Boolean))];
  const barcodes = [...new Set(rows.map((row) => text(row, 'barcode')).filter(Boolean))];

  const [existingProducts, existingSkuDocs, existingBaseSkuDocs, existingBarcodeDocs, categories] = await Promise.all([
    names.length
      ? ProductModel.find({ ...scope, name: { $in: names } })
          .select('name')
          .collation({ locale: 'en', strength: 2 })
          .lean()
      : [],
    skus.length ? ProductVariantModel.find({ ...scope, sku: { $in: skus } }).select('sku').lean() : [],
    skus.length ? ProductModel.find({ ...scope, sku: { $in: skus } }).select('sku').lean() : [],
    barcodes.length ? ProductVariantModel.find({ ...scope, barcode: { $in: barcodes } }).select('barcode').lean() : [],
    CategoryModel.find({ ...scope }).select('name slug').lean(),
  ]);

  const takenNames = new Set(existingProducts.map((product) => product.name.trim().toLowerCase()));
  const takenSkus = new Set([...existingSkuDocs, ...existingBaseSkuDocs].map((doc) => doc.sku));
  const takenBarcodes = new Set(existingBarcodeDocs.map((doc) => doc.barcode ?? ''));
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category.name]));

  // ---- row by row ----
  const groups = new Map<string, PreparedProduct>();
  const seenSkus = new Set<string>();
  const seenBarcodes = new Set<string>();
  const missingCategories = new Set<string>();

  for (const row of rows) {
    const productName = text(row, 'productName');
    const variantName = text(row, 'variantName');
    const rowErrors: ImportRowError[] = [];
    const fail = (field: ImportField | 'row', message: string) => rowErrors.push({ rowNumber: row.rowNumber, productName, variantName, field, message });

    // --- the three mandatory fields ---
    if (!productName) fail('productName', 'Product name is required.');
    else if (productName.length > MAX_PRODUCT_NAME) fail('productName', `Product name must be ${MAX_PRODUCT_NAME} characters or fewer.`);
    else if (takenNames.has(productName.toLowerCase())) {
      fail('productName', `A product named "${productName}" already exists in this branch. Import only creates new products.`);
    }

    if (!variantName) fail('variantName', 'Variant is required.');
    else if (variantName.length > MAX_VARIANT_NAME) fail('variantName', `Variant must be ${MAX_VARIANT_NAME} characters or fewer.`);

    const priceRaw = text(row, 'sellingPrice');
    let sellingPriceMinor = 0;
    if (!priceRaw) fail('sellingPrice', 'Selling price is required.');
    else {
      const parsed = parseMajorToMinor(priceRaw);
      if (parsed === null) fail('sellingPrice', `"${priceRaw}" is not a valid price. Use a number such as 990 or 990.50.`);
      else if (parsed < 0) fail('sellingPrice', 'Selling price cannot be negative.');
      else sellingPriceMinor = parsed;
    }

    // --- optional fields ---
    const costRaw = text(row, 'costPrice');
    let costPriceMinor = 0;
    if (costRaw) {
      const parsed = parseMajorToMinor(costRaw);
      if (parsed === null) fail('costPrice', `"${costRaw}" is not a valid cost price.`);
      else if (parsed < 0) fail('costPrice', 'Cost price cannot be negative.');
      else costPriceMinor = parsed;
    }

    const stockRaw = text(row, 'stock');
    let stock = 0;
    if (stockRaw) {
      const parsed = parseWholeNumber(stockRaw);
      if (parsed === null) fail('stock', `"${stockRaw}" is not a valid stock quantity. Use a whole number such as 12.`);
      else stock = parsed;
    }

    const thresholdRaw = text(row, 'lowStockThreshold');
    let lowStockThreshold = 0;
    if (thresholdRaw) {
      const parsed = parseWholeNumber(thresholdRaw);
      if (parsed === null) fail('lowStockThreshold', `"${thresholdRaw}" is not a valid low-stock threshold.`);
      else lowStockThreshold = parsed;
    }

    const skuRaw = text(row, 'sku').toUpperCase();
    if (skuRaw) {
      if (skuRaw.length > MAX_SKU) fail('sku', `SKU must be ${MAX_SKU} characters or fewer.`);
      else if (!SKU_PATTERN.test(skuRaw)) fail('sku', 'SKU may contain letters, numbers, dots, dashes and underscores only.');
      else if (takenSkus.has(skuRaw)) fail('sku', `SKU "${skuRaw}" is already used in this branch.`);
      else if (seenSkus.has(skuRaw)) fail('sku', `SKU "${skuRaw}" appears more than once in this file.`);
    }

    const barcodeRaw = text(row, 'barcode');
    if (barcodeRaw) {
      if (barcodeRaw.length > MAX_BARCODE) fail('barcode', `Barcode must be ${MAX_BARCODE} characters or fewer.`);
      else if (takenBarcodes.has(barcodeRaw)) fail('barcode', `Barcode "${barcodeRaw}" already exists in this branch.`);
      else if (seenBarcodes.has(barcodeRaw)) fail('barcode', `Barcode "${barcodeRaw}" appears more than once in this file.`);
    }

    const attributesRaw = text(row, 'attributes');
    let attributes: { name: string; value: string }[] = [];
    if (attributesRaw) {
      const parsed = parseAttributes(attributesRaw);
      if (parsed === null) fail('attributes', `"${attributesRaw}" is not a valid attribute list. Use "Color: Black; Size: M".`);
      else if (parsed.length > MAX_ATTRIBUTES) fail('attributes', `A variant may have at most ${MAX_ATTRIBUTES} attributes.`);
      else attributes = parsed;
    }

    const brand = text(row, 'brand');
    if (brand.length > MAX_BRAND) fail('brand', `Brand must be ${MAX_BRAND} characters or fewer.`);
    const description = text(row, 'description');
    if (description.length > MAX_DESCRIPTION) fail('description', `Description must be ${MAX_DESCRIPTION} characters or fewer.`);

    const activeRaw = text(row, 'isActive');
    let isActive = true;
    if (activeRaw) {
      const parsed = parseBoolean(activeRaw);
      if (parsed === null) fail('isActive', `"${activeRaw}" is not a valid status. Use Yes or No.`);
      else isActive = parsed;
    }

    const categoryName = text(row, 'category');
    if (categoryName) {
      const slug = slugify(categoryName);
      if (!categoryBySlug.has(slug)) {
        if (options.createMissingCategories) missingCategories.add(categoryName);
        else fail('category', `Category "${categoryName}" does not exist in this branch. Create it first, or tick "create missing categories".`);
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // --- grouping: rows sharing a product name become one product ---
    const key = productName.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { name: productName, brand, description, categoryName, isActive, variants: [], rowNumbers: [] };
      groups.set(key, group);
    } else {
      // The product's own fields come from its FIRST row; a later row that
      // disagrees is an error rather than a silent overwrite.
      const conflict = ([['brand', brand, group.brand], ['category', categoryName, group.categoryName], ['description', description, group.description]] as const).find(
        ([, value, first]) => value !== '' && first !== '' && value !== first,
      );
      if (conflict) {
        errors.push({
          rowNumber: row.rowNumber,
          productName,
          variantName,
          field: conflict[0] as ImportField,
          message: `"${productName}" already has ${conflict[0]} "${conflict[2]}" on an earlier row. Every row of a product must agree.`,
        });
        continue;
      }
      if (!group.brand && brand) group.brand = brand;
      if (!group.description && description) group.description = description;
      if (!group.categoryName && categoryName) group.categoryName = categoryName;
    }

    if (group.variants.some((variant) => variant.name.toLowerCase() === variantName.toLowerCase())) {
      errors.push({ rowNumber: row.rowNumber, productName, variantName, field: 'variantName', message: `"${productName}" already has a variant called "${variantName}" in this file.` });
      continue;
    }

    if (skuRaw) seenSkus.add(skuRaw);
    if (barcodeRaw) seenBarcodes.add(barcodeRaw);

    group.rowNumbers.push(row.rowNumber);
    group.variants.push({
      rowNumber: row.rowNumber,
      name: variantName,
      attributes,
      ...(skuRaw ? { sku: skuRaw } : {}),
      barcode: barcodeRaw || null,
      sellingPriceMinor,
      costPriceMinor,
      stock,
      lowStockThreshold,
      isActive,
    });
  }

  // --- product-level checks that need the whole group ---
  for (const [key, group] of [...groups]) {
    const optionNames = [...new Set(group.variants.flatMap((variant) => variant.attributes.map((attribute) => attribute.name)))];
    if (optionNames.length > MAX_OPTIONS) {
      groups.delete(key);
      for (const variant of group.variants) {
        errors.push({
          rowNumber: variant.rowNumber,
          productName: group.name,
          variantName: variant.name,
          field: 'attributes',
          message: `"${group.name}" uses ${optionNames.length} attribute types. A product may have at most ${MAX_OPTIONS}.`,
        });
      }
      continue;
    }
    const tooManyValues = optionNames.find(
      (name) => new Set(group.variants.flatMap((variant) => variant.attributes.filter((a) => a.name === name).map((a) => a.value))).size > MAX_OPTION_VALUES,
    );
    if (tooManyValues) {
      groups.delete(key);
      for (const variant of group.variants) {
        errors.push({
          rowNumber: variant.rowNumber,
          productName: group.name,
          variantName: variant.name,
          field: 'attributes',
          message: `"${group.name}" has more than ${MAX_OPTION_VALUES} values for "${tooManyValues}".`,
        });
      }
    }
  }

  const products = [...groups.values()];
  return {
    products,
    errors: errors.sort((a, b) => a.rowNumber - b.rowNumber),
    totalRows: rows.length,
    validRows: products.reduce((total, product) => total + product.variants.length, 0),
    invalidRows: new Set(errors.map((error) => error.rowNumber)).size,
    missingCategories: [...missingCategories],
  };
}

/** The product `options` a group implies, in first-seen order. */
export function optionsFor(product: PreparedProduct): { name: string; values: string[] }[] {
  const options = new Map<string, Set<string>>();
  for (const variant of product.variants) {
    for (const attribute of variant.attributes) {
      const values = options.get(attribute.name) ?? new Set<string>();
      values.add(attribute.value);
      options.set(attribute.name, values);
    }
  }
  return [...options].map(([name, values]) => ({ name, values: [...values] }));
}
