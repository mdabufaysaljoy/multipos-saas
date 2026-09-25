import type { PrintableReport, PrintableSection } from './reportPrint';
import { money, number, text } from './reportPrint';

/**
 * Each vertical's Advanced Analytics, as a printable report.
 *
 * This is the same data the screen shows, in the same order, with the same
 * names - a printed report that disagreed with the page would be worse than no
 * printed report at all. Nothing is recomputed here: the figures come from the
 * report service that answered the page, and only the arrangement is new.
 */

type Row = Record<string, unknown>;
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Basis points as the page prints them: 2450 -> "24.5%". */
const bps = (value: unknown) => `${(num(value) / 100).toFixed(1)}%`;
/** Minor units in a summary line, where the value is text rather than a money column. */
const amount = (value: unknown, currency: string) => `${currency} ${(num(value) / 100).toFixed(2)}`;

const section = (key: string, label: string, columns: PrintableSection['columns'], rows: Row[]): PrintableSection => ({ key, label, columns, rows });

export function supershopReportView(data: Row, currency: string): PrintableReport {
  const totals = (data.totals ?? {}) as Row;
  const returns = (data.returns ?? {}) as Row;
  const writeOffs = (data.writeOffs ?? {}) as Row;
  return {
    title: 'Advanced Analytics',
    rangeLabel: String((data.range as Row)?.label ?? ''),
    summary: [
      { label: 'Sales', value: String(num(totals.salesCount)) },
      { label: 'Charged', value: amount(totals.grossSalesMinor, currency) },
      { label: 'Refunded', value: amount(totals.returnAmountMinor, currency) },
      { label: 'Net sales', value: amount(totals.netSalesMinor, currency) },
      { label: 'VAT collected', value: amount(totals.vatMinor, currency) },
      { label: 'Cost of goods', value: amount(totals.costMinor, currency) },
      { label: 'Gross profit', value: amount(totals.grossProfitMinor, currency) },
      { label: 'Margin (excl. VAT)', value: bps(totals.marginBps) },
      { label: 'Discounts', value: amount(totals.discountsMinor, currency) },
      { label: 'Average basket', value: amount(totals.averageBasketMinor, currency) },
    ],
    sections: [
      section('trend', 'Daily sales', [text('date', 'Day'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales'), money('vatMinor', 'VAT'), money('grossProfitMinor', 'Profit')], asRows(data.trend)),
      section('products', 'Best sellers', [text('name', 'Product'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue'), money('profitMinor', 'Profit')], asRows(data.products)),
      section('departments', 'Departments', [text('department', 'Department'), number('lines', 'Lines'), money('revenueMinor', 'Revenue'), money('profitMinor', 'Profit')], asRows(data.departments)),
      section('brands', 'Brands', [text('brand', 'Brand'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue'), money('profitMinor', 'Profit')], asRows(data.brands)),
      section(
        'staff',
        'Staff',
        [text('name', 'Cashier'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales'), money('discountsMinor', 'Discounts'), money('profitMinor', 'Profit')],
        asRows(data.staff),
      ),
      // Only printed when more than one branch is in scope; a single-branch
      // report would just repeat its own total.
      section(
        'branches',
        'Branches',
        [text('name', 'Branch'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales'), money('profitMinor', 'Profit')],
        asRows(data.branchBreakdown).length > 1 ? asRows(data.branchBreakdown) : [],
      ),
      section('customers', 'Top customers', [text('name', 'Customer'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales')], asRows(data.customers)),
      section(
        'vatRates',
        'VAT by rate',
        [text('rate', 'Rate'), number('lines', 'Lines'), money('netOfVatMinor', 'Excl. VAT'), money('vatMinor', 'VAT')],
        asRows(data.vatRates).map((row) => ({ ...row, rate: `${(num(row.vatRateBps) / 100).toFixed(2).replace(/\.00$/, '')}%` })),
      ),
      section('hours', 'Busy hours', [text('label', 'Hour'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales')], asRows(data.hours).map((row) => ({ ...row, label: `${row.hour}:00` }))),
      section('payments', 'Payments', [text('method', 'Method'), number('sales', 'Sales'), money('amountMinor', 'Taken')], asRows(data.payments)),
      section('returns', 'Returns', [text('returnNumber', 'Return'), text('saleNumber', 'Sale'), text('reason', 'Reason'), text('by', 'Taken by'), money('totalMinor', 'Refunded')], asRows(returns.recent)),
      section('writeOffs', 'Write-offs', [text('name', 'Product'), number('quantity', 'Quantity'), money('costMinor', 'Cost')], asRows(writeOffs.byProduct)),
      section('deadStock', 'Dead stock', [text('name', 'Product'), number('quantityOnHand', 'On hand'), money('stockCostMinor', 'At cost')], asRows(data.deadStock)),
    ],
  };
}

export function pharmacyReportView(data: Row, currency: string): PrintableReport {
  const totals = (data.totals ?? {}) as Row;
  const returns = (data.returns ?? {}) as Row;
  const writeOffs = (data.writeOffs ?? {}) as Row;
  const expiry = (data.expiry ?? {}) as Row;
  const bucket = (key: string, label: string) => ({ label, units: num((expiry[key] as Row)?.units), costMinor: num((expiry[key] as Row)?.costMinor) });
  return {
    title: 'Advanced Analytics',
    rangeLabel: String((data.range as Row)?.label ?? ''),
    summary: [
      { label: 'Sales', value: String(num(totals.salesCount)) },
      { label: 'Charged', value: amount(totals.grossSalesMinor, currency) },
      { label: 'Refunded', value: amount(totals.returnAmountMinor, currency) },
      { label: 'Net sales', value: amount(totals.netSalesMinor, currency) },
      { label: 'Cost of goods', value: amount(totals.costMinor, currency) },
      { label: 'Gross profit', value: amount(totals.grossProfitMinor, currency) },
      { label: 'Margin', value: bps(totals.marginBps) },
      { label: 'Discounts', value: amount(totals.discountsMinor, currency) },
      { label: 'Average basket', value: amount(totals.averageBasketMinor, currency) },
      { label: 'Prescription sales', value: `${num(totals.prescriptionSales)} · ${amount(totals.prescriptionValueMinor, currency)}` },
    ],
    sections: [
      section('trend', 'Daily sales', [text('date', 'Day'), number('salesCount', 'Sales'), money('netSalesMinor', 'Net sales'), money('grossProfitMinor', 'Profit')], asRows(data.trend)),
      section(
        'medicines',
        'Most dispensed',
        [text('name', 'Medicine'), text('strength', 'Strength'), number('quantity', 'Units'), money('revenueMinor', 'Revenue'), money('profitMinor', 'Profit')],
        asRows(data.medicines),
      ),
      section('dosageForms', 'By form', [text('dosageForm', 'Form'), number('quantity', 'Units'), money('revenueMinor', 'Revenue')], asRows(data.dosageForms)),
      section('payments', 'Payments', [text('method', 'Method'), number('sales', 'Sales'), money('amountMinor', 'Taken')], asRows(data.payments)),
      section('returns', 'Returns', [text('returnNumber', 'Return'), text('saleNumber', 'Sale'), text('reason', 'Reason'), text('by', 'Taken by'), money('totalMinor', 'Refunded')], asRows(returns.recent)),
      section('expiry', 'Expiry', [text('label', 'Bucket'), number('units', 'Units'), money('costMinor', 'At cost')], [
        bucket('expired', 'Already expired'),
        bucket('within30', 'Within 30 days'),
        bucket('within60', 'Within 60 days'),
        bucket('within90', 'Within 90 days'),
      ]),
      section('writeOffs', 'Write-offs', [text('name', 'Medicine'), number('units', 'Units'), money('costMinor', 'Cost')], asRows(writeOffs.byMedicine)),
      section('slowMovers', 'Slow movers', [text('name', 'Medicine'), text('strength', 'Strength'), number('units', 'On hand'), money('stockCostMinor', 'At cost')], asRows(data.slowMovers)),
    ],
  };
}

export function restaurantReportView(data: Row, currency: string): PrintableReport {
  const totals = (data.totals ?? {}) as Row;
  const returns = (data.returns ?? {}) as Row;
  const voids = (data.voids ?? {}) as Row;
  const discounts = (data.discounts ?? {}) as Row;
  return {
    title: 'Advanced Analytics',
    rangeLabel: String((data.range as Row)?.label ?? ''),
    summary: [
      { label: 'Paid orders', value: String(num(totals.paidOrders)) },
      { label: 'Charged', value: amount(totals.grossSalesMinor, currency) },
      { label: 'Refunded', value: amount(totals.returnAmountMinor, currency) },
      { label: 'Net sales', value: amount(totals.netSalesMinor, currency) },
      { label: 'Discounts', value: amount(totals.discountsMinor, currency) },
      { label: 'Taken with no shift open', value: amount(totals.unshiftedSalesMinor, currency) },
    ],
    sections: [
      section('menu', 'Best sellers', [text('name', 'Dish'), text('category', 'Section'), number('quantity', 'Sold'), number('orders', 'Orders'), money('revenueMinor', 'Revenue')], asRows(data.menu)),
      section('categories', 'Sections', [text('category', 'Section'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue')], asRows(data.categories)),
      section('payments', 'Payments', [text('method', 'Method'), number('orders', 'Orders'), money('amountMinor', 'Taken')], asRows(data.payments)),
      section('returns', 'Refunds', [text('returnNumber', 'Refund'), text('saleNumber', 'Order'), text('reason', 'Reason'), text('by', 'Taken by'), money('totalMinor', 'Refunded')], asRows(returns.recent)),
      section('voids', 'Voided lines', [text('name', 'Dish'), number('quantity', 'Quantity'), money('valueMinor', 'Value')], asRows(voids.byItem)),
      section('discounts', 'Discounts by staff', [text('name', 'Staff'), number('orders', 'Orders'), money('discountsMinor', 'Discounts')], asRows(discounts.byStaff)),
    ],
  };
}

export function clothingReportView(data: Row, currency: string): PrintableReport {
  const summary = (data.summary ?? {}) as Row;
  return {
    title: 'Advanced Analytics',
    rangeLabel: String((data.range as Row)?.label ?? ''),
    summary: [
      { label: 'Orders', value: String(num(summary.orderCount)) },
      { label: 'Items sold', value: String(num(summary.itemCount)) },
      { label: 'Charged', value: amount(summary.totalSalesMinor, currency) },
      { label: 'Refunded', value: amount(summary.returnAmountMinor, currency) },
      { label: 'Net sales', value: amount(summary.netSalesMinor, currency) },
      { label: 'Cost of goods', value: amount(summary.totalCostMinor, currency) },
      { label: 'Gross profit', value: amount(summary.grossProfitMinor, currency) },
      { label: 'Discounts', value: amount(summary.discountMinor, currency) },
      { label: 'Tax', value: amount(summary.taxMinor, currency) },
      { label: 'Average order', value: amount(summary.averageOrderValueMinor, currency) },
    ],
    sections: [
      section('trend', 'Sales over time', [text('bucket', 'Period'), number('orderCount', 'Orders'), number('itemCount', 'Items'), money('totalMinor', 'Sales')], asRows(data.trend)),
      section('topProducts', 'Best sellers', [text('name', 'Product'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue')], asRows(data.topProducts)),
      section('topVariants', 'Best variants', [text('name', 'Variant'), text('sku', 'SKU'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue')], asRows(data.topVariants)),
      section('byCategory', 'Categories', [text('name', 'Category'), number('quantity', 'Sold'), money('revenueMinor', 'Revenue')], asRows(data.byCategory)),
      section('byPaymentMethod', 'Payments', [text('method', 'Method'), number('orderCount', 'Orders'), money('totalMinor', 'Taken')], asRows(data.byPaymentMethod)),
      section('byStaff', 'Staff', [text('name', 'Staff'), number('orderCount', 'Orders'), money('totalMinor', 'Sales')], asRows(data.byStaff)),
    ],
  };
}
