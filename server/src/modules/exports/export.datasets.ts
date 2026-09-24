import type { PipelineStage, Types } from 'mongoose';
import { CategoryModel } from '../../models/Category';
import { CustomerModel } from '../../models/Customer';
import { InventoryTransactionModel } from '../../models/InventoryTransaction';
import { LoyaltyMembershipModel } from '../../models/LoyaltyMembership';
import { LoyaltyTransactionModel } from '../../models/LoyaltyTransaction';
import { ProductVariantModel } from '../../models/ProductVariant';
import { SupplierModel } from '../../models/Supplier';
import { ReturnModel } from '../../models/Return';
import { SaleModel } from '../../models/Sale';
import { PERMISSIONS } from '../../config/permissions';
import type { FeatureEntitlementKey } from '../../config/entitlements';
import type { Permission } from '../../config/permissions';
import type { TenantContext } from '../../types/express';
import { reportService } from '../reports/reports.service';
import type { ReportRangeInput } from '../reports/reports.validators';

/**
 * The export registry: the ONLY data the export API can produce.
 *
 * Every dataset names its own collection, its own filter (always scoped by the
 * authenticated tenant and branch) and its own columns. Nothing about the query
 * comes from the request, so a client can never ask for an arbitrary
 * collection, document or field - see docs/DATA_EXPORT.md.
 *
 * Rows are produced from a Mongo cursor so a large export never loads the whole
 * collection into memory.
 */
export type ExportColumnType = 'text' | 'number' | 'money' | 'date' | 'boolean';

export interface ExportColumn {
  key: string;
  label: string;
  type: ExportColumnType;
}

export interface ExportSection {
  key: string;
  label: string;
  columns: ExportColumn[];
  rows: () => AsyncIterable<Record<string, unknown>>;
}

export interface DatasetScope {
  ctx: TenantContext;
  /** `{ storeId }` for a branch, `{}` for a tenant admin exporting every branch. */
  storeFilter: Record<string, unknown>;
  range: { from: Date; to: Date; label: string } | null;
  report: ReportRangeInput;
}

export interface ExportDataset {
  key: string;
  label: string;
  description: string;
  /** Whether the date range applies (static lists such as inventory ignore it). */
  dated: boolean;
  /**
   * What a caller needs BEYOND the export gate itself.
   *
   * Data export is one permission (`reports.export`); some of the data behind
   * it is its own feature with its own permission. A dataset that names them
   * here is hidden from the catalogue and refused by the download for anyone
   * who could not open that screen in the first place - so export can never
   * become a side door into data the user is not allowed to see.
   */
  requires?: { entitlement?: FeatureEntitlementKey; permission?: Permission };
  sections: (scope: DatasetScope) => Promise<ExportSection[]>;
}

/**
 * A lean or aggregated document. Each mapper below reads only the fields its
 * own projection asked for, defensively; a precise type per pipeline would add
 * no safety here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeanDoc = Record<string, any>;

const BATCH = 500;

/** The wording the Suppliers screen uses, so an export reads the same way. */
const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  manufacturer: 'Manufacturer',
  wholesaler: 'Wholesaler',
  distributor: 'Distributor',
  importer: 'Importer',
  local: 'Local supplier',
  other: 'Other',
};

const PAYMENT_TERM_LABELS: Record<string, string> = {
  cash: 'Cash',
  on_delivery: 'Due on delivery',
  net_7: '7 days',
  net_15: '15 days',
  net_30: '30 days',
  net_60: '60 days',
  other: 'Other',
};

/** Streams a query with a cursor, in batches; never materialises the collection. */
async function* cursorRows<T>(
  build: () => { cursor: (options: { batchSize: number }) => AsyncIterable<T> },
  map: (document: T) => Record<string, unknown> | Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for await (const document of build().cursor({ batchSize: BATCH })) {
    const mapped = map(document);
    if (Array.isArray(mapped)) {
      for (const row of mapped) yield row;
    } else {
      yield mapped;
    }
  }
}

const dateFilter = (field: string, scope: DatasetScope) =>
  scope.range ? { [field]: { $gte: scope.range.from, $lte: scope.range.to } } : {};

const base = (scope: DatasetScope) => ({ tenantId: scope.ctx.tenantId, ...scope.storeFilter });

