import * as React from 'react';
import type { PosVariant } from '@/types/domain';

export interface CartLine {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  imageUrl: string | null;
  /** Catalogue price, kept so an override is visibly a deviation. */
  listPriceMinor: number;
  /** What will actually be charged. null while the field is being edited. */
  unitPriceMinor: number | null;
  /** null while the field is being edited - never coerced to a number. */
  quantity: number | null;
  availableStock: number;
}

export type DiscountType = 'none' | 'fixed' | 'percent';

export interface CartState {
  lines: CartLine[];
  discountType: DiscountType;
  /** Minor units for "fixed"; basis points for "percent". */
  discountValue: number;
}

const EMPTY: CartState = { lines: [], discountType: 'none', discountValue: 0 };

/**
 * Cart state for the POS.
 *
 * The important design decision: `quantity` and `unitPriceMinor` are
 * `number | null`, and `null` is a first-class, legal state meaning "the
 * cashier has cleared this field". Nothing in this hook ever replaces a null
 * with a substitute value. Validation happens once, at checkout, where an
 * incomplete line is reported rather than silently repaired.
 */
export function useCart() {
  const [state, setState] = React.useState<CartState>(EMPTY);

  const addVariant = React.useCallback((variant: PosVariant, quantity = 1) => {
    setState((prev) => {
      const existingIndex = prev.lines.findIndex((line) => line.variantId === variant.variantId);

      if (existingIndex >= 0) {
        const lines = [...prev.lines];
        const existing = lines[existingIndex];
        const nextQuantity = (existing.quantity ?? 0) + quantity;
        lines[existingIndex] = {
          ...existing,
          // Do not let the cart exceed what is on the shelf; the server checks
          // again at checkout, this is just early feedback.
          quantity: Math.min(nextQuantity, existing.availableStock),
        };
        return { ...prev, lines };
      }

      return {
        ...prev,
        lines: [
          ...prev.lines,
          {
            variantId: variant.variantId,
            productId: variant.productId,
            productName: variant.productName,
            variantName: variant.variantName,
            sku: variant.sku,
            imageUrl: variant.imageUrl,
            listPriceMinor: variant.sellingPriceMinor,
            unitPriceMinor: variant.sellingPriceMinor,
            quantity: Math.min(quantity, variant.stock),
            availableStock: variant.stock,
          },
        ],
      };
    });
  }, []);

  const setQuantity = React.useCallback((variantId: string, quantity: number | null) => {
    setState((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.variantId === variantId ? { ...line, quantity } : line)),
    }));
  }, []);

  const setUnitPrice = React.useCallback((variantId: string, unitPriceMinor: number | null) => {
    setState((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.variantId === variantId ? { ...line, unitPriceMinor } : line)),
    }));
  }, []);

  const removeLine = React.useCallback((variantId: string) => {
    setState((prev) => ({ ...prev, lines: prev.lines.filter((line) => line.variantId !== variantId) }));
  }, []);

  const setDiscount = React.useCallback((discountType: DiscountType, discountValue: number) => {
    setState((prev) => ({ ...prev, discountType, discountValue }));
  }, []);

  const clear = React.useCallback(() => setState(EMPTY), []);

  return { state, addVariant, setQuantity, setUnitPrice, removeLine, setDiscount, clear };
}

export interface CartTotals {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  itemCount: number;
  lineCount: number;
}

/**
 * Totals for display only. The server recomputes all of this from its own data
 * before writing a sale, so a tampered client cannot change what is charged.
 * Lines with a cleared quantity or price contribute 0 rather than NaN.
 */
export function computeTotals(state: CartState, taxRateBasisPoints = 0, taxEnabled = false): CartTotals & { taxMinor: number } {
  const subtotalMinor = state.lines.reduce((sum, line) => {
    if (line.quantity === null || line.unitPriceMinor === null) return sum;
    return sum + line.unitPriceMinor * line.quantity;
  }, 0);

  let discountMinor = 0;
  if (state.discountType === 'fixed') discountMinor = state.discountValue;
  else if (state.discountType === 'percent') discountMinor = Math.round((subtotalMinor * state.discountValue) / 10_000);
  discountMinor = Math.min(Math.max(0, discountMinor), subtotalMinor);

  const taxable = subtotalMinor - discountMinor;
  const taxMinor = taxEnabled ? Math.round((taxable * taxRateBasisPoints) / 10_000) : 0;

  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor: taxable + taxMinor,
    itemCount: state.lines.reduce((sum, line) => sum + (line.quantity ?? 0), 0),
    lineCount: state.lines.length,
  };
}

export interface CartValidationIssue {
  variantId: string;
  productName: string;
  message: string;
}

/**
 * The single place that decides whether a cart may be checked out.
 *
 * Mirrors the server rules exactly: whole positive quantities, positive prices,
 * and enough stock. An empty field is reported as "enter a quantity", never
 * quietly turned into a number.
 */
export function validateCart(state: CartState): CartValidationIssue[] {
  const issues: CartValidationIssue[] = [];

  if (state.lines.length === 0) {
    return [{ variantId: '', productName: '', message: 'The cart is empty' }];
  }

  for (const line of state.lines) {
    const label = `${line.productName} (${line.variantName})`;

    if (line.quantity === null) {
      issues.push({ variantId: line.variantId, productName: label, message: 'Enter a quantity' });
    } else if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      issues.push({ variantId: line.variantId, productName: label, message: 'Quantity must be at least 1' });
    } else if (line.quantity > line.availableStock) {
      issues.push({
        variantId: line.variantId,
        productName: label,
        message: `Only ${line.availableStock} in stock`,
      });
    }

    if (line.unitPriceMinor === null) {
      issues.push({ variantId: line.variantId, productName: label, message: 'Enter a price' });
    } else if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor <= 0) {
      issues.push({ variantId: line.variantId, productName: label, message: 'Price must be greater than zero' });
    }
  }

  return issues;
}
