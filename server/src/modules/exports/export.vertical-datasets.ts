import { PERMISSIONS } from '../../config/permissions';
import { DiningTableModel } from '../../models/DiningTable';
import { MedicineModel } from '../../models/Medicine';
import { MedicineBatchModel } from '../../models/MedicineBatch';
import { MenuItemModel } from '../../models/MenuItem';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { PharmacyStockMovementModel } from '../../models/PharmacyStockMovement';
import { PosCategoryModel } from '../../models/PosCategory';
import { RestaurantOrderModel } from '../../models/RestaurantOrder';
import { RestaurantShiftModel } from '../../models/RestaurantShift';
import { ShopBrandModel } from '../../models/ShopBrand';
import { ShopProductModel } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { ShopStockModel } from '../../models/ShopStock';
import { ShopStockMovementModel } from '../../models/ShopStockMovement';
import type { ExportColumn, ExportDataset, ExportSection, DatasetScope } from './export.datasets';

// Every query in this file is selected by the authenticated workspace's
// vertical. Dataset keys intentionally match Clothing where the business
// concept matches, so clients can say "sales" without knowing model names.
type LeanDoc = Record<string, unknown>;
const BATCH = 500;

// The cursor is typed as `unknown` on purpose. Mongoose 9's Query carries a
// full Document type that no longer satisfies an index signature, and this
// helper only ever streams rows through `map`, which reads them as plain
// objects. Naming the document type at every call site would buy nothing.
async function* cursorRows(
  build: () => { cursor: (options: { batchSize: number }) => AsyncIterable<unknown> },
  map: (document: LeanDoc) => Record<string, unknown> | Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for await (const document of build().cursor({ batchSize: BATCH })) {
    const mapped = map(document as LeanDoc);
    if (Array.isArray(mapped)) {
      for (const row of mapped) yield row;
    } else {
      yield mapped;
    }
  }
}

const base = (scope: DatasetScope) => ({ tenantId: scope.ctx.tenantId, ...scope.storeFilter });
const dated = (field: string, scope: DatasetScope) =>
  scope.range ? { [field]: { $gte: scope.range.from, $lte: scope.range.to } } : {};
const single = (key: string, label: string, columns: ExportColumn[], rows: () => AsyncIterable<Record<string, unknown>>): ExportSection[] => [
  { key, label, columns, rows },
];
const paymentsLabel = (payments: unknown) =>
  (Array.isArray(payments) ? payments : [])
    .map((payment: { method?: string; methodLabel?: string; amountMinor?: number }) =>
      `${payment.methodLabel || payment.method || ''} ${(Number(payment.amountMinor ?? 0) / 100).toFixed(2)}`.trim(),
    )
    .join('; ');

const CATALOGUE_PERMISSION = { permission: PERMISSIONS.PRODUCTS_VIEW } as const;
const CATEGORY_PERMISSION = { permission: PERMISSIONS.CATEGORIES_VIEW } as const;
const INVENTORY_PERMISSION = { permission: PERMISSIONS.INVENTORY_VIEW } as const;
const SALES_PERMISSION = { permission: PERMISSIONS.SALES_VIEW } as const;

const posCategories = (vertical: 'restaurant' | 'pharmacy' | 'supershop'): ExportDataset => ({
  key: 'categories',
  label: vertical === 'supershop' ? 'Departments' : 'Categories',
  description: `The ${vertical === 'supershop' ? 'department' : 'category'} list used by this catalogue.`,
  dated: true,
  verticals: [vertical],
  requires: CATEGORY_PERMISSION,
  sections: async (scope) =>
    single(
      'categories',
      vertical === 'supershop' ? 'Departments' : 'Categories',
      [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'isActive', label: 'Active', type: 'boolean' },
        { key: 'sortOrder', label: 'Sort order', type: 'number' },
        { key: 'createdAt', label: 'Created', type: 'date' },
      ],
      () =>
        cursorRows(
          () =>
            PosCategoryModel.find({ tenantId: scope.ctx.tenantId, vertical, deletedAt: null, ...dated('createdAt', scope) })
              .select('name isActive sortOrder createdAt')
              .sort({ sortOrder: 1, name: 1 })
              .lean(),
          (category) => category,
        ),
    ),
});

