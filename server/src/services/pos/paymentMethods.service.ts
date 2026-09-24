import type { Types } from 'mongoose';
import { PAYMENT_METHODS, type PaymentMethod } from '../../config/constants';
import { PaymentMethodModel } from '../../models/PaymentMethod';
import { ApiError } from '../../utils/ApiError';

/**
 * How a sale was paid for: one row per tender, in minor units.
 *
 * Every POS vertical sends this same shape - a single-method sale is simply one
 * row - so the rules below can be applied to all of them.
 */
export interface TenderRow {
  /** A built-in key, or one the workspace added itself. */
  method: PaymentMethod | string;
  amountMinor: number;
  /** What the till called it, kept with the sale so a rename cannot rewrite history. */
  methodLabel?: string;
}

/** A tender as the till offers it. */
export interface TenderOption {
  key: string;
  label: string;
  isBuiltIn: boolean;
  isActive: boolean;
}

/**
 * The six every workspace has, in the order a till shows them.
 *
 * These are not rows in a collection: they exist for every workspace that has
 * ever been created, so nothing has to be seeded or migrated for them, and a
 * sale from 2024 that says `cash` still means cash.
 */
export const BUILT_IN_TENDERS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bkash: 'bKash',
  nagad: 'Nagad',
  bank: 'Bank',
  card: 'Card',
  other: 'Other',
};

/** Reserved: a workspace cannot define its own "cash". */
export const isBuiltInTender = (key: string): key is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(key);

/**
 * Every tender this workspace knows about: the six built-ins, then whatever it
 * added itself. Inactive custom methods are included so history and settings
 * can still name them; the till filters by the branch's enabled list.
 */
export async function listTenders(tenantId: Types.ObjectId): Promise<TenderOption[]> {
  const custom = await PaymentMethodModel.find({ tenantId }).sort({ sortOrder: 1, label: 1 }).lean();
  return [
    ...PAYMENT_METHODS.map((key) => ({ key, label: BUILT_IN_TENDERS[key], isBuiltIn: true, isActive: true })),
    ...custom.map((row) => ({ key: row.key, label: row.label, isBuiltIn: false, isActive: row.isActive })),
  ];
}

/**
 * key -> label for this workspace, used to stamp a sale's payment lines.
 *
 * A key nobody recognises keeps its own name rather than disappearing: a sale
 * is a record of what happened, and a method removed from the database years
 * later must not turn a receipt into a blank.
 */
export async function tenderLabels(tenantId: Types.ObjectId): Promise<Map<string, string>> {
  return new Map((await listTenders(tenantId)).map((tender) => [tender.key, tender.label]));
}

/** Stamps each row with the label the workspace uses for it today. */
export function stampTenderLabels<T extends TenderRow>(rows: readonly T[], labels: Map<string, string>): T[] {
  return rows.map((row) => ({ ...row, methodLabel: row.methodLabel ?? labels.get(row.method) ?? row.method }));
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
