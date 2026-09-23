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

export interface ImportColumn {
  field: ImportField;
  /** The header the product export writes. */
  label: string;
  required: boolean;
  /** Accepted headers, normalised (lower case, single spaces). The label is always accepted. */
  aliases: string[];
  hint: string;
}

/** Lower case, trimmed, runs of whitespace collapsed, surrounding quotes dropped. */
export const normalizeHeader = (value: string): string =>
  value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();

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

export const REQUIRED_FIELDS = IMPORT_COLUMNS.filter((column) => column.required).map((column) => column.field);
export const REQUIRED_LABELS = IMPORT_COLUMNS.filter((column) => column.required).map((column) => column.label);

/** header (normalised) -> field. Built once; an alias may not be claimed twice. */
const HEADER_LOOKUP = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  for (const header of [column.label, ...column.aliases]) {
    const key = normalizeHeader(header);
    if (HEADER_LOOKUP.has(key) && HEADER_LOOKUP.get(key) !== column.field) {
      throw new Error(`Ambiguous import header "${header}"`);
    }
    HEADER_LOOKUP.set(key, column.field);
  }
}

/**
 * Columns the export writes that this import deliberately ignores, plus the
 * ownership columns that must never be trusted from a file. Ignored headers do
 * not make a file invalid - a user should be able to upload the sheet they
 * have.
 */
const IGNORED_HEADERS = new Set(
  [
    'product id',
    'productid',
    'variant id',
    'variantid',
    'id',
    '_id',
    'tenant id',
    'tenantid',
    'workspace id',
    'workspaceid',
    'store id',
    'storeid',
    'branch id',
    'account id',
    'category id',
    'categoryid',
    'brand id',
    'supplier id',
    'created',
    'created at',
    'updated',
    'updated at',
  ].map(normalizeHeader),
);

export const isIgnoredHeader = (header: string): boolean => IGNORED_HEADERS.has(normalizeHeader(header));

/** The field a header maps to, or null when it is not one of ours. */
export const fieldForHeader = (header: string): ImportField | null => HEADER_LOOKUP.get(normalizeHeader(header)) ?? null;

/**
 * How many of a row's cells look like import headers. Used to find the header
 * row inside a file that starts with the export's title block.
 */
export const headerScore = (cells: string[]): number => {
  const fields = new Set<ImportField>();
  for (const cell of cells) {
    const field = fieldForHeader(cell);
    if (field) fields.add(field);
  }
  return fields.size;
};
