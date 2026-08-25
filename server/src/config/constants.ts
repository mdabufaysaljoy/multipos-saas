export const ROLES = {
  PLATFORM_ADMIN: 'platform_admin',
  ADMIN: 'admin',
  STAFF: 'staff',
} as const;
export type UserRole = (typeof ROLES)[keyof typeof ROLES];

export const SUBSCRIPTION_STATUS = {
  TRIAL: 'trial',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
} as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

/** Statuses that entitle a tenant to use the POS. */
export const USABLE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SUBSCRIPTION_STATUS.TRIAL,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE, // grace period - read/write still allowed
  SUBSCRIPTION_STATUS.CANCELLED, // cancelled but paid period not over yet
];

export const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYMENT_PROVIDERS = {
  MANUAL: 'manual',
  BKASH: 'bkash',
  NAGAD: 'nagad',
  BANK: 'bank',
} as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[keyof typeof PAYMENT_PROVIDERS];

export const BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** POS tender types. Configurable per store via Store.paymentMethods. */
export const PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVENTORY_TX_TYPES = {
  INITIAL_STOCK: 'INITIAL_STOCK',
  PURCHASE: 'PURCHASE',
  SALE: 'SALE',
  RETURN: 'RETURN',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  SALE_CANCELLED: 'SALE_CANCELLED',
} as const;
export type InventoryTxType = (typeof INVENTORY_TX_TYPES)[keyof typeof INVENTORY_TX_TYPES];

export const SALE_STATUS = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;
export type SaleStatus = (typeof SALE_STATUS)[keyof typeof SALE_STATUS];

export const SALE_PAYMENT_STATUS = ['paid', 'partial', 'unpaid'] as const;
export type SalePaymentStatus = (typeof SALE_PAYMENT_STATUS)[number];

/** Sentinel variant name used for products that have no real options. */
export const DEFAULT_VARIANT_NAME = 'Default';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
