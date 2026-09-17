import { del, get, getPaginated, patch, post } from './client';
import type {
  ShopDashboard,
  ShopMovement,
  ShopProduct,
  ShopProductDetail,
  ShopProductInput,
  ShopReceipt,
  ShopReports,
  ShopSale,
} from '@/types/supershop';

type Query = Record<string, unknown>;

/**
 * Supershop POS API. Sale lines carry a product and a quantity (pieces, or
 * grams for weighed goods) only: the server prices them, works out VAT and
 * takes the stock.
 */
export const supershopApi = {
  products: (params?: Query) => getPaginated<ShopProduct>('/supershop/products', params),
  product: (id: string) => get<ShopProductDetail>(`/supershop/products/${id}`),
  lookup: (barcode: string) => get<ShopProduct>('/supershop/products/lookup', { barcode }),
  categories: () => get<string[]>('/supershop/categories'),
  createProduct: (body: ShopProductInput) => post<ShopProduct>('/supershop/products', body),
  updateProduct: (id: string, body: Partial<Omit<ShopProductInput, 'unitType'>>) => patch<ShopProduct>(`/supershop/products/${id}`, body),
  removeProduct: (id: string) => del<{ id: string }>(`/supershop/products/${id}`),

  receiveStock: (id: string, body: { quantity: number; costPriceMinor: number; supplierName?: string }) =>
    post<{ quantityOnHand: number; costPriceMinor: number }>(`/supershop/products/${id}/stock`, body),
  adjustStock: (id: string, body: { type: 'adjust' | 'write_off'; quantityDelta: number; reason: string }) =>
    post<{ stock: { quantityOnHand: number }; previousOnHand: number }>(`/supershop/products/${id}/adjust`, body),
  movements: (params?: Query) => getPaginated<ShopMovement>('/supershop/movements', params),

  createSale: (body: { items: { productId: string; quantity: number }[]; payments: { method: string; amountMinor: number }[]; discountMinor?: number }) =>
    post<ShopSale>('/supershop/sales', body),
  sales: (params?: Query) => getPaginated<ShopSale>('/supershop/sales', params),
  receipt: (id: string) => get<ShopReceipt>(`/supershop/sales/${id}/receipt`),
  voidSale: (id: string, reason: string) => post<ShopSale>(`/supershop/sales/${id}/void`, { reason }),

  dashboard: () => get<ShopDashboard>('/supershop/dashboard'),
  /** Advanced Analytics; the server refuses it on plans without the feature. */
  reports: (params?: Query) => get<ShopReports>('/supershop/reports', params),
};
