import type { PaymentMethod } from '../../config/constants';
import { ApiError } from '../../utils/ApiError';

/**
 * How a sale was paid for: one row per tender, in minor units.
 *
 * Every POS vertical sends this same shape - a single-method sale is simply one
 * row - so the rules below can be applied to all of them.
 */
export interface TenderRow {
  method: PaymentMethod;
  amountMinor: number;
}

/** What a settled sale took: the money in, the change out, and the cash part. */
export interface Settlement {
  paidMinor: number;
  changeMinor: number;
  cashMinor: number;
}

/** Everything tendered, whatever the method. */
export const tenderedMinor = (rows: readonly TenderRow[]) => rows.reduce((sum, row) => sum + row.amountMinor, 0);

/** The cash part of it - the only tender change can come out of. */
export const cashTenderedMinor = (rows: readonly TenderRow[]) =>
  rows.filter((row) => row.method === 'cash').reduce((sum, row) => sum + row.amountMinor, 0);

/**
 * How a vertical words and codes a refusal.
 *
 * The rules below are the same in all four POS types; the answers a client gets
 * are not, and that is deliberate for now. Clothing has always answered 422 for
 * a payment that does not add up, the three newer verticals 400, and both are
 * part of a published API. Rather than change one of them inside a refactor,
 * both dialects live here, next to each other, where the difference is visible
 * and can be settled on purpose - task 03, when payment methods stop being an
 * enum, is where they should converge.
 */
export interface TenderDialect {
  notEnabled(method: string): ApiError;
  short(totalMinor: number, paidMinor: number): ApiError;
  nonCashChange(): ApiError;
}

/** Major units, for a message a cashier reads. Never used in a calculation. */
const say = (minor: number) => (minor / 100).toFixed(2);

/** Super Shop, Pharmacy and Restaurant. */
export const POS_TENDER_DIALECT: TenderDialect = {
  notEnabled: (method) => ApiError.badRequest(`This branch does not accept ${method} payments`),
  short: (totalMinor, paidMinor) =>
    ApiError.badRequest(`The payment is ${say(totalMinor - paidMinor)} short of the ${say(totalMinor)} total.`, { totalMinor, paidMinor }),
  nonCashChange: () => ApiError.badRequest('Only a cash payment can exceed the total'),
};

/** Clothing, which answers 422 and words these its own way. */
export const CLOTHING_TENDER_DIALECT: TenderDialect = {
  notEnabled: (method) => ApiError.badRequest(`"${method}" is not an enabled payment method for this store`),
  short: (totalMinor, paidMinor) =>
    ApiError.validation(`The amount tendered (${paidMinor}) is less than the total (${totalMinor}). Collect the full amount to complete this sale.`, {
      totalMinor,
      paidMinor,
      shortfallMinor: totalMinor - paidMinor,
    }),
  nonCashChange: () => ApiError.validation('Only a cash payment can exceed the total'),
};

/**
 * Rule 1: every method that takes money must be enabled for this branch.
 *
 * A branch that has turned off card payments cannot be made to accept one by a
 * till that asks nicely - the enabled list is the branch's, not the client's.
 */
export function assertMethodsEnabled(accepted: readonly string[], methods: readonly string[], dialect: TenderDialect): void {
  const refused = methods.find((method) => !accepted.includes(method));
  if (refused) throw dialect.notEnabled(refused);
}

/**
 * Rule 2: the money tendered has to cover the sale.
 *
 * This is the backend half of the tendered-amount rule. Every POS blocks it in
 * the UI as well, but this is what actually enforces it: a sale is never
 * completed for less than it costs.
 */
export function assertCovered(totalMinor: number, paidMinor: number, dialect: TenderDialect): void {
  if (paidMinor < totalMinor) throw dialect.short(totalMinor, paidMinor);
}

/**
 * Rule 3: only cash may exceed the total.
 *
 * Change comes out of the drawer. An over-tendered card or bKash payment is a
 * mistake, not change - the money would have to be refunded through the same
 * provider, which no till can do.
 */
export function assertChangeIsCash(changeMinor: number, cashMinor: number, dialect: TenderDialect): void {
  if (changeMinor > cashMinor) throw dialect.nonCashChange();
}

/**
 * All three rules, for a till that settles a sale in one step.
 *
 * Returns what the sale actually took. The caller stores those numbers; it does
 * not recompute them, and it never takes them from the client.
 */
export function settleTender(input: {
  totalMinor: number;
  tendered: readonly TenderRow[];
  /** The branch's enabled methods. */
  accepted: readonly string[];
  dialect: TenderDialect;
}): Settlement {
  assertMethodsEnabled(input.accepted, input.tendered.map((row) => row.method), input.dialect);

  const paidMinor = tenderedMinor(input.tendered);
  assertCovered(input.totalMinor, paidMinor, input.dialect);

  const changeMinor = paidMinor - input.totalMinor;
  const cashMinor = cashTenderedMinor(input.tendered);
  assertChangeIsCash(changeMinor, cashMinor, input.dialect);

  return { paidMinor, changeMinor, cashMinor };
}
