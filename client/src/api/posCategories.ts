import { del, get, patch, post } from './client';

/** One department, as every POS type that keeps a name list reports it. */
export interface PosCategoryRow {
  /** Null for a name items already use that was never written down; it can still be renamed. */
  id: string | null;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  itemCount: number;
}

/**
 * The same four calls against whichever POS module is mounted: Super Shop,
 * Pharmacy and Restaurant all serve them at `<base>/categories`. Clothing keeps
 * its own `/categories` module, whose categories are entities with ids.
 */
export const posCategoriesApi = (base: string) => ({
  list: (includeInactive = false) => get<PosCategoryRow[]>(`${base}/categories`, includeInactive ? { includeInactive: 'true' } : undefined),
  create: (body: { name: string; sortOrder?: number }) => post<PosCategoryRow>(`${base}/categories`, body),
  update: (id: string, body: { name?: string; isActive?: boolean; sortOrder?: number }) => patch<PosCategoryRow>(`${base}/categories/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`${base}/categories/${id}`),
});

export const shopCategoriesApi = posCategoriesApi('/supershop');
export const pharmacyCategoriesApi = posCategoriesApi('/pharmacy');
export const restaurantCategoriesApi = posCategoriesApi('/restaurant');
