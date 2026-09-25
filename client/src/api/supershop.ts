import { del, get, getPaginated, patch, post } from './client';
import type {
  ShopDashboard,
  ShopInventorySummary,
  ShopMovement,
  ShopProduct,
  ShopProductDetail,
  ShopProductInput,
  ShopReceipt,
  ShopReports,
  ShopSale,
} from '@/types/supershop';
import type { SaleCustomerFields } from '@/features/customers/CustomerPicker';
import type { PosLedgerRow, PosReturn, PosReturnInput } from '@/types/domain';

type Query = Record<string, unknown>;

export interface ShopSaleInput extends SaleCustomerFields {
  items: { productId: string; quantity: number }[];
  payments: { method: string; amountMinor: number }[];
  discountMinor?: number;
  /** The scanned card, and the points the cashier chose to redeem on it. */
  loyaltyMembershipId?: string;
  redeemPoints?: number;
  note?: string;
}

/**
 * Supershop POS API. Sale lines carry a product and a quantity (pieces, or
 * grams for weighed goods) only: the server prices them, works out VAT and
 * takes the stock.
 */
export const supershopApi = {
  products: (params?: Query) => getPaginated<ShopProduct>('/supershop/products', params),
  product: (id: string) => get<ShopProductDetail>(`/supershop/products/${id}`),
  lookup: (barcode: string) => get<ShopProduct>('/supershop/products/lookup', { barcode }),
  /** The brands in use, for the till's brand filter. Free text on the product today. */
  brands: () => get<string[]>('/supershop/brands'),
  createProduct: (body: ShopProductInput) => post<ShopProduct>('/supershop/products', body),
  updateProduct: (id: string, body: Partial<Omit<ShopProductInput, 'unitType'>>) => patch<ShopProduct>(`/supershop/products/${id}`, body),
  removeProduct: (id: string) => del<{ id: string }>(`/supershop/products/${id}`),

  receiveStock: (id: string, body: { quantity: number; costPriceMinor: number; supplierName?: string }) =>
    post<{ quantityOnHand: number; costPriceMinor: number }>(`/supershop/products/${id}/stock`, body),
  adjustStock: (id: string, body: { type: 'adjust' | 'write_off'; quantityDelta: number; reason: string }) =>
    post<{ stock: { quantityOnHand: number }; previousOnHand: number }>(`/supershop/products/${id}/adjust`, body),
  movements: (params?: Query) => getPaginated<ShopMovement>('/supershop/movements', params),
  /** The branch's whole stock ledger, in the shape every vertical reports. */
  stockLedger: (params?: Query) => getPaginated<PosLedgerRow>('/supershop/stock-ledger', params),
  inventorySummary: () => get<ShopInventorySummary>('/supershop/inventory-summary'),

  createSale: (body: ShopSaleInput) => post<ShopSale>('/supershop/sales', body),
  sales: (params?: Query) => getPaginated<ShopSale>('/supershop/sales', params),
  receipt: (id: string) => get<ShopReceipt>(`/supershop/sales/${id}/receipt`),
  voidSale: (id: string, reason: string) => post<ShopSale>(`/supershop/sales/${id}/void`, { reason }),
  /** A return against a completed sale: chosen lines, money back on a tender. */
  createReturn: (id: string, body: PosReturnInput) => post<PosReturn>(`/supershop/sales/${id}/return`, body),
  returns: (params?: Query) => getPaginated<PosReturn>('/supershop/returns', params),

  dashboard: (params?: Query) => get<ShopDashboard>('/supershop/dashboard', params),
  /** Advanced Analytics; the server refuses it on plans without the feature. */
  reports: (params?: Query) => get<ShopReports>('/supershop/reports', params),
};