const attributesLabel = (attributes: { name: string; value: string }[] | undefined) =>
  (attributes ?? []).map((attribute) => `${attribute.name}: ${attribute.value}`).join('; ');

const single = (key: string, label: string, columns: ExportColumn[], rows: () => AsyncIterable<Record<string, unknown>>): ExportSection[] => [
  { key, label, columns, rows },
];

/** A `$lookup` of the parent product, used by the catalogue and stock datasets. */
const withProduct: PipelineStage[] = [
  { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
  { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
];

const variantRow = (document: LeanDoc) => ({
  productId: String(document.productId ?? ''),
  productName: document.product?.name ?? document.productNameSnapshot ?? '',
  brand: document.product?.brand ?? '',
  category: document.product?.categoryNameSnapshot ?? '',
  variantId: String(document._id),
  variantName: document.name ?? '',
  attributes: attributesLabel(document.attributes),
  sku: document.sku ?? '',
  barcode: document.barcode ?? '',
  costPriceMinor: document.costPriceMinor ?? 0,
  sellingPriceMinor: document.sellingPriceMinor ?? 0,
  stock: document.stock ?? 0,
  lowStockThreshold: document.lowStockThreshold ?? 0,
  isActive: document.isActive !== false,
});

const VARIANT_COLUMNS: ExportColumn[] = [
  { key: 'productName', label: 'Product', type: 'text' },
  { key: 'brand', label: 'Brand', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'variantName', label: 'Variant', type: 'text' },
  { key: 'attributes', label: 'Attributes', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'costPriceMinor', label: 'Cost price', type: 'money' },
  { key: 'sellingPriceMinor', label: 'Selling price', type: 'money' },
  { key: 'stock', label: 'Stock', type: 'number' },
  { key: 'isActive', label: 'Active', type: 'boolean' },
];

export const EXPORT_DATASETS: ExportDataset[] = [
  {
    key: 'customers',
    label: 'Customers',
    description: 'Customer directory with purchase totals.',
    dated: true,
    sections: async (scope) =>
      single(
        'customers',
        'Customers',
        [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'phone', label: 'Phone', type: 'text' },
          { key: 'email', label: 'Email', type: 'text' },
          { key: 'address', label: 'Address', type: 'text' },
          { key: 'orderCount', label: 'Orders', type: 'number' },
          { key: 'totalSpentMinor', label: 'Total spent', type: 'money' },
          { key: 'lastPurchaseAt', label: 'Last purchase', type: 'date' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              CustomerModel.find({ ...base(scope), deletedAt: null, ...dateFilter('createdAt', scope) })
                .select('name phone email address orderCount totalSpentMinor lastPurchaseAt isActive createdAt')
                .sort({ createdAt: -1 })
                .lean(),
            (customer) => ({ ...customer, _id: undefined, customerId: String(customer._id) }),
          ),
      ),
  },
  {
    key: 'products',
    label: 'Products & variants',
    description: 'One row per sellable variant, with prices and stock.',
    dated: true,
    sections: async (scope) =>
      single('products', 'Products', VARIANT_COLUMNS, () =>
        cursorRows(
          () =>
            ProductVariantModel.aggregate([
              { $match: { ...base(scope), deletedAt: null, ...dateFilter('createdAt', scope) } },
              ...withProduct,
              { $sort: { 'product.name': 1, name: 1 } },
            ]),
          variantRow,
        ),
      ),
  },
  {
    key: 'categories',
    label: 'Categories',
    description: 'Product categories.',
    dated: true,
    sections: async (scope) =>
      single(
        'categories',
        'Categories',
        [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'description', label: 'Description', type: 'text' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              CategoryModel.find({ ...base(scope), deletedAt: null, ...dateFilter('createdAt', scope) })
                .select('name description isActive createdAt')
                .sort({ name: 1 })
                .lean(),
            (category) => ({ ...category, _id: undefined }),
          ),
      ),
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    // A contact book is a snapshot, like inventory: exporting "this month's
    // suppliers" would be a surprising way to lose the older ones.
    description: 'Every supplier contact, with terms and tax details. Banking details are never exported.',
    dated: false,
    // Suppliers are their own Professional/Enterprise feature with their own
    // permission; holding `reports.export` alone is not enough.
    requires: { entitlement: 'supplierManagement', permission: PERMISSIONS.SUPPLIERS_VIEW },
    sections: async (scope) =>
      single(
        'suppliers',
        'Suppliers',
        [
          { key: 'code', label: 'Supplier code', type: 'text' },
          { key: 'name', label: 'Supplier', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'contactName', label: 'Contact person', type: 'text' },
          { key: 'contactDesignation', label: 'Designation', type: 'text' },
          { key: 'contactPhone', label: 'Contact phone', type: 'text' },
          { key: 'contactAltPhone', label: 'Alternative phone', type: 'text' },
          { key: 'contactEmail', label: 'Contact email', type: 'text' },
          { key: 'phone', label: 'Business phone', type: 'text' },
          { key: 'email', label: 'Business email', type: 'text' },
          { key: 'website', label: 'Website', type: 'text' },
          { key: 'addressLine1', label: 'Address line 1', type: 'text' },
          { key: 'addressLine2', label: 'Address line 2', type: 'text' },
          { key: 'area', label: 'Area', type: 'text' },
          { key: 'city', label: 'City', type: 'text' },
          { key: 'district', label: 'District', type: 'text' },
          { key: 'division', label: 'Division', type: 'text' },
          { key: 'postalCode', label: 'Postal code', type: 'text' },
          { key: 'country', label: 'Country', type: 'text' },
          { key: 'taxNumber', label: 'Tax / VAT number', type: 'text' },
          { key: 'tradeLicense', label: 'Trade licence', type: 'text' },
          { key: 'paymentTerms', label: 'Payment terms', type: 'text' },
          { key: 'paymentTermsNote', label: 'Payment terms note', type: 'text' },
          { key: 'notes', label: 'Notes', type: 'text' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Added', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              // Workspace-level: suppliers carry no branch, so the branch
              // filter does not apply to them (see docs/SUPPLIER_MANAGEMENT.md).
              SupplierModel.find({ tenantId: scope.ctx.tenantId, deletedAt: null })
                // Banking is deliberately absent from the projection: an export
                // file travels, and account numbers should not travel with it.
                .select('code name type contact phone email website address taxNumber tradeLicense paymentTerms paymentTermsNote notes isActive createdAt')
                .sort({ name: 1 })
                .lean(),
            (supplier: LeanDoc) => ({
              code: supplier.code ?? '',
              name: supplier.name ?? '',
              type: SUPPLIER_TYPE_LABELS[supplier.type as string] ?? supplier.type ?? '',
              contactName: supplier.contact?.name ?? '',
              contactDesignation: supplier.contact?.designation ?? '',
              contactPhone: supplier.contact?.phone ?? '',
              contactAltPhone: supplier.contact?.altPhone ?? '',
              contactEmail: supplier.contact?.email ?? '',
              phone: supplier.phone ?? '',
              email: supplier.email ?? '',
              website: supplier.website ?? '',
              addressLine1: supplier.address?.line1 ?? '',
              addressLine2: supplier.address?.line2 ?? '',
              area: supplier.address?.area ?? '',
              city: supplier.address?.city ?? '',
              district: supplier.address?.district ?? '',
              division: supplier.address?.division ?? '',
              postalCode: supplier.address?.postalCode ?? '',
              country: supplier.address?.country ?? '',
              taxNumber: supplier.taxNumber ?? '',
              tradeLicense: supplier.tradeLicense ?? '',
              paymentTerms: PAYMENT_TERM_LABELS[supplier.paymentTerms as string] ?? supplier.paymentTerms ?? '',
              paymentTermsNote: supplier.paymentTermsNote ?? '',
              notes: supplier.notes ?? '',
              isActive: supplier.isActive !== false,
              createdAt: supplier.createdAt ?? null,
            }),
          ),
      ),
  },
  {
    key: 'inventory',
    label: 'Inventory (current stock)',
    description: 'Stock on hand per variant, with stock value.',
    dated: false,
    sections: async (scope) =>
      single(
        'inventory',
        'Inventory',
        [
          ...VARIANT_COLUMNS.filter((column) => column.key !== 'isActive'),
          { key: 'stockValueMinor', label: 'Stock value (cost)', type: 'money' },
          { key: 'retailValueMinor', label: 'Stock value (retail)', type: 'money' },
          { key: 'lowStockThreshold', label: 'Low-stock threshold', type: 'number' },
        ],
        () =>
          cursorRows(
            () =>
              ProductVariantModel.aggregate([
                { $match: { ...base(scope), deletedAt: null } },
                ...withProduct,
                { $sort: { 'product.name': 1, name: 1 } },
              ]),
            (document: LeanDoc) => {
              const row = variantRow(document);
              const stock = Math.max(0, Number(row.stock));
              return { ...row, stockValueMinor: stock * Number(row.costPriceMinor), retailValueMinor: stock * Number(row.sellingPriceMinor) };
            },
          ),
      ),
  },
  {
    key: 'stock-movements',
    label: 'Stock movements',
    description: 'The inventory ledger: every stock change with its reason.',
    dated: true,
    sections: async (scope) =>
      single(
        'stock-movements',
        'Stock movements',
        [
          { key: 'createdAt', label: 'Date', type: 'date' },
          { key: 'productNameSnapshot', label: 'Product', type: 'text' },
          { key: 'variantNameSnapshot', label: 'Variant', type: 'text' },
          { key: 'skuSnapshot', label: 'SKU', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'quantityChange', label: 'Change', type: 'number' },
          { key: 'previousStock', label: 'Stock before', type: 'number' },
          { key: 'newStock', label: 'Stock after', type: 'number' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'referenceNumber', label: 'Reference', type: 'text' },
          { key: 'performedByNameSnapshot', label: 'By', type: 'text' },
        ],
        () =>
          cursorRows(
            () =>
              InventoryTransactionModel.find({ ...base(scope), ...dateFilter('createdAt', scope) })
                .select('createdAt productNameSnapshot variantNameSnapshot skuSnapshot type quantityChange previousStock newStock reason referenceNumber performedByNameSnapshot')
                .sort({ createdAt: -1 })
                .lean(),
            (movement) => ({ ...movement, _id: undefined }),
          ),
      ),
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'One row per sale: totals, payment, customer and cashier.',
    dated: true,
    sections: async (scope) =>
      single(
        'sales',
        'Sales',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'cashier', label: 'Cashier', type: 'text' },
          { key: 'customerName', label: 'Customer', type: 'text' },
          { key: 'customerPhone', label: 'Customer phone', type: 'text' },
          { key: 'itemCount', label: 'Items', type: 'number' },
          { key: 'subtotalMinor', label: 'Subtotal', type: 'money' },
          { key: 'discountMinor', label: 'Discount', type: 'money' },
          { key: 'taxMinor', label: 'VAT', type: 'money' },
          { key: 'totalMinor', label: 'Total', type: 'money' },
          { key: 'paidMinor', label: 'Paid', type: 'money' },
          { key: 'changeMinor', label: 'Change', type: 'money' },
          { key: 'paymentMethod', label: 'Payment method', type: 'text' },
          { key: 'payments', label: 'Payments', type: 'text' },
          { key: 'paymentStatus', label: 'Payment status', type: 'text' },
          { key: 'returnedTotalMinor', label: 'Returned value', type: 'money' },
          { key: 'loyaltyCard', label: 'Loyalty card', type: 'text' },
          { key: 'loyaltyPointsRedeemed', label: 'Points redeemed', type: 'number' },
          { key: 'loyaltyPointsEarned', label: 'Points earned', type: 'number' },
          { key: 'exchangeReturnNumber', label: 'Exchange for return', type: 'text' },
        ],
        () =>
          cursorRows(
            () => SaleModel.find({ ...base(scope), ...dateFilter('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
            (sale: LeanDoc) => ({
              saleNumber: sale.saleNumber,
              soldAt: sale.soldAt,
              status: sale.status,
              cashier: sale.cashierNameSnapshot ?? '',
              customerName: sale.customerSnapshot?.name ?? '',
              customerPhone: sale.customerSnapshot?.phone ?? '',
              itemCount: (sale.items ?? []).reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0),
              subtotalMinor: sale.subtotalMinor,
              discountMinor: sale.discountMinor,
              taxMinor: sale.taxMinor,
              totalMinor: sale.totalMinor,
              paidMinor: sale.paidMinor,
              changeMinor: sale.changeMinor,
              paymentMethod: sale.paymentMethod,
              payments: (sale.payments ?? []).map((payment: { method: string; amountMinor: number }) => `${payment.method} ${(payment.amountMinor / 100).toFixed(2)}`).join('; '),
              paymentStatus: sale.paymentStatus,
              returnedTotalMinor: sale.returnedTotalMinor ?? 0,
              loyaltyCard: sale.loyalty?.cardNumber ?? '',
              loyaltyPointsRedeemed: sale.loyalty?.pointsRedeemed ?? 0,
              loyaltyPointsEarned: sale.loyalty?.pointsEarned ?? 0,
              exchangeReturnNumber: sale.exchange?.returnNumber ?? '',
            }),
          ),
      ),
  },
  {
    key: 'sale-items',
    label: 'Sale items',
    description: 'One row per sold line, with SKU, quantity and price.',
    dated: true,
    sections: async (scope) =>
      single(
        'sale-items',
        'Sale items',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'status', label: 'Sale status', type: 'text' },
          { key: 'productName', label: 'Product', type: 'text' },
          { key: 'variantName', label: 'Variant', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'category', label: 'Category', type: 'text' },
          { key: 'quantity', label: 'Quantity', type: 'number' },
          { key: 'unitPriceMinor', label: 'Unit price', type: 'money' },
          { key: 'listPriceMinor', label: 'List price', type: 'money' },
          { key: 'lineDiscountMinor', label: 'Line discount', type: 'money' },
          { key: 'lineTotalMinor', label: 'Line total', type: 'money' },
          { key: 'returnedQuantity', label: 'Returned qty', type: 'number' },
        ],
        () =>
          cursorRows(
            () => SaleModel.find({ ...base(scope), ...dateFilter('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
            (sale: LeanDoc) =>
              (sale.items ?? []).map((item: LeanDoc) => ({
                saleNumber: sale.saleNumber,
                soldAt: sale.soldAt,
                status: sale.status,
                productName: item.productNameSnapshot,
                variantName: item.variantNameSnapshot,
                sku: item.skuSnapshot,
                category: item.categoryNameSnapshot,
                quantity: item.quantity,
                unitPriceMinor: item.unitPriceMinor,
                listPriceMinor: item.listPriceMinor,
                lineDiscountMinor: item.lineDiscountMinor ?? 0,
                lineTotalMinor: item.lineTotalMinor,
                returnedQuantity: item.returnedQuantity ?? 0,
              })),
          ),
      ),
  },
  {
    key: 'sale-payments',
    label: 'Sale payments',
    description: 'One row per tender taken on a sale (split payments included).',
    dated: true,
    sections: async (scope) =>
      single(
        'sale-payments',
        'Sale payments',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'method', label: 'Method', type: 'text' },
          { key: 'amountMinor', label: 'Amount', type: 'money' },
          { key: 'reference', label: 'Reference', type: 'text' },
          { key: 'paymentStatus', label: 'Status', type: 'text' },
        ],
        () =>
          cursorRows(
            () => SaleModel.find({ ...base(scope), ...dateFilter('soldAt', scope) }).select('saleNumber soldAt payments paymentStatus paymentMethod totalMinor').sort({ soldAt: -1 }).lean(),
            (sale: LeanDoc) => {
              const payments = (sale.payments ?? []).length
                ? sale.payments
                : [{ method: sale.paymentMethod, amountMinor: sale.totalMinor, reference: '' }];
              return payments.map((payment: LeanDoc) => ({
                saleNumber: sale.saleNumber,
                soldAt: sale.soldAt,
                method: payment.method,
                amountMinor: payment.amountMinor,
                reference: payment.reference ?? '',
                paymentStatus: sale.paymentStatus,
              }));
            },
          ),
      ),
  },
  {
    key: 'returns',
    label: 'Returns & exchanges',
    description: 'Returned lines, including the replacement sale of an exchange.',
    dated: true,
    sections: async (scope) =>
      single(
        'returns',
        'Returns',
        [
          { key: 'returnNumber', label: 'Return no.', type: 'text' },
          { key: 'returnedAt', label: 'Date', type: 'date' },
          { key: 'saleNumber', label: 'Original invoice', type: 'text' },
          { key: 'customerName', label: 'Customer', type: 'text' },
          { key: 'productName', label: 'Product', type: 'text' },
          { key: 'variantName', label: 'Variant', type: 'text' },
          { key: 'sku', label: 'SKU', type: 'text' },
          { key: 'quantity', label: 'Quantity', type: 'number' },
          { key: 'unitPriceMinor', label: 'Unit price', type: 'money' },
          { key: 'lineTotalMinor', label: 'Line total', type: 'money' },
          { key: 'restock', label: 'Restocked', type: 'boolean' },
          { key: 'refundMethod', label: 'Refund method', type: 'text' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'exchangeSaleNumber', label: 'Replacement invoice', type: 'text' },
          { key: 'processedBy', label: 'Processed by', type: 'text' },
        ],
        () =>
          cursorRows(
            () => ReturnModel.find({ ...base(scope), ...dateFilter('returnedAt', scope) }).sort({ returnedAt: -1 }).lean(),
            (doc: LeanDoc) =>
              (doc.items ?? []).map((item: LeanDoc) => ({
                returnNumber: doc.returnNumber,
                returnedAt: doc.returnedAt,
                saleNumber: doc.saleNumberSnapshot,
                customerName: doc.customerSnapshot?.name ?? '',
                productName: item.productNameSnapshot,
                variantName: item.variantNameSnapshot,
                sku: item.skuSnapshot,
                quantity: item.quantity,
                unitPriceMinor: item.unitPriceMinor,
                lineTotalMinor: item.lineTotalMinor,
                restock: item.restock !== false,
                refundMethod: doc.refundMethod,
                reason: doc.reason ?? '',
                exchangeSaleNumber: doc.exchange?.saleNumber ?? '',
                processedBy: doc.processedByNameSnapshot ?? '',
              })),
          ),
      ),
  },
  {
    key: 'loyalty-members',
    label: 'Loyalty members',
    description: 'Membership cards with their point balances.',
    dated: true,
    sections: async (scope) =>
      single(
        'loyalty-members',
        'Loyalty members',
        [
          { key: 'cardNumber', label: 'Card ID', type: 'text' },
          { key: 'barcode', label: 'Card barcode', type: 'text' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'customerName', label: 'Customer', type: 'text' },
          { key: 'customerPhone', label: 'Phone', type: 'text' },
          { key: 'pointsBalance', label: 'Points', type: 'number' },
          { key: 'pointsEarnedTotal', label: 'Points earned', type: 'number' },
          { key: 'pointsRedeemedTotal', label: 'Points redeemed', type: 'number' },
          { key: 'membershipFeeMinor', label: 'Membership fee', type: 'money' },
          { key: 'issuedAt', label: 'Issued', type: 'date' },
          { key: 'issuedBy', label: 'Issued by', type: 'text' },
        ],
        () =>
          cursorRows(
            () =>
              LoyaltyMembershipModel.aggregate([
                { $match: { ...base(scope), ...dateFilter('issuedAt', scope) } },
                { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
                { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
                { $sort: { issuedAt: -1 } },
              ]),
            (membership: LeanDoc) => ({
              cardNumber: membership.cardNumber,
              barcode: membership.barcode,
              status: membership.status,
              customerName: membership.customer?.name ?? '',
              customerPhone: membership.customer?.phone ?? '',
              pointsBalance: membership.pointsBalance ?? 0,
              pointsEarnedTotal: membership.pointsEarnedTotal ?? 0,
              pointsRedeemedTotal: membership.pointsRedeemedTotal ?? 0,
              membershipFeeMinor: membership.membershipFeeMinor ?? 0,
              issuedAt: membership.issuedAt,
              issuedBy: membership.issuedByNameSnapshot ?? '',
            }),
          ),
      ),
  },
  {
    key: 'loyalty-ledger',
    label: 'Loyalty point ledger',
    description: 'Every point movement, with the sale or return behind it.',
    dated: true,
    sections: async (scope) =>
      single(
        'loyalty-ledger',
        'Loyalty ledger',
        [
          { key: 'createdAt', label: 'Date', type: 'date' },
          { key: 'cardNumber', label: 'Card ID', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'points', label: 'Points', type: 'number' },
          { key: 'balanceBefore', label: 'Balance before', type: 'number' },
          { key: 'balanceAfter', label: 'Balance after', type: 'number' },
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'returnNumber', label: 'Return no.', type: 'text' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'performedBy', label: 'By', type: 'text' },
        ],
        () =>
          cursorRows(
            () =>
              LoyaltyTransactionModel.aggregate([
                { $match: { ...base(scope), ...dateFilter('createdAt', scope) } },
                { $lookup: { from: 'loyaltymemberships', localField: 'membershipId', foreignField: '_id', as: 'membership' } },
                { $unwind: { path: '$membership', preserveNullAndEmptyArrays: true } },
                { $sort: { createdAt: -1 } },
              ]),
            (entry: LeanDoc) => ({
              createdAt: entry.createdAt,
              cardNumber: entry.membership?.cardNumber ?? '',
              type: entry.type,
              points: entry.points,
              balanceBefore: entry.balanceBefore,
              balanceAfter: entry.balanceAfter,
              saleNumber: entry.saleNumber ?? '',
              returnNumber: entry.returnNumber ?? '',
              reason: entry.reason ?? '',
              performedBy: entry.performedByNameSnapshot ?? '',
            }),
          ),
      ),
  },
  {
    key: 'sales-report',
    label: 'Sales report',
    description: 'The sales & profit report for the period, with a daily breakdown.',
    dated: true,
    sections: async (scope) => {
      // The authoritative report calculation, reused - not a second implementation.
      const analytics = await reportService.salesAnalytics(scope.ctx, scope.report);
      const money = (value: number) => value;
      const summary: Record<string, unknown>[] = [
        { metric: 'Gross sales', valueMinor: money(analytics.grossSalesMinor) },
        { metric: 'Discounts', valueMinor: money(analytics.discountsMinor) },
        { metric: 'Returns', valueMinor: money(analytics.returnAmountMinor) },
        { metric: 'VAT', valueMinor: money(analytics.taxMinor) },
        { metric: 'Net sales', valueMinor: money(analytics.netSalesMinor) },
        { metric: 'Cost of goods sold', valueMinor: money(analytics.cogsMinor) },
        { metric: 'Net profit', valueMinor: money(analytics.netProfitMinor) },
        { metric: 'Average order value', valueMinor: money(analytics.averageOrderValueMinor) },
      ];
      const counts: Record<string, unknown>[] = [
        { metric: 'Invoices', count: analytics.invoiceCount },
        { metric: 'Items sold', count: analytics.itemCount },
        { metric: 'Returns', count: analytics.returnCount },
        { metric: 'Margin %', count: analytics.marginBasisPoints / 100 },
      ];
      return [
        {
          key: 'summary',
          label: 'Summary',
          columns: [
            { key: 'metric', label: 'Metric', type: 'text' },
            { key: 'valueMinor', label: 'Amount', type: 'money' },
          ],
          rows: async function* () {
            for (const row of summary) yield row;
          },
        },
        {
          key: 'counts',
          label: 'Counts',
          columns: [
            { key: 'metric', label: 'Metric', type: 'text' },
            { key: 'count', label: 'Value', type: 'number' },
          ],
          rows: async function* () {
            for (const row of counts) yield row;
          },
        },
        {
          key: 'daily',
          label: 'Daily',
          columns: [
            { key: 'bucket', label: 'Date', type: 'text' },
            { key: 'orderCount', label: 'Invoices', type: 'number' },
            { key: 'itemCount', label: 'Items', type: 'number' },
            { key: 'totalMinor', label: 'Sales', type: 'money' },
          ],
          rows: async function* () {
            for (const row of analytics.trend) yield row as unknown as Record<string, unknown>;
          },
        },
      ];
    },
  },
];

export const findDataset = (key: string): ExportDataset | undefined => EXPORT_DATASETS.find((dataset) => dataset.key === key);

export const EXPORT_TYPES = EXPORT_DATASETS.map((dataset) => dataset.key) as [string, ...string[]];

export type ExportScopeIds = { tenantId: Types.ObjectId; storeId: Types.ObjectId };
