import { del, get, getPaginated, patch, post } from './client';
import type {
  Medicine,
  MedicineBatch,
  MedicineDetail,
  MedicineInput,
  PharmacyDashboard,
  PharmacyReceipt,
  PharmacyReports,
  PharmacySale,
  StockMovement,
} from '@/types/pharmacy';
import type { SaleCustomerFields } from '@/features/customers/CustomerPicker';
import type { PosReturn, PosReturnInput } from '@/types/domain';

type Query = Record<string, unknown>;

export interface PharmacySaleInput extends SaleCustomerFields {
  items: { medicineId: string; quantity: number }[];
  payments: { method: string; amountMinor: number }[];
  discountMinor?: number;
  prescription?: { patientName: string; prescriberName: string; prescriptionNumber?: string; note?: string };
  /** The scanned card, and the points the cashier chose to redeem on it. */
  loyaltyMembershipId?: string;
  redeemPoints?: number;
  note?: string;
}

/**
 * Pharmacy POS API. Sale lines carry a medicine and a quantity only: the
 * server prices them from the catalogue and chooses the batches (earliest
 * expiry first, never expired).
 */
export const pharmacyApi = {
  medicines: (params?: Query) => getPaginated<Medicine>('/pharmacy/medicines', params),
  medicine: (id: string) => get<MedicineDetail>(`/pharmacy/medicines/${id}`),
  createMedicine: (body: MedicineInput) => post<Medicine>('/pharmacy/medicines', body),
  updateMedicine: (id: string, body: Partial<MedicineInput>) => patch<Medicine>(`/pharmacy/medicines/${id}`, body),
  removeMedicine: (id: string) => del<{ id: string }>(`/pharmacy/medicines/${id}`),

  receiveBatch: (
    medicineId: string,
    body: { batchNumber: string; expiryDate: string; quantity: number; costPriceMinor: number; supplierName?: string },
  ) => post<MedicineBatch>(`/pharmacy/medicines/${medicineId}/batches`, body),
  batches: (params?: Query) => getPaginated<MedicineBatch>('/pharmacy/batches', params),
  adjustBatch: (id: string, body: { type: 'adjust' | 'write_off'; quantityDelta: number; reason: string }) =>
    post<{ batch: MedicineBatch; previousOnHand: number }>(`/pharmacy/batches/${id}/adjust`, body),
  movements: (params?: Query) => getPaginated<StockMovement>('/pharmacy/movements', params),

  createSale: (body: PharmacySaleInput) => post<PharmacySale>('/pharmacy/sales', body),
  sales: (params?: Query) => getPaginated<PharmacySale>('/pharmacy/sales', params),
  sale: (id: string) => get<PharmacySale>(`/pharmacy/sales/${id}`),
  receipt: (id: string) => get<PharmacyReceipt>(`/pharmacy/sales/${id}/receipt`),
  voidSale: (id: string, reason: string) => post<PharmacySale>(`/pharmacy/sales/${id}/void`, { reason }),
  /** A return against a completed sale: the units go back to their own batches. */
  createReturn: (id: string, body: PosReturnInput) => post<PosReturn>(`/pharmacy/sales/${id}/return`, body),
  returns: (params?: Query) => getPaginated<PosReturn>('/pharmacy/returns', params),

  dashboard: (params?: Query) => get<PharmacyDashboard>('/pharmacy/dashboard', params),
  /** Advanced Analytics; the server refuses it on plans without the feature. */
  reports: (params?: Query) => get<PharmacyReports>('/pharmacy/reports', params),
};
