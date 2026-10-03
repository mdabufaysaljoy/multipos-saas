import { z } from 'zod';
import { parseMajorToMinor } from '../../utils/money';
import { buildRegistry, type ColumnRegistry, type ImportColumnSpec } from './sheet.columns';
import type { ParsedRow } from './sheet.parse';
import type { PosVertical } from '../../config/verticals';
import type { TenantContext } from '../../types/express';
import { supershopService } from '../../modules/supershop/supershop.service';
import { pharmacyService } from '../../modules/pharmacy/pharmacy.service';
import { restaurantService } from '../../modules/restaurant/restaurant.service';
import { createProductSchema as createShopProductSchema } from '../../modules/supershop/supershop.validators';
import { maxQuantityFor } from '../../models/shopUnits';
import { createMedicineSchema } from '../../modules/pharmacy/pharmacy.validators';
import { categoryForDosageForm, normalizeDosageForm } from '../../models/Medicine';
import { createMenuItemSchema } from '../../modules/restaurant/restaurant.validators';

/**
 * One row of a file, turned into something a vertical can create.
 *
 * Each adapter answers the same three questions - what columns may the file
 * have, what does one row mean, and how is that created - and nothing else.
 * Everything around it (parsing, the pending job, the preview, the commit loop,
 * the error report) is shared, which is what makes "import" one feature rather
 * than four.
 */
export interface PreparedImportItem {
  /** What the row will create, ready for that vertical's own create schema. */
  payload: Record<string, unknown>;
  /** For the preview and the error report. */
  name: string;
  /** Identity used only to detect duplicates inside this file. Defaults to name. */
  duplicateKey?: string;
  detail: string;
  priceMinor: number;
  /** The category the row names, so the summary can say which are new. */
  categoryName: string;
  rowNumber: number;
  /** Opening stock, when this vertical's import carries it. */
  opening?: { quantity: number; costPriceMinor: number; batchNumber?: string; expiryDate?: string };
}

export interface RowIssue {
  field: string;
  message: string;
}

export interface PosImportAdapter {
  vertical: PosVertical;
  /** What this vertical calls the things being imported. */
  noun: { one: string; many: string };
  registry: ColumnRegistry;
  /** Row -> item, or the reasons it cannot be imported. Nothing is written. */
  prepare(row: ParsedRow): { item: PreparedImportItem | null; issues: RowIssue[] };
  /** Creates it exactly as the manual form does, through that vertical's own service. */
  create(ctx: TenantContext, item: PreparedImportItem): Promise<void>;
}

// ------------------------------------------------------------------ helpers

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'active', 'enabled', 'on', 'available']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'inactive', 'disabled', 'off', 'archived', 'unavailable']);

const text = (row: ParsedRow, field: string): string => (row.values[field] ?? '').trim();

/** Yes/No columns. A blank cell means the default, never "no". */
function flag(raw: string, fallback: boolean): boolean | null {
  if (raw === '') return fallback;
  const value = raw.toLowerCase();
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  return null;
}

/** Money to minor units by string arithmetic - never parseFloat times 100. */
function money(raw: string): number | null {
  const minor = parseMajorToMinor(raw);
  return minor === null || minor < 0 ? null : minor;
}

function wholeNumber(raw: string, max: number): number | null {
  if (raw === '') return 0;
  if (!/^\d{1,9}$/.test(raw.replace(/,/g, ''))) return null;
  const value = Number(raw.replace(/,/g, ''));
  return value <= max ? value : null;
}

/** "15", "15%" or "7.5%" -> basis points. */
function vatRateBps(raw: string): number | null {
  if (raw === '') return 0;
  const cleaned = raw.replace('%', '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(cleaned)) return null;
  const bps = Math.round(Number(cleaned) * 100);
  return bps <= 10_000 ? bps : null;
}

/** The message a vertical's own schema gives, so a file is judged by the same rules as the form. */
function schemaIssues(schema: z.ZodTypeAny, payload: Record<string, unknown>): RowIssue[] {
  const result = schema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ field: String(issue.path[0] ?? 'row'), message: issue.message }));
}

// ---------------------------------------------------------------- Super Shop