const saleColumns: ExportColumn[] = [
  { key: 'saleNumber', label: 'Invoice', type: 'text' },
  { key: 'soldAt', label: 'Date', type: 'date' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'cashier', label: 'Cashier', type: 'text' },
  { key: 'customer', label: 'Customer', type: 'text' },
  { key: 'itemCount', label: 'Items', type: 'number' },
  { key: 'subtotalMinor', label: 'Subtotal', type: 'money' },
  { key: 'discountMinor', label: 'Discount', type: 'money' },
  { key: 'totalMinor', label: 'Total', type: 'money' },
  { key: 'paidMinor', label: 'Paid', type: 'money' },
  { key: 'changeMinor', label: 'Change', type: 'money' },
  { key: 'payments', label: 'Payments', type: 'text' },
  { key: 'returnedTotalMinor', label: 'Returned value', type: 'money' },
  { key: 'note', label: 'Note', type: 'text' },
];

const paymentColumns: ExportColumn[] = [
  { key: 'saleNumber', label: 'Invoice', type: 'text' },
  { key: 'soldAt', label: 'Date', type: 'date' },
  { key: 'method', label: 'Method', type: 'text' },
  { key: 'amountMinor', label: 'Amount', type: 'money' },
  { key: 'status', label: 'Sale status', type: 'text' },
];

