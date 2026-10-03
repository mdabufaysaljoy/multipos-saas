import { del, get, patch, post } from './client';
import type { PosCategoryRow } from './posCategories';

interface PharmacyManufacturerRow {
  id: string | null;
  _id?: string;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  medicineCount: number;
}

const toRow = (row: PharmacyManufacturerRow): PosCategoryRow => ({
  ...row,
  id: row.id ?? row._id ?? null,
  itemCount: row.medicineCount ?? 0,
});

export const pharmacyManufacturersApi = {
  list: async (includeInactive = false): Promise<PosCategoryRow[]> =>
    (await get<PharmacyManufacturerRow[]>('/pharmacy/manufacturers', includeInactive ? { includeInactive: 'true' } : undefined)).map(toRow),
  search: (search: string) => get<PharmacyManufacturerRow[]>('/pharmacy/manufacturers', { search }),
  create: async (body: { name: string; sortOrder?: number }) => toRow(await post<PharmacyManufacturerRow>('/pharmacy/manufacturers', body)),
  update: async (id: string, body: { name?: string; isActive?: boolean; sortOrder?: number }) =>
    toRow(await patch<PharmacyManufacturerRow>(`/pharmacy/manufacturers/${id}`, body)),
  remove: (id: string) => del<{ id: string }>(`/pharmacy/manufacturers/${id}`),
};