const SHOP_COLUMNS: ImportColumnSpec[] = [
  { field: 'name', label: 'Product', required: true, aliases: ['product name', 'name', 'item'], hint: 'The product as the till shows it.' },
  { field: 'price', label: 'Price', required: true, aliases: ['selling price', 'sale price', 'mrp', 'price incl vat'], hint: 'VAT included, per piece or per kilogram.' },
  { field: 'barcode', label: 'Barcode', required: false, aliases: ['ean', 'upc', 'barcode number'], hint: 'Optional, but a scanner needs one. Letters, numbers and - only.' },
  { field: 'category', label: 'Department', required: false, aliases: ['category', 'category name', 'department name'], hint: 'Grouped on the till. Created if it is new.' },
  { field: 'brand', label: 'Brand', required: false, aliases: ['brand name', 'manufacturer'], hint: 'Optional free text.' },
  { field: 'unitType', label: 'Sold by', required: false, aliases: ['unit', 'unit type', 'sold as'], hint: '"Piece" or "Weight". Fixed once created.' },
  { field: 'vatRate', label: 'VAT rate', required: false, aliases: ['vat', 'vat %', 'tax rate'], hint: 'A percentage, e.g. 15 or 7.5. Defaults to 0.' },
  { field: 'reorderLevel', label: 'Reorder level', required: false, aliases: ['low stock', 'low stock threshold', 'reorder'], hint: 'Pieces, or grams for weighed goods. Defaults to 0.' },
  { field: 'stock', label: 'Opening stock', required: false, aliases: ['stock', 'quantity', 'qty'], hint: 'Received into THIS branch as an opening movement. Needs a cost price.' },
  { field: 'costPrice', label: 'Cost price', required: false, aliases: ['cost', 'purchase price', 'buying price'], hint: 'Per piece or per kilogram. Used for the opening stock and for profit.' },
  { field: 'isActive', label: 'Active', required: false, aliases: ['status', 'is active', 'for sale'], hint: 'Yes/No. Defaults to Yes.' },
];

const supershopAdapter: PosImportAdapter = {
  vertical: 'supershop',
  noun: { one: 'product', many: 'products' },
  registry: buildRegistry(SHOP_COLUMNS),
  prepare(row) {
    const issues: RowIssue[] = [];
    const name = text(row, 'name');
    const priceMinor = money(text(row, 'price'));
    const unitRaw = text(row, 'unitType').toLowerCase();
    const unitType = unitRaw === '' ? 'each' : /kg|weight|gram|loose/.test(unitRaw) ? 'weight' : /piece|each|unit|pcs/.test(unitRaw) ? 'each' : null;
    const vat = vatRateBps(text(row, 'vatRate'));
    // Weighed goods count in grams, so the ceiling depends on how the row says
    // the product is sold. An unreadable `unitType` fails the row below anyway.
    const quantityCeiling = maxQuantityFor(unitType ?? 'weight');
    const reorderLevel = wholeNumber(text(row, 'reorderLevel'), quantityCeiling);
    const stock = wholeNumber(text(row, 'stock'), quantityCeiling);
    const costMinor = money(text(row, 'costPrice') || '0');
    const active = flag(text(row, 'isActive'), true);

    if (!name) issues.push({ field: 'name', message: 'A product needs a name' });
    if (priceMinor === null) issues.push({ field: 'price', message: 'Price must be a number like 250 or 250.50' });
    if (unitType === null) issues.push({ field: 'unitType', message: 'Sold by must be "Piece" or "Weight"' });
    if (vat === null) issues.push({ field: 'vatRate', message: 'VAT rate must be a percentage from 0 to 100' });
    if (reorderLevel === null) issues.push({ field: 'reorderLevel', message: 'Reorder level must be a whole number' });
    if (stock === null) issues.push({ field: 'stock', message: 'Opening stock must be a whole number' });
    if (costMinor === null) issues.push({ field: 'costPrice', message: 'Cost price must be a number' });
    if (stock !== null && stock > 0 && (costMinor ?? 0) <= 0) {
      issues.push({ field: 'costPrice', message: 'Opening stock needs a cost price, or the shop cannot report profit' });
    }

    if (issues.length > 0) return { item: null, issues };

    const payload = {
      name,
      brand: text(row, 'brand'),
      category: text(row, 'category') || 'General',
      barcode: text(row, 'barcode'),
      unitType,
      priceMinor: priceMinor!,
      vatRateBps: vat!,
      reorderLevel: reorderLevel!,
      isActive: active!,
    };
    const schema = schemaIssues(createShopProductSchema, payload);
    if (schema.length > 0) return { item: null, issues: schema };

    return {
      item: {
        payload,
        name,
        detail: [payload.brand, payload.category].filter(Boolean).join(' · '),
        priceMinor: priceMinor!,
        categoryName: payload.category,
        rowNumber: row.rowNumber,
        ...(stock! > 0 ? { opening: { quantity: stock!, costPriceMinor: costMinor! } } : {}),
      },
      issues: [],
    };
  },
  async create(ctx, item) {
    const product = await supershopService.createProduct(ctx, createShopProductSchema.parse(item.payload));
    if (item.opening) {
      await supershopService.receiveStock(ctx, product._id, {
        quantity: item.opening.quantity,
        costPriceMinor: item.opening.costPriceMinor,
        supplierName: 'Opening stock',
      });
    }
  },
};

