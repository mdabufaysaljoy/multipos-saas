import { get, getPaginated, http, post } from './client';

export interface PosImportColumn {
  field: string;
  label: string;
  required: boolean;
  aliases: string[];
  hint: string;
}

export interface PosImportCatalog {
  noun: { one: string; many: string };
  maxRows: number;
  columns: PosImportColumn[];
  limits: { maxRows: number; maxBytes: number };
  formats: string[];
}

export interface PosImportPreview {
  importId: string;
  filename: string;
  format: 'xlsx' | 'csv';
  noun: { one: string; many: string };
  headerRow: number;
  mapping: { header: string; field: string | null; ignored: boolean }[];
  unmappedHeaders: string[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    blankRows: number;
    itemsToCreate: number;
    categoriesToCreate: number;
    withOpeningStock: number;
  };
  newCategories: string[];
  preview: { rowNumber: number; name: string; detail: string; priceMinor: number; category: string; openingQuantity: number }[];
  errors: { rowNumber: number; itemName: string; field: string; message: string }[];
  errorsTruncated: boolean;
  expiresAt: string | null;
}

export interface PosImportResult {
  importId: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: { rowsProcessed: number; rowsImported: number; rowsFailed: number; rowsSkipped: number; itemsCreated: number; categories: number };
  failures: { itemName: string; rowNumbers: number[]; message: string }[];
  stopped: string | null;
}

export interface PosImportJob {
  _id: string;
  filename: string;
  status: 'completed' | 'failed' | 'cancelled' | 'pending';
  totalRows: number;
  rowsImported: number;
  rowsFailed: number;
  productsCreated: number;
  requestedByNameSnapshot: string;
  createdAt: string;
}

/**
 * The same import endpoints against whichever POS module is mounted. Clothing
 * keeps its own (`productImportApi`): its file describes products AND variants,
 * which the other three do not have.
 */
export const posImportsApi = (base: string) => ({
  columns: () => get<PosImportCatalog>(`${base}/imports/columns`),
  history: (params?: Record<string, unknown>) => getPaginated<PosImportJob>(`${base}/imports`, params),
  preview: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await http.post<{ success: true; data: PosImportPreview }>(`${base}/imports/preview`, form);
    return res.data.data;
  },
  commit: (importId: string, body: { skipInvalidRows: boolean }) => post<PosImportResult>(`${base}/imports/${importId}/commit`, body),
  cancel: (importId: string) => post<{ importId: string; status: string }>(`${base}/imports/${importId}/cancel`, {}),
});

export const shopImportsApi = posImportsApi('/supershop');
export const pharmacyImportsApi = posImportsApi('/pharmacy');
export const restaurantImportsApi = posImportsApi('/restaurant');
