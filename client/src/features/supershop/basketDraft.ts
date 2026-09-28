import type { SelectedCustomer } from '@/features/customers/CustomerPicker';
import type { ShopProduct } from '@/types/supershop';

export type ShopDiscountMode = 'amount' | 'percent';

export interface ShopBasketDraft {
  cart: { product: ShopProduct; quantity: number }[];
  discountMode: ShopDiscountMode;
  discountAmountMinor: number | null;
  discountPercent: string;
  customer: SelectedCustomer | null;
  note: string;
}

const VERSION = 1;

export const emptyShopBasketDraft = (): ShopBasketDraft => ({
  cart: [],
  discountMode: 'amount',
  discountAmountMinor: 0,
  discountPercent: '',
  customer: null,
  note: '',
});

/** A till draft belongs to one user in one branch of one workspace. */
export const shopBasketDraftKey = (tenantId: string, storeId: string, userId: string) =>
  `multipos.supershop.basket.v${VERSION}.${tenantId}.${storeId}.${userId}`;

const isProductSnapshot = (value: unknown): value is ShopProduct => {
  if (!value || typeof value !== 'object') return false;
  const product = value as Partial<ShopProduct>;
  return (
    typeof product._id === 'string' &&
    typeof product.name === 'string' &&
    (product.unitType === 'each' || product.unitType === 'weight') &&
    Number.isSafeInteger(product.priceMinor) &&
    Number(product.priceMinor) >= 0 &&
    Number.isSafeInteger(product.vatRateBps) &&
    Number(product.vatRateBps) >= 0 &&
    Number(product.vatRateBps) <= 10_000
  );
};

const isCustomer = (value: unknown): value is SelectedCustomer => {
  if (!value || typeof value !== 'object') return false;
  const customer = value as Partial<SelectedCustomer>;
  return (
    (customer.id === undefined || typeof customer.id === 'string') &&
    typeof customer.name === 'string' &&
    typeof customer.phone === 'string' &&
    (customer.email === undefined || typeof customer.email === 'string')
  );
};

/** Invalid or old browser data is ignored; it must never break the till. */
export function loadShopBasketDraft(key: string): ShopBasketDraft {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null;
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.cart) || parsed.cart.length > 200)
      return emptyShopBasketDraft();

    const cart = parsed.cart
      .filter(
        (line): line is { product: ShopProduct; quantity: number } =>
          Boolean(line) &&
          typeof line === 'object' &&
          isProductSnapshot((line as { product?: unknown }).product) &&
          Number.isSafeInteger((line as { quantity?: unknown }).quantity) &&
          Number((line as { quantity?: unknown }).quantity) > 0,
      )
      .map((line) => ({ product: line.product, quantity: line.quantity }));

    return {
      cart,
      discountMode: parsed.discountMode === 'percent' ? 'percent' : 'amount',
      discountAmountMinor:
        Number.isSafeInteger(parsed.discountAmountMinor) && Number(parsed.discountAmountMinor) >= 0
          ? Number(parsed.discountAmountMinor)
          : 0,
      discountPercent: typeof parsed.discountPercent === 'string' ? parsed.discountPercent : '',
      customer:
        parsed.customer === null || parsed.customer === undefined
          ? null
          : isCustomer(parsed.customer)
            ? parsed.customer
            : null,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : '',
    };
  } catch {
    return emptyShopBasketDraft();
  }
}

export function saveShopBasketDraft(key: string, draft: ShopBasketDraft): void {
  try {
    if (draft.cart.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ version: VERSION, ...draft }));
  } catch {
    // Storage may be unavailable or full. The live till still keeps its basket.
  }
}
