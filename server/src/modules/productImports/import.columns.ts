import type { ImportColumnSpec } from '../../services/import/sheet.columns';

/**
 * The import column contract.
 *
 * Every field here exists because the PRODUCT EXPORT already writes it
 * (`export.datasets.ts` → VARIANT_COLUMNS), so a file downloaded from Data
 * export can be edited and uploaded back without renaming a single column. The
 * extra aliases are the obvious synonyms a hand-made sheet uses; nothing is
 * guessed by similarity, because "Price", "Cost price" and "Selling price" must
 * never be confused with one another.
 */
export type ImportField =
  | 'productName'
  | 'variantName'
  | 'sellingPrice'
  | 'costPrice'
  | 'sku'
  | 'barcode'
  | 'category'
  | 'brand'
  | 'attributes'
  | 'stock'
  | 'lowStockThreshold'
  | 'description'
  | 'isActive';

/** Clothing's own registry entry; the shape is the shared one. */
export type ImportColumn = ImportColumnSpec<ImportField>;

export { normalizeHeader } from '../../services/import/sheet.columns';

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'productName',
    label: 'Product',
    required: true,
    aliases: ['product name', 'product title', 'name'],
    hint: 'Rows with the same product name become one product with several variants.',
  },
  {
    field: 'variantName',
    label: 'Variant',
    required: true,
    aliases: ['variant name', 'variation'],
    hint: 'The sellable option, e.g. "Black / M". Use "Default" for a product sold as one item.',
  },
  {
    field: 'sellingPrice',
    label: 'Selling price',
    required: true,
    aliases: ['price', 'selling price', 'sale price', 'mrp'],
    hint: 'A number, e.g. 990 or 990.50. No currency symbol.',
  },
  { field: 'costPrice', label: 'Cost price', required: false, aliases: ['cost', 'purchase price', 'buying price'], hint: 'Optional. Defaults to 0.' },
  { field: 'sku', label: 'SKU', required: false, aliases: ['sku code', 'item code'], hint: 'Optional. Generated when blank.' },
  { field: 'barcode', label: 'Barcode', required: false, aliases: ['ean', 'upc', 'barcode number'], hint: 'Optional. Left blank when blank - generate one later from the product page.' },
  { field: 'category', label: 'Category', required: false, aliases: ['category name'], hint: 'Must already exist in this branch, unless you tick "create missing categories".' },
  { field: 'brand', label: 'Brand', required: false, aliases: ['brand name', 'manufacturer'], hint: 'Optional free text.' },
  {
    field: 'attributes',
    label: 'Attributes',
    required: false,
    aliases: ['variant attributes', 'options'],
    hint: 'The export format: "Color: Black; Size: M". Blank is fine - the variant name is then used as it stands.',
  },
  { field: 'stock', label: 'Stock', required: false, aliases: ['quantity', 'qty', 'opening stock'], hint: 'Whole number. Recorded as an opening-stock movement.' },
  { field: 'lowStockThreshold', label: 'Low stock threshold', required: false, aliases: ['low stock', 'reorder level'], hint: 'Optional. Defaults to 0.' },
  { field: 'description', label: 'Description', required: false, aliases: ['product description'], hint: 'Optional product description.' },
  { field: 'isActive', label: 'Active', required: false, aliases: ['status', 'is active'], hint: 'Yes/No (or Active/Inactive). Defaults to Yes.' },
];