const restaurantDatasets: ExportDataset[] = [
  {
    key: 'products',
    label: 'Menu items',
    description: 'The complete menu with category, price and availability.',
    dated: true,
    verticals: ['restaurant'],
    requires: CATALOGUE_PERMISSION,
    sections: async (scope) =>
      single(
        'menu-items',
        'Menu items',
        [
          { key: 'name', label: 'Item', type: 'text' },
          { key: 'category', label: 'Category', type: 'text' },
          { key: 'description', label: 'Description', type: 'text' },
          { key: 'priceMinor', label: 'Price', type: 'money' },
          { key: 'isAvailable', label: 'Available', type: 'boolean' },
          { key: 'sortOrder', label: 'Sort order', type: 'number' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              MenuItemModel.find({ tenantId: scope.ctx.tenantId, deletedAt: null, ...dated('createdAt', scope) })
                .select('name category description priceMinor isAvailable sortOrder createdAt')
                .sort({ category: 1, sortOrder: 1, name: 1 })
                .lean(),
            (item) => item,
          ),
      ),
  },
  posCategories('restaurant'),
  {
    key: 'tables',
    label: 'Dining tables',
    description: 'Dining-room tables and seating capacity.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'tables',
        'Dining tables',
        [
          { key: 'name', label: 'Table', type: 'text' },
          { key: 'seats', label: 'Seats', type: 'number' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () => DiningTableModel.find({ ...base(scope), deletedAt: null, ...dated('createdAt', scope) }).select('name seats isActive createdAt').sort({ name: 1 }).lean(),
            (table) => table,
          ),
      ),
  },
  {
    key: 'sales',
    label: 'Orders',
    description: 'One row per dine-in or takeaway order, including payment totals.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('orders', 'Orders', [...saleColumns, { key: 'orderType', label: 'Order type', type: 'text' }, { key: 'table', label: 'Table', type: 'text' }], () =>
        cursorRows(
          () => RestaurantOrderModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
          (order) => {
            const items = Array.isArray(order.items) ? order.items : [];
            return {
              saleNumber: order.orderNumber,
              soldAt: order.paidAt ?? order.createdAt,
              status: order.status,
              cashier: order.paidByNameSnapshot || order.openedByNameSnapshot || '',
              customer: order.customerNameSnapshot ?? '',
              itemCount: items.reduce((sum, item) => sum + Number((item as LeanDoc).quantity ?? 0), 0),
              subtotalMinor: order.subtotalMinor,
              discountMinor: order.discountMinor,
              totalMinor: order.totalMinor,
              paidMinor: order.paidMinor,
              changeMinor: order.changeMinor,
              payments: paymentsLabel(order.payments),
              returnedTotalMinor: order.returnedTotalMinor ?? 0,
              note: order.note ?? '',
              orderType: order.type,
              table: order.tableNameSnapshot ?? '',
            };
          },
        ),
      ),
  },
  {
    key: 'sale-items',
    label: 'Order items',
    description: 'One row per menu item on an order, including kitchen notes and returns.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'order-items',
        'Order items',
        [
          { key: 'saleNumber', label: 'Order', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'name', label: 'Item', type: 'text' },
          { key: 'category', label: 'Category', type: 'text' },
          { key: 'quantity', label: 'Quantity', type: 'number' },
          { key: 'unitPriceMinor', label: 'Unit price', type: 'money' },
          { key: 'lineTotalMinor', label: 'Line total', type: 'money' },
          { key: 'returnedQuantity', label: 'Returned qty', type: 'number' },
          { key: 'note', label: 'Kitchen note', type: 'text' },
        ],
        () =>
          cursorRows(
            () => RestaurantOrderModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
            (order) =>
              (Array.isArray(order.items) ? order.items : []).map((value) => {
                const item = value as LeanDoc;
                return {
                  saleNumber: order.orderNumber,
                  soldAt: order.paidAt ?? order.createdAt,
                  status: order.status,
                  name: item.nameSnapshot,
                  category: item.categorySnapshot,
                  quantity: item.quantity,
                  unitPriceMinor: item.unitPriceMinor,
                  lineTotalMinor: item.lineTotalMinor,
                  returnedQuantity: item.returnedQuantity ?? 0,
                  note: item.note ?? '',
                };
              }),
          ),
      ),
  },
  {
    key: 'sale-payments',
    label: 'Order payments',
    description: 'One row per payment tendered against an order.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('order-payments', 'Order payments', paymentColumns, () =>
        cursorRows(
          () => RestaurantOrderModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
          (order) =>
            (Array.isArray(order.payments) ? order.payments : []).map((value) => {
              const payment = value as LeanDoc;
              return {
                saleNumber: order.orderNumber,
                soldAt: order.paidAt ?? order.createdAt,
                method: payment.methodLabel || payment.method,
                amountMinor: payment.amountMinor,
                status: order.status,
              };
            }),
        ),
      ),
  },
  {
    key: 'kitchen-tickets',
    label: 'Kitchen tickets',
    description: 'Every KOT and its item changes, ready status and kitchen timing.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'kitchen-tickets',
        'Kitchen tickets',
        [
          { key: 'orderNumber', label: 'Order', type: 'text' },
          { key: 'ticketNumber', label: 'Ticket', type: 'text' },
          { key: 'createdAt', label: 'Created', type: 'date' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'quantity', label: 'Change', type: 'number' },
          { key: 'note', label: 'Note', type: 'text' },
          { key: 'createdBy', label: 'Sent by', type: 'text' },
          { key: 'readyAt', label: 'Ready at', type: 'date' },
          { key: 'readyBy', label: 'Ready by', type: 'text' },
        ],
        () =>
          cursorRows(
            () => RestaurantOrderModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
            (order) =>
              (Array.isArray(order.tickets) ? order.tickets : []).flatMap((ticketValue) => {
                const ticket = ticketValue as LeanDoc;
                return (Array.isArray(ticket.lines) ? ticket.lines : []).map((lineValue) => {
                  const line = lineValue as LeanDoc;
                  return {
                    orderNumber: order.orderNumber,
                    ticketNumber: ticket.ticketNumber,
                    createdAt: ticket.createdAt,
                    status: ticket.status,
                    item: line.nameSnapshot,
                    quantity: line.quantity,
                    note: line.note ?? '',
                    createdBy: ticket.createdByNameSnapshot ?? '',
                    readyAt: ticket.readyAt ?? null,
                    readyBy: ticket.readyByNameSnapshot ?? '',
                  };
                });
              }),
          ),
      ),
  },
  {
    key: 'shifts',
    label: 'Cash-drawer shifts',
    description: 'Opening floats, closing counts, expected cash and variance by shift.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'shifts',
        'Cash-drawer shifts',
        [
          { key: 'shiftNumber', label: 'Shift', type: 'text' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'openedAt', label: 'Opened', type: 'date' },
          { key: 'openedBy', label: 'Opened by', type: 'text' },
          { key: 'openingFloatMinor', label: 'Opening float', type: 'money' },
          { key: 'closedAt', label: 'Closed', type: 'date' },
          { key: 'closedBy', label: 'Closed by', type: 'text' },
          { key: 'countedCashMinor', label: 'Counted cash', type: 'money' },
          { key: 'expectedCashMinor', label: 'Expected cash', type: 'money' },
          { key: 'varianceMinor', label: 'Variance', type: 'money' },
          { key: 'openingNote', label: 'Opening note', type: 'text' },
          { key: 'closingNote', label: 'Closing note', type: 'text' },
        ],
        () =>
          cursorRows(
            () => RestaurantShiftModel.find({ ...base(scope), ...dated('openedAt', scope) }).sort({ openedAt: -1 }).lean(),
            (shift) => ({
              shiftNumber: shift.shiftNumber,
              status: shift.status,
              openedAt: shift.openedAt,
              openedBy: shift.openedByNameSnapshot,
              openingFloatMinor: shift.openingFloatMinor,
              closedAt: shift.closedAt,
              closedBy: shift.closedByNameSnapshot,
              countedCashMinor: shift.countedCashMinor,
              expectedCashMinor: shift.expectedCashMinor,
              varianceMinor: shift.varianceMinor,
              openingNote: shift.openingNote,
              closingNote: shift.closingNote,
            }),
          ),
      ),
  },
  {
    key: 'cash-movements',
    label: 'Cash movements',
    description: 'Pay-ins and pay-outs recorded during restaurant shifts.',
    dated: true,
    verticals: ['restaurant'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'cash-movements',
        'Cash movements',
        [
          { key: 'shiftNumber', label: 'Shift', type: 'text' },
          { key: 'at', label: 'Date', type: 'date' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'amountMinor', label: 'Amount', type: 'money' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'by', label: 'By', type: 'text' },
        ],
        () =>
          cursorRows(
            () => RestaurantShiftModel.find({ ...base(scope), ...dated('openedAt', scope) }).sort({ openedAt: -1 }).lean(),
            (shift) =>
              (Array.isArray(shift.cashMovements) ? shift.cashMovements : []).map((value) => {
                const movement = value as LeanDoc;
                return {
                  shiftNumber: shift.shiftNumber,
                  at: movement.at,
                  type: movement.type,
                  amountMinor: movement.amountMinor,
                  reason: movement.reason,
                  by: movement.byNameSnapshot,
                };
              }),
          ),
      ),
  },
];

