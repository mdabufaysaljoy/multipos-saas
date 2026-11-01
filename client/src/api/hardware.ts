import { del, get, http, patch, post } from '@/api/client';

/**
 * The POS hardware catalogue: devices sold on their own, and the packages
 * built from them.
 *
 * Two surfaces over one catalogue. `publicHardwareApi` is what anonymous
 * visitors read and returns active rows only; `hardwareAdminApi` is the
 * platform admin's view and includes the inactive ones. Prices are always
 * integer minor units — the page formats them, nothing recomputes them.
 */

export const HARDWARE_CATEGORIES = [
  'computer',
  'scanner',
  'cash_drawer',
  'receipt_printer',
  'label_printer',
  'printer_combo',
  'accessory',
] as const;
export type HardwareCategory = (typeof HARDWARE_CATEGORIES)[number];

export type HardwareStatus = 'active' | 'inactive';

export interface HardwareItem {
  id: string;
  slug: string;
  name: string;
  category: HardwareCategory;
  summary: string;
  specs: string[];
  priceMinor: number;
  imageUrl: string;
  status: HardwareStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface HardwarePackageLine {
  itemSlug: string;
  quantity: number;
  item: HardwareItem;
}

export interface HardwarePackage {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  priceMinor: number;
  imageUrl: string;
  highlights: string[];
  bestFor: string[];
  featured: boolean;
  status: HardwareStatus;
  sortOrder: number;
  lines: HardwarePackageLine[];
  /** What the same parts cost bought one by one. */
  componentsTotalMinor: number;
  /** Positive only when the package is cheaper than its parts. */
  savingsMinor: number;
  /** Parts whose item is gone. Empty in normal operation. */
  missingItems: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HardwareCatalogue {
  currency: string;
  items: HardwareItem[];
  packages: HardwarePackage[];
}

export interface HardwareItemInput {
  slug?: string;
  name: string;
  category: HardwareCategory;
  summary: string;
  specs: string[];
  priceMinor: number;
  imageUrl: string;
  status: HardwareStatus;
  sortOrder: number;
}

export interface HardwarePackageInput {
  slug?: string;
  name: string;
  tagline: string;
  description: string;
  items: { itemSlug: string; quantity: number }[];
  priceMinor: number;
  imageUrl: string;
  highlights: string[];
  bestFor: string[];
  featured: boolean;
  status: HardwareStatus;
  sortOrder: number;
}

export const publicHardwareApi = {
  catalogue: () => get<HardwareCatalogue>('/public/hardware'),
};

const path = (slug: string) => encodeURIComponent(slug);

export const hardwareAdminApi = {
  catalogue: () => get<HardwareCatalogue>('/platform/hardware'),
  createItem: (body: HardwareItemInput) => post<HardwareItem>('/platform/hardware/items', body),
  updateItem: (slug: string, body: Partial<HardwareItemInput>) => patch<HardwareItem>(`/platform/hardware/items/${path(slug)}`, body),
  deleteItem: (slug: string) => del<HardwareItem>(`/platform/hardware/items/${path(slug)}`),
  createPackage: (body: HardwarePackageInput) => post<HardwarePackage>('/platform/hardware/packages', body),
  updatePackage: (slug: string, body: Partial<HardwarePackageInput>) =>
    patch<HardwarePackage>(`/platform/hardware/packages/${path(slug)}`, body),
  deletePackage: (slug: string) => del<HardwarePackage>(`/platform/hardware/packages/${path(slug)}`),
  /**
   * Catalogue art. Shares the platform branding uploader: a platform admin
   * belongs to no workspace, so the tenant `/uploads` route refuses them.
   */
  uploadImage: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await http.post<{ success: true; data: { url: string } }>('/platform/site/image', form);
    return res.data.data.url;
  },
};