// ------------------------------------------------------------------ Pharmacy

const PHARMACY_COLUMNS: ImportColumnSpec[] = [
  { field: 'name', label: 'Medicine', required: true, aliases: ['brand name', 'name', 'product'], hint: 'The brand as it is dispensed, e.g. Napa.' },
  { field: 'price', label: 'Price', required: true, aliases: ['selling price', 'mrp', 'unit price'], hint: 'Price per unit sold.' },
  { field: 'genericName', label: 'Generic name', required: false, aliases: ['generic', 'molecule'], hint: 'e.g. Paracetamol. Searchable at the till.' },
  { field: 'strength', label: 'Strength', required: false, aliases: ['dose', 'dosage'], hint: 'e.g. 500 mg.' },
  { field: 'dosageForm', label: 'Form', required: true, aliases: ['dosage form', 'type'], hint: 'Any medicine form. A matching category is created automatically.' },
  { field: 'manufacturer', label: 'Manufacturer', required: false, aliases: ['company', 'maker'], hint: 'Optional free text.' },
  { field: 'category', label: 'Category', required: false, aliases: ['category name'], hint: 'Ignored during import. Category is always set from Form.' },
  { field: 'containerType', label: 'Container Type', required: false, aliases: ['container'], hint: 'Bottle, blister, strip, tube, vial, etc.' },
  { field: 'packQuantity', label: 'Pack Quantity', required: false, aliases: ['quantity in pack', 'units per pack', 'pack qty'], hint: 'Whole sellable units in one pack. Blank defaults to 1.' },
  { field: 'packPrice', label: 'Total Pack Price (BDT)', required: false, aliases: ['pack price', 'total pack price'], hint: 'Blank defaults to Price × Pack Quantity. An entered pack price is kept as supplied.' },
  { field: 'packageSize', label: 'Package Size', required: false, aliases: ['pack size'], hint: 'Manufacturer packaging, e.g. 10 x 10 tablets.' },
];

const pharmacyAdapter: PosImportAdapter = {
  vertical: 'pharmacy',
  noun: { one: 'medicine', many: 'medicines' },
  registry: buildRegistry(PHARMACY_COLUMNS),
  prepare(row) {
    const issues: RowIssue[] = [];
    const name = text(row, 'name');
    const priceMinor = money(text(row, 'price'));
    const formRaw = text(row, 'dosageForm');
    const dosageForm = normalizeDosageForm(formRaw);
    const packQuantityRaw = text(row, 'packQuantity');
    const packPriceRaw = text(row, 'packPrice');
    const packQuantity = packQuantityRaw ? wholeNumber(packQuantityRaw, 100_000) : 1;
    const suppliedPackPriceMinor = packPriceRaw ? money(packPriceRaw) : null;

    if (!name) issues.push({ field: 'name', message: 'A medicine needs a name' });
    if (priceMinor === null) issues.push({ field: 'price', message: 'Price must be a number like 12 or 12.50' });
    if (!dosageForm) issues.push({ field: 'dosageForm', message: 'Form is required' });
    if (dosageForm.length > 60) issues.push({ field: 'dosageForm', message: 'Form must be 60 characters or fewer' });
    if (packQuantity === null || packQuantity < 1) issues.push({ field: 'packQuantity', message: 'Pack Quantity must be a whole number of at least 1' });
    if (packPriceRaw && suppliedPackPriceMinor === null) issues.push({ field: 'packPrice', message: 'Total Pack Price must be a number like 120 or 120.50' });
    const calculatedPackPriceMinor = priceMinor !== null && packQuantity !== null ? priceMinor * packQuantity : null;
    if (calculatedPackPriceMinor !== null && !Number.isSafeInteger(calculatedPackPriceMinor)) issues.push({ field: 'packPrice', message: 'The calculated Total Pack Price is too large' });
    const packPriceMinor = packPriceRaw ? suppliedPackPriceMinor : calculatedPackPriceMinor;
    const category = dosageForm ? categoryForDosageForm(dosageForm) : '';

    if (issues.length > 0) return { item: null, issues };

    const payload = {
      name,
      genericName: text(row, 'genericName'),
      strength: text(row, 'strength'),
      dosageForm,
      manufacturer: text(row, 'manufacturer'),
      category,
      containerType: text(row, 'containerType'),
      packageSize: text(row, 'packageSize'),
      barcode: '',
      sellingPriceMinor: priceMinor!,
      packQuantity: packQuantity!,
      packPriceMinor: packPriceMinor!,
      requiresPrescription: false,
      reorderLevel: 0,
      isActive: true,
    };
    const schema = schemaIssues(createMedicineSchema, payload);
    if (schema.length > 0) return { item: null, issues: schema };

    return {
      item: {
        payload,
        name,
        duplicateKey: [name, payload.strength, dosageForm].map((value) => String(value).trim().toLocaleLowerCase('en-US')).join('\u0000'),
        detail: [payload.strength, payload.genericName, payload.manufacturer, `${payload.packQuantity}/pack`].filter(Boolean).join(' · '),
        priceMinor: priceMinor!,
        categoryName: payload.category,
        rowNumber: row.rowNumber,
      },
      issues: [],
    };
  },
  async create(ctx, item) {
    await pharmacyService.createMedicine(ctx, createMedicineSchema.parse(item.payload), { allowIndependentPackPrice: true });
  },
};

