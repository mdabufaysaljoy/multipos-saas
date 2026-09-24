import type { PaymentTerm, SupplierType } from '@/types/domain';

/** One place for the wording, so the table, the form and the detail view agree. */
export const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  manufacturer: 'Manufacturer',
  wholesaler: 'Wholesaler',
  distributor: 'Distributor',
  importer: 'Importer',
  local: 'Local supplier',
  other: 'Other',
};

export const PAYMENT_TERM_LABELS: Record<PaymentTerm, string> = {
  cash: 'Cash',
  on_delivery: 'Due on delivery',
  net_7: '7 days',
  net_15: '15 days',
  net_30: '30 days',
  net_60: '60 days',
  other: 'Other (see note)',
};
