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
  /** Hosted checkout aggregator (bKash, Nagad, Rocket, Upay, card) - see uddoktapay.provider.ts. */
  UDDOKTAPAY: 'uddoktapay',
  /** Out-of-band Send Money, proven by a payment SMS reported by a registered device. */
  SMS_VERIFIED: 'sms_verified',
} as const;
export type PaymentProviderKey = (typeof PAYMENT_PROVIDERS)[keyof typeof PAYMENT_PROVIDERS];

/**
 * What a payment is FOR. Previously carried in `metadata.purpose`; a first-class
 * field so reconciliation can filter and index by it. `wallet_topup` keeps the
 * exact string the existing activation path already looks for.
 */
export const PAYMENT_PURPOSES = {
  WALLET_TOPUP: 'wallet_topup',
  SUBSCRIPTION_PURCHASE: 'subscription_purchase',
  SUBSCRIPTION_RENEWAL: 'subscription_renewal',
  SUBSCRIPTION_UPGRADE: 'subscription_upgrade',
  ADDON_PURCHASE: 'addon_purchase',
  OTHER: 'other',
} as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[keyof typeof PAYMENT_PURPOSES];

/** How a payment was proven. Kept beside the status so reconciliation shows provenance. */
export const VERIFICATION_METHODS = ['provider_api', 'provider_webhook', 'sms_event', 'manual_admin', 'none'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
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