// ---------------------------------------------------------------- Restaurant

const RESTAURANT_COLUMNS: ImportColumnSpec[] = [
  { field: 'name', label: 'Dish', required: true, aliases: ['item', 'name', 'menu item', 'product'], hint: 'The dish as the menu shows it.' },
  { field: 'price', label: 'Price', required: true, aliases: ['selling price', 'menu price'], hint: 'What the guest is charged.' },
  { field: 'category', label: 'Section', required: false, aliases: ['category', 'category name', 'course'], hint: 'Grouped on the till, e.g. Mains. Created if it is new.' },
  { field: 'description', label: 'Description', required: false, aliases: ['details'], hint: 'Optional, shown on the till.' },
  { field: 'sortOrder', label: 'Order', required: false, aliases: ['sort order', 'position'], hint: 'Lower comes first within a section.' },
  { field: 'isAvailable', label: 'Available', required: false, aliases: ['status', 'is available', 'active'], hint: 'Yes/No. Defaults to Yes.' },
];

const restaurantAdapter: PosImportAdapter = {
  vertical: 'restaurant',
  noun: { one: 'dish', many: 'dishes' },
  registry: buildRegistry(RESTAURANT_COLUMNS),
  prepare(row) {
    const issues: RowIssue[] = [];
    const name = text(row, 'name');
    const priceMinor = money(text(row, 'price'));
    const sortOrder = wholeNumber(text(row, 'sortOrder'), 10_000);
    const available = flag(text(row, 'isAvailable'), true);

    if (!name) issues.push({ field: 'name', message: 'A dish needs a name' });
    if (priceMinor === null) issues.push({ field: 'price', message: 'Price must be a number like 350 or 350.50' });
    if (sortOrder === null) issues.push({ field: 'sortOrder', message: 'Order must be a whole number' });
    if (available === null) issues.push({ field: 'isAvailable', message: 'Available must be Yes or No' });
    if (issues.length > 0) return { item: null, issues };

    const payload = {
      name,
      category: text(row, 'category') || 'General',
      description: text(row, 'description'),
      priceMinor: priceMinor!,
      isAvailable: available!,
      sortOrder: sortOrder!,
    };
    const schema = schemaIssues(createMenuItemSchema, payload);
    if (schema.length > 0) return { item: null, issues: schema };

    return {
      item: { payload, name, detail: String(payload.category), priceMinor: priceMinor!, categoryName: String(payload.category), rowNumber: row.rowNumber },
      issues: [],
    };
  },
  async create(ctx, item) {
    await restaurantService.createMenuItem(ctx, createMenuItemSchema.parse(item.payload));
  },
};

const ADAPTERS: Partial<Record<PosVertical, PosImportAdapter>> = {
  supershop: supershopAdapter,
  pharmacy: pharmacyAdapter,
  restaurant: restaurantAdapter,
};

/** Null for a vertical that imports through its own module (Clothing) or not at all. */
export const importAdapterFor = (vertical: PosVertical): PosImportAdapter | null => ADAPTERS[vertical] ?? null;