const pharmacyDatasets: ExportDataset[] = [
  {
    key: 'products',
    label: 'Medicines',
    description: 'Medicine catalogue with clinical details, price and reorder level.',
    dated: true,
    verticals: ['pharmacy'],
    requires: CATALOGUE_PERMISSION,
    sections: async (scope) =>
      single(
        'medicines',
        'Medicines',
        [
          { key: 'name', label: 'Medicine', type: 'text' },
          { key: 'genericName', label: 'Generic name', type: 'text' },
          { key: 'strength', label: 'Strength', type: 'text' },
          { key: 'dosageForm', label: 'Dosage form', type: 'text' },
          { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
          { key: 'containerType', label: 'Container type', type: 'text' },
          { key: 'packageSize', label: 'Package size', type: 'text' },
          { key: 'category', label: 'Category', type: 'text' },
          { key: 'barcode', label: 'Barcode', type: 'text' },
          { key: 'sellingPriceMinor', label: 'Selling price', type: 'money' },
          { key: 'packQuantity', label: 'Pack quantity', type: 'number' },
          { key: 'packPriceMinor', label: 'Pack price', type: 'money' },
          { key: 'requiresPrescription', label: 'Prescription required', type: 'boolean' },
          { key: 'reorderLevel', label: 'Reorder level', type: 'number' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              MedicineModel.find({ tenantId: scope.ctx.tenantId, deletedAt: null, ...dated('createdAt', scope) })
                .select('name genericName strength dosageForm manufacturer containerType packageSize category barcode sellingPriceMinor packQuantity packPriceMinor requiresPrescription reorderLevel isActive createdAt')
                .sort({ name: 1 })
                .lean(),
            (medicine) => medicine,
          ),
      ),
  },
  posCategories('pharmacy'),
  {
    key: 'inventory',
    label: 'Medicine batches',
    description: 'Current stock by batch, including expiry, supplier and stock value.',
    dated: false,
    verticals: ['pharmacy'],
    requires: INVENTORY_PERMISSION,
    sections: async (scope) =>
      single(
        'medicine-batches',
        'Medicine batches',
        [
          { key: 'medicine', label: 'Medicine', type: 'text' },
          { key: 'genericName', label: 'Generic name', type: 'text' },
          { key: 'batchNumber', label: 'Batch', type: 'text' },
          { key: 'expiryDate', label: 'Expiry', type: 'date' },
          { key: 'quantityReceived', label: 'Received qty', type: 'number' },
          { key: 'quantityOnHand', label: 'On hand', type: 'number' },
          { key: 'costPriceMinor', label: 'Unit cost', type: 'money' },
          { key: 'stockValueMinor', label: 'Stock value', type: 'money' },
          { key: 'supplierName', label: 'Supplier', type: 'text' },
          { key: 'receivedAt', label: 'Received', type: 'date' },
          { key: 'receivedBy', label: 'Received by', type: 'text' },
        ],
        () =>
          cursorRows(
            () =>
              MedicineBatchModel.aggregate([
                { $match: base(scope) },
                { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: 'medicine' } },
                { $unwind: { path: '$medicine', preserveNullAndEmptyArrays: true } },
                { $sort: { 'medicine.name': 1, expiryDate: 1 } },
              ]),
            (batch) => {
              const medicine = (batch.medicine ?? {}) as LeanDoc;
              return {
                medicine: medicine.name ?? '',
                genericName: medicine.genericName ?? '',
                batchNumber: batch.batchNumber,
                expiryDate: batch.expiryDate,
                quantityReceived: batch.quantityReceived,
                quantityOnHand: batch.quantityOnHand,
                costPriceMinor: batch.costPriceMinor,
                stockValueMinor: Number(batch.quantityOnHand ?? 0) * Number(batch.costPriceMinor ?? 0),
                supplierName: batch.supplierName,
                receivedAt: batch.receivedAt,
                receivedBy: batch.receivedByNameSnapshot,
              };
            },
          ),
      ),
  },
  {
    key: 'stock-movements',
    label: 'Stock movements',
    description: 'Every medicine batch receipt, sale, return, adjustment and write-off.',
    dated: true,
    verticals: ['pharmacy'],
    requires: INVENTORY_PERMISSION,
    sections: async (scope) =>
      single(
        'stock-movements',
        'Stock movements',
        [
          { key: 'createdAt', label: 'Date', type: 'date' },
          { key: 'medicine', label: 'Medicine', type: 'text' },
          { key: 'batchNumber', label: 'Batch', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'quantity', label: 'Change', type: 'number' },
          { key: 'balanceAfter', label: 'Balance after', type: 'number' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'referenceNumber', label: 'Reference', type: 'text' },
          { key: 'createdBy', label: 'By', type: 'text' },
          { key: 'outOfStockOverride', label: 'Stock override', type: 'boolean' },
        ],
        () =>
          cursorRows(
            () => PharmacyStockMovementModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
            (movement) => ({
              createdAt: movement.createdAt,
              medicine: movement.medicineNameSnapshot,
              batchNumber: movement.batchNumberSnapshot,
              type: movement.type,
              quantity: movement.quantity,
              balanceAfter: movement.balanceAfter,
              reason: movement.reason,
              referenceNumber: movement.referenceNumber,
              createdBy: movement.createdByNameSnapshot,
              outOfStockOverride: movement.outOfStockOverride === true,
            }),
          ),
      ),
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'One row per pharmacy sale, with totals, customer and prescription reference.',
    dated: true,
    verticals: ['pharmacy'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('sales', 'Sales', [...saleColumns, { key: 'costMinor', label: 'Cost', type: 'money' }, { key: 'patient', label: 'Patient', type: 'text' }, { key: 'prescriber', label: 'Prescriber', type: 'text' }, { key: 'prescriptionNumber', label: 'Prescription no.', type: 'text' }], () =>
        cursorRows(
          () => PharmacySaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
          (sale) => {
            const items = Array.isArray(sale.items) ? sale.items : [];
            const prescription = (sale.prescription ?? {}) as LeanDoc;
            return {
              saleNumber: sale.saleNumber,
              soldAt: sale.soldAt,
              status: sale.status,
              cashier: sale.cashierNameSnapshot,
              customer: sale.customerNameSnapshot,
              itemCount: items.reduce((sum, item) => sum + Number((item as LeanDoc).quantity ?? 0), 0),
              subtotalMinor: sale.subtotalMinor,
              discountMinor: sale.discountMinor,
              totalMinor: sale.totalMinor,
              paidMinor: sale.paidMinor,
              changeMinor: sale.changeMinor,
              payments: paymentsLabel(sale.payments),
              returnedTotalMinor: sale.returnedTotalMinor ?? 0,
              note: sale.note,
              costMinor: sale.costMinor,
              patient: prescription.patientName ?? '',
              prescriber: prescription.prescriberName ?? '',
              prescriptionNumber: prescription.prescriptionNumber ?? '',
            };
          },
        ),
      ),
  },
  {
    key: 'sale-items',
    label: 'Sale items',
    description: 'One row per medicine sold, with allocated batches and return quantity.',
    dated: true,
    verticals: ['pharmacy'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'sale-items',
        'Sale items',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'medicine', label: 'Medicine', type: 'text' },
          { key: 'genericName', label: 'Generic name', type: 'text' },
          { key: 'strength', label: 'Strength', type: 'text' },
          { key: 'dosageForm', label: 'Dosage form', type: 'text' },
          { key: 'quantity', label: 'Quantity', type: 'number' },
          { key: 'unitPriceMinor', label: 'Unit price', type: 'money' },
          { key: 'lineTotalMinor', label: 'Line total', type: 'money' },
          { key: 'batches', label: 'Batches', type: 'text' },
          { key: 'returnedQuantity', label: 'Returned qty', type: 'number' },
          { key: 'outOfStockOverride', label: 'Stock override', type: 'boolean' },
        ],
        () =>
          cursorRows(
            () => PharmacySaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
            (sale) =>
              (Array.isArray(sale.items) ? sale.items : []).map((value) => {
                const item = value as LeanDoc;
                const allocations = Array.isArray(item.allocations) ? item.allocations : [];
                return {
                  saleNumber: sale.saleNumber,
                  soldAt: sale.soldAt,
                  status: sale.status,
                  medicine: item.nameSnapshot,
                  genericName: item.genericNameSnapshot,
                  strength: item.strengthSnapshot,
                  dosageForm: item.dosageFormSnapshot,
                  quantity: item.quantity,
                  unitPriceMinor: item.unitPriceMinor,
                  lineTotalMinor: item.lineTotalMinor,
                  batches: allocations.map((entry) => `${String((entry as LeanDoc).batchNumber ?? '')}: ${Number((entry as LeanDoc).quantity ?? 0)}`).join('; '),
                  returnedQuantity: item.returnedQuantity ?? 0,
                  outOfStockOverride: item.outOfStockOverride === true,
                };
              }),
          ),
      ),
  },
  {
    key: 'sale-payments',
    label: 'Sale payments',
    description: 'One row per payment tendered against a pharmacy sale.',
    dated: true,
    verticals: ['pharmacy'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('sale-payments', 'Sale payments', paymentColumns, () =>
        cursorRows(
          () => PharmacySaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
          (sale) =>
            (Array.isArray(sale.payments) ? sale.payments : []).map((value) => {
              const payment = value as LeanDoc;
              return { saleNumber: sale.saleNumber, soldAt: sale.soldAt, method: payment.methodLabel || payment.method, amountMinor: payment.amountMinor, status: sale.status };
            }),
        ),
      ),
  },
  {
    key: 'prescriptions',
    label: 'Prescription records',
    description: 'Prescription details recorded with medicine sales.',
    dated: true,
    verticals: ['pharmacy'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'prescriptions',
        'Prescription records',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'patientName', label: 'Patient', type: 'text' },
          { key: 'prescriberName', label: 'Prescriber', type: 'text' },
          { key: 'prescriptionNumber', label: 'Prescription no.', type: 'text' },
          { key: 'note', label: 'Note', type: 'text' },
        ],
        () =>
          cursorRows(
            () => PharmacySaleModel.find({ ...base(scope), prescription: { $ne: null }, ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
            (sale) => {
              const prescription = (sale.prescription ?? {}) as LeanDoc;
              return {
                saleNumber: sale.saleNumber,
                soldAt: sale.soldAt,
                patientName: prescription.patientName,
                prescriberName: prescription.prescriberName,
                prescriptionNumber: prescription.prescriptionNumber,
                note: prescription.note,
              };
            },
          ),
      ),
  },
];

const shopDatasets: ExportDataset[] = [
  {
    key: 'products',
    label: 'Products',
    description: 'Super Shop catalogue with barcode, unit, price, VAT and reorder level.',
    dated: true,
    verticals: ['supershop'],
    requires: CATALOGUE_PERMISSION,
    sections: async (scope) =>
      single(
        'products',
        'Products',
        [
          { key: 'name', label: 'Product', type: 'text' },
          { key: 'brand', label: 'Brand', type: 'text' },
          { key: 'category', label: 'Department', type: 'text' },
          { key: 'barcode', label: 'Barcode', type: 'text' },
          { key: 'unitType', label: 'Unit', type: 'text' },
          { key: 'priceMinor', label: 'Price', type: 'money' },
          { key: 'vatRatePercent', label: 'VAT %', type: 'number' },
          { key: 'reorderLevel', label: 'Reorder level', type: 'number' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () => ShopProductModel.find({ tenantId: scope.ctx.tenantId, deletedAt: null, ...dated('createdAt', scope) }).sort({ category: 1, name: 1 }).lean(),
            (product) => ({ ...product, vatRatePercent: Number(product.vatRateBps ?? 0) / 100 }),
          ),
      ),
  },
  posCategories('supershop'),
  {
    key: 'brands',
    label: 'Brands',
    description: 'Managed product brands and their catalogue status.',
    dated: true,
    verticals: ['supershop'],
    requires: CATALOGUE_PERMISSION,
    sections: async (scope) =>
      single(
        'brands',
        'Brands',
        [
          { key: 'name', label: 'Brand', type: 'text' },
          { key: 'isActive', label: 'Active', type: 'boolean' },
          { key: 'sortOrder', label: 'Sort order', type: 'number' },
          { key: 'createdAt', label: 'Created', type: 'date' },
        ],
        () =>
          cursorRows(
            () => ShopBrandModel.find({ tenantId: scope.ctx.tenantId, deletedAt: null, ...dated('createdAt', scope) }).select('name isActive sortOrder createdAt').sort({ sortOrder: 1, name: 1 }).lean(),
            (brand) => brand,
          ),
      ),
  },
  {
    key: 'inventory',
    label: 'Inventory (current stock)',
    description: 'Current branch stock and value for every Super Shop product.',
    dated: false,
    verticals: ['supershop'],
    requires: INVENTORY_PERMISSION,
    sections: async (scope) =>
      single(
        'inventory',
        'Inventory',
        [
          { key: 'product', label: 'Product', type: 'text' },
          { key: 'brand', label: 'Brand', type: 'text' },
          { key: 'category', label: 'Department', type: 'text' },
          { key: 'barcode', label: 'Barcode', type: 'text' },
          { key: 'unitType', label: 'Unit', type: 'text' },
          { key: 'quantityOnHand', label: 'On hand', type: 'number' },
          { key: 'costPriceMinor', label: 'Cost per unit', type: 'money' },
          { key: 'stockValueMinor', label: 'Stock value', type: 'money' },
          { key: 'priceMinor', label: 'Selling price', type: 'money' },
          { key: 'reorderLevel', label: 'Reorder level', type: 'number' },
          { key: 'lastReceivedAt', label: 'Last received', type: 'date' },
        ],
        () =>
          cursorRows(
            () =>
              ShopStockModel.aggregate([
                { $match: base(scope) },
                { $lookup: { from: 'shopproducts', localField: 'productId', foreignField: '_id', as: 'product' } },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
                { $sort: { 'product.category': 1, 'product.name': 1 } },
              ]),
            (stock) => {
              const product = (stock.product ?? {}) as LeanDoc;
              return {
                product: product.name ?? '',
                brand: product.brand ?? '',
                category: product.category ?? '',
                barcode: product.barcode ?? '',
                unitType: product.unitType ?? '',
                quantityOnHand: stock.quantityOnHand,
                costPriceMinor: stock.costPriceMinor,
                stockValueMinor:
                  product.unitType === 'weight'
                    ? Math.round((Number(stock.quantityOnHand ?? 0) * Number(stock.costPriceMinor ?? 0)) / 1000)
                    : Number(stock.quantityOnHand ?? 0) * Number(stock.costPriceMinor ?? 0),
                priceMinor: product.priceMinor ?? 0,
                reorderLevel: product.reorderLevel ?? 0,
                lastReceivedAt: stock.lastReceivedAt,
              };
            },
          ),
      ),
  },
  {
    key: 'stock-movements',
    label: 'Stock movements',
    description: 'Every Super Shop receipt, sale, return, adjustment and write-off.',
    dated: true,
    verticals: ['supershop'],
    requires: INVENTORY_PERMISSION,
    sections: async (scope) =>
      single(
        'stock-movements',
        'Stock movements',
        [
          { key: 'createdAt', label: 'Date', type: 'date' },
          { key: 'product', label: 'Product', type: 'text' },
          { key: 'unitType', label: 'Unit', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
          { key: 'quantity', label: 'Change', type: 'number' },
          { key: 'balanceAfter', label: 'Balance after', type: 'number' },
          { key: 'unitCostMinor', label: 'Unit cost', type: 'money' },
          { key: 'reason', label: 'Reason', type: 'text' },
          { key: 'referenceNumber', label: 'Reference', type: 'text' },
          { key: 'createdBy', label: 'By', type: 'text' },
          { key: 'outOfStockOverride', label: 'Stock override', type: 'boolean' },
        ],
        () =>
          cursorRows(
            () => ShopStockMovementModel.find({ ...base(scope), ...dated('createdAt', scope) }).sort({ createdAt: -1 }).lean(),
            (movement) => ({
              createdAt: movement.createdAt,
              product: movement.productNameSnapshot,
              unitType: movement.unitType,
              type: movement.type,
              quantity: movement.quantity,
              balanceAfter: movement.balanceAfter,
              unitCostMinor: movement.unitCostMinor,
              reason: movement.reason,
              referenceNumber: movement.referenceNumber,
              createdBy: movement.createdByNameSnapshot,
              outOfStockOverride: movement.outOfStockOverride === true,
            }),
          ),
      ),
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'One row per Super Shop sale, including VAT, rounding, cost and payment totals.',
    dated: true,
    verticals: ['supershop'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('sales', 'Sales', [...saleColumns, { key: 'roundingMinor', label: 'Rounding', type: 'money' }, { key: 'vatMinor', label: 'VAT', type: 'money' }, { key: 'costMinor', label: 'Cost', type: 'money' }, { key: 'exchangeReturnNumber', label: 'Exchange return', type: 'text' }], () =>
        cursorRows(
          () => ShopSaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
          (sale) => {
            const items = Array.isArray(sale.items) ? sale.items : [];
            const exchange = (sale.exchange ?? {}) as LeanDoc;
            return {
              saleNumber: sale.saleNumber,
              soldAt: sale.soldAt,
              status: sale.status,
              cashier: sale.cashierNameSnapshot,
              customer: sale.customerNameSnapshot,
              itemCount: items.reduce((sum, item) => sum + Number((item as LeanDoc).quantity ?? 0), 0),
              subtotalMinor: sale.subtotalMinor,
              discountMinor: sale.discountMinor,
              totalMinor: sale.totalMinor,
              paidMinor: sale.paidMinor,
              changeMinor: sale.changeMinor,
              payments: paymentsLabel(sale.payments),
              returnedTotalMinor: sale.returnedTotalMinor ?? 0,
              note: sale.note,
              roundingMinor: sale.roundingMinor,
              vatMinor: sale.vatMinor,
              costMinor: sale.costMinor,
              exchangeReturnNumber: exchange.returnNumber ?? '',
            };
          },
        ),
      ),
  },
  {
    key: 'sale-items',
    label: 'Sale items',
    description: 'One row per sold product, including weight units, VAT, cost and returned quantity.',
    dated: true,
    verticals: ['supershop'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single(
        'sale-items',
        'Sale items',
        [
          { key: 'saleNumber', label: 'Invoice', type: 'text' },
          { key: 'soldAt', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'text' },
          { key: 'product', label: 'Product', type: 'text' },
          { key: 'brand', label: 'Brand', type: 'text' },
          { key: 'category', label: 'Department', type: 'text' },
          { key: 'barcode', label: 'Barcode', type: 'text' },
          { key: 'unitType', label: 'Unit', type: 'text' },
          { key: 'quantity', label: 'Quantity', type: 'number' },
          { key: 'unitPriceMinor', label: 'Unit price', type: 'money' },
          { key: 'lineTotalMinor', label: 'Line total', type: 'money' },
          { key: 'vatMinor', label: 'VAT', type: 'money' },
          { key: 'costMinor', label: 'Cost', type: 'money' },
          { key: 'returnedQuantity', label: 'Returned qty', type: 'number' },
          { key: 'outOfStockOverride', label: 'Stock override', type: 'boolean' },
        ],
        () =>
          cursorRows(
            () => ShopSaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
            (sale) =>
              (Array.isArray(sale.items) ? sale.items : []).map((value) => {
                const item = value as LeanDoc;
                return {
                  saleNumber: sale.saleNumber,
                  soldAt: sale.soldAt,
                  status: sale.status,
                  product: item.nameSnapshot,
                  brand: item.brandSnapshot,
                  category: item.categorySnapshot,
                  barcode: item.barcodeSnapshot,
                  unitType: item.unitType,
                  quantity: item.quantity,
                  unitPriceMinor: item.unitPriceMinor,
                  lineTotalMinor: item.lineTotalMinor,
                  vatMinor: item.vatMinor,
                  costMinor: item.costMinor,
                  returnedQuantity: item.returnedQuantity ?? 0,
                  outOfStockOverride: item.outOfStockOverride === true,
                };
              }),
          ),
      ),
  },
  {
    key: 'sale-payments',
    label: 'Sale payments',
    description: 'One row per payment tendered against a Super Shop sale.',
    dated: true,
    verticals: ['supershop'],
    requires: SALES_PERMISSION,
    sections: async (scope) =>
      single('sale-payments', 'Sale payments', paymentColumns, () =>
        cursorRows(
          () => ShopSaleModel.find({ ...base(scope), ...dated('soldAt', scope) }).sort({ soldAt: -1 }).lean(),
          (sale) =>
            (Array.isArray(sale.payments) ? sale.payments : []).map((value) => {
              const payment = value as LeanDoc;
              return { saleNumber: sale.saleNumber, soldAt: sale.soldAt, method: payment.methodLabel || payment.method, amountMinor: payment.amountMinor, status: sale.status };
            }),
        ),
      ),
  },
];

export const VERTICAL_EXPORT_DATASETS: ExportDataset[] = [...restaurantDatasets, ...pharmacyDatasets, ...shopDatasets];
