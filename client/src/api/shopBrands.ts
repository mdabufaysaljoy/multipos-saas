import { del, get, patch, post } from './client';
import type { PosCategoryRow } from './posCategories';

/** One brand, as the Super Shop brand list reports it. */
export interface ShopBrandRow {
  /** Null for a name products already use that was never written down. */
  id: string | null;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

/**
 * Super Shop brands.
 *
 * The same four calls a department has, and deliberately the same row shape, so
 * the shared `PosCategoriesScreen` manages both without a second screen. The
 * only difference is the count's name - `productCount` here, `itemCount` there -
 * which is mapped on the way through rather than renamed on the wire.
 */
const toRow = (row: ShopBrandRow): PosCategoryRow => ({ ...row, itemCount: row.productCount });

export const shopBrandsApi = {
  list: async (includeInactive = false): Promise<PosCategoryRow[]> =>
    (await get<ShopBrandRow[]>('/supershop/brands', includeInactive ? { includeInactive: 'true' } : undefined)).map(toRow),
  search: (search: string) => get<ShopBrandRow[]>('/supershop/brands', { search }),
  create: async (body: { name: string; sortOrder?: number }) => toRow(await post<ShopBrandRow>('/supershop/brands', body)),
  update: async (id: string, body: { name?: string; isActive?: boolean; sortOrder?: number }) =>
    toRow(await patch<ShopBrandRow>(`/supershop/brands/${id}`, body)),
  remove: (id: string) => del<{ id: string }>(`/supershop/brands/${id}`),
};
