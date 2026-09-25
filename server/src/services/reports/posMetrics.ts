/**
 * The figures every POS vertical reports the same way.
 *
 * Each vertical measures different things - VAT rates and dead stock in a shop,
 * batches and expiry in a pharmacy, tables and kitchen times in a restaurant -
 * and those stay its own. What must NOT differ is the vocabulary for the money,
 * because an owner comparing two of their own workspaces has to be comparing
 * the same thing.
 *
 *   grossSalesMinor   what was charged
 *   returnAmountMinor what was given back
 *   netSalesMinor     what was kept: gross less returns
 *   costMinor         cost of what was sold, less the cost of what came back
 *   grossProfitMinor  net less cost (and less VAT where the vertical collects it)
 *
 * Clothing has used these names since long before the other three existed; this
 * is what the others were brought into line with.
 */
export interface PosReportOverview {
  /** How many sales or orders were completed. */
  salesCount: number;
  grossSalesMinor: number;
  returnCount: number;
  returnAmountMinor: number;
  netSalesMinor: number;
  discountsMinor: number;
  costMinor: number;
  grossProfitMinor: number;
  /** Profit as basis points of the revenue it was earned on (1234 = 12.34%). */
  marginBps: number;
}

/** Gross profit as basis points of revenue. Never divides by zero. */
export const marginBpsOf = (profitMinor: number, revenueMinor: number) =>
  revenueMinor > 0 ? Math.round((profitMinor * 10_000) / revenueMinor) : 0;

/** One day of a trend, as every vertical reports it. */
export interface PosTrendPoint {
  date: string;
  salesCount: number;
  grossSalesMinor: number;
  returnAmountMinor: number;
  netSalesMinor: number;
}
