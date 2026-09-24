import { del, get, getPaginated, http, patch, post, postDownload } from './client';
import type { PaymentInstruction } from '@/features/billing/UpgradeDialog';
import type {
  TenderOption,
  CustomPaymentMethod,
  BranchReport,
  BreakdownReport,
  Category,
  Customer,
  CustomerReport,
  DashboardReport,
  InventoryReport,
  OverviewReport,
  ReturnReport,
  SalesProfitReport,
  StaffReportRow,
  InventoryRow,
  InventorySummary,
  ExportCatalog,
  ExportJob,
  ImportCatalog,
  Supplier,
  SupplierListItem,
  SupplierSummary,
  ImportPreview,
  ImportResult,
  ProductImportJob,
  LabelSettings,
  LedgerEntry,
  LoyaltyLookup,
  LoyaltyMember,
  LoyaltySummary,
  LoyaltyTransaction,
  PermissionGroup,
  PosVariant,
  Product,
  ProductVariant,
  ReceiptPayload,
  ReturnableSale,
  ReturnDoc,
  Role,
  Sale,
  StaffMember,
  StoreSettings,
  Subscription,
  SubscriptionPlan,
  MessagingStatus,
  SmsCampaign,
  SmsEstimate,
  SmsMessage,
  PlanOptionsResponse,
  TopUp,
  UpgradeRequest,
  WalletBreakdown,
  WalletTransaction,
} from '@/types/domain';
import type { AuthTokens, Session, VerificationSendResult, VerificationStatus } from '@/types/api';

type Query = Record<string, unknown>;

/**
 * Platform-admin payloads that have no client-side type yet.
 *
 * Deliberately loose and confined to the admin surface. It exists so the gap
 * is named in one place instead of scattered `any`s; give a payload a real type
 * when its screen is next worked on, and delete this alias once nothing uses it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above: tracked, admin-only
export type UntypedAdminPayload = Record<string, any>;

/** One of several logins that share an email, offered only after the password matched. */
export interface LoginChoice {
  userId: string;
  workspaceName: string;
  vertical: string | null;
  role: string;
  roleLabel: string;
  lastLoginAt: string | null;
}

export interface LoginSelection {
  requiresWorkspaceSelection: true;
  selectionToken: string;
  choices: LoginChoice[];
}

export const authApi = {
  login: (body: { email: string; password: string }) =>
    post<(Session & { tokens: AuthTokens }) | LoginSelection>('/auth/login', body),
  /** Completes a sign-in that matched more than one login. */
  selectLogin: (body: { selectionToken: string; userId: string }) =>
    post<Session & { tokens: AuthTokens }>('/auth/login/select', body),
  register: (body: { businessName: string; name: string; email: string; phone?: string; password: string; vertical?: string }) =>
    post<Session & { tokens: AuthTokens }>('/auth/register', body),
  me: () => get<Session>('/auth/me'),
  workspaces: () => get<Session['workspaces']>('/auth/workspaces'),
  /** The server decides whether the switch is allowed; this only asks. */
  switchWorkspace: (workspaceId: string) =>
    post<Session & { tokens: AuthTokens }>('/auth/switch-workspace', { workspaceId }),
  logout: () => post<{ message: string }>('/auth/logout'),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    post<{ message: string }>('/auth/change-password', body),
};

export interface WorkspaceVerticalOption {
  vertical: string;
  label: string;
  description?: string;
  icon?: string;
  highlights?: string[];
  /** Whether a workspace of this vertical can be created today. */
  available: boolean;
}

export interface CreateWorkspaceResult {
  workspace: { id: string; name: string; vertical: string; status: string };
  trial: { started: true; days: number } | { started: false; reason: 'already_used' | 'not_offered' | 'no_trial_plan' };
}

export const workspaceApi = {
  verticals: () => get<WorkspaceVerticalOption[]>('/workspaces/verticals'),
  /** The server decides ownership, the account and whether a trial applies. */
  create: (body: { businessName: string; vertical: string; contactPhone?: string; contactEmail?: string }) => post<CreateWorkspaceResult>('/workspaces', body),
};

/** The tenders a workspace takes: the six built-ins plus its own. */
export const paymentMethodApi = {
  list: () => get<TenderOption[]>('/payment-methods'),
  create: (body: { label: string; key?: string; sortOrder?: number }) => post<CustomPaymentMethod>('/payment-methods', body),
  update: (id: string, body: { label?: string; isActive?: boolean; sortOrder?: number }) => patch<CustomPaymentMethod>(`/payment-methods/${id}`, body),
  remove: (id: string) => del<{ removed: boolean }>(`/payment-methods/${id}`),
};

export const storeApi = {
  list: () => get<StoreSettings[]>('/stores'),
  create: (body: Record<string, unknown>) => post<StoreSettings>('/stores', body),
  current: () => get<StoreSettings>('/stores/current'),
  /** Lightweight config every till can read, regardless of settings.view. */
  posConfig: () =>
    get<
      Pick<StoreSettings, '_id' | 'name' | 'currency' | 'paymentMethods' | 'tax' | 'receipt' | 'lowStockThreshold' | 'logoUrl' | 'receiptLogoUrl'> & {
        /** The enabled tenders with the workspace's own names for them. */
        tenders?: TenderOption[];
        loyalty?: { available: boolean; pointValueMinor: number; earnSpendMinor: number; membershipFeeMinor: number };
        labels?: LabelSettings;
      }
    >('/stores/pos-config'),
  updateCurrent: (body: Record<string, unknown>) => patch<StoreSettings>('/stores/current', body),
  update: (id: string, body: Record<string, unknown>) => patch<StoreSettings>(`/stores/${id}`, body),
  remove: (id: string) =>
    del<{ id: string; softDeleted: boolean; historicalSalesPreserved: number; staffReassigned: number }>(`/stores/${id}`),
  makeDefault: (id: string) => post<StoreSettings>(`/stores/${id}/make-default`),
};

export const categoryApi = {
  list: (params?: Query) => getPaginated<Category>('/categories', params),
  create: (body: Record<string, unknown>) => post<Category>('/categories', body),
  update: (id: string, body: Record<string, unknown>) => patch<Category>(`/categories/${id}`, body),
  remove: (id: string) => del<{ id: string; detachedProducts: number }>(`/categories/${id}`),
};

export const productApi = {
  list: (params?: Query) => getPaginated<Product>('/products', params),
  get: (id: string) => get<Product>(`/products/${id}`),
  create: (body: Record<string, unknown>) => post<Product>('/products', body),
  update: (id: string, body: Record<string, unknown>) => patch<Product>(`/products/${id}`, body),
  remove: (id: string) => del<{ id: string; historicalSalesPreserved: number }>(`/products/${id}`),
  posSearch: (params: Query) => get<PosVariant[]>('/products/pos-search', params),
  /** The POS product grid: one page of products (with all their variants), filtered by search and category. */
  posCatalog: (params: Query) =>
    get<{ items: PosVariant[]; page: number; limit: number; hasMore: boolean }>('/products/pos-catalog', params),
  generateBarcode: () => post<{ barcode: string }>('/products/barcode/generate'),
  addVariant: (productId: string, body: Record<string, unknown>) =>
    post<ProductVariant>(`/products/${productId}/variants`, body),
  updateVariant: (productId: string, variantId: string, body: Record<string, unknown>) =>
    patch<ProductVariant>(`/products/${productId}/variants/${variantId}`, body),
  removeVariant: (productId: string, variantId: string) =>
    del<{ id: string }>(`/products/${productId}/variants/${variantId}`),
};

export const inventoryApi = {
  list: (params?: Query) => getPaginated<InventoryRow>('/inventory', params),
  summary: () => get<InventorySummary>('/inventory/summary'),
  ledger: (params?: Query) => getPaginated<LedgerEntry>('/inventory/ledger', params),
  adjust: (body: { variantId: string; mode: 'set' | 'delta'; value: number; reason: string }) =>
    post<{ previousStock: number; newStock: number }>('/inventory/adjust', body),
};

export const customerApi = {
  list: (params?: Query) => getPaginated<Customer>('/customers', params),
  get: (id: string) => get<Customer>(`/customers/${id}`),
  create: (body: Record<string, unknown>) => post<Customer>('/customers', body),
  update: (id: string, body: Record<string, unknown>) => patch<Customer>(`/customers/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`/customers/${id}`),
};

/** Proving an email address or a phone number with a one-time code. */
export const verificationApi = {
  status: () => get<VerificationStatus>('/auth/verification'),
  send: (channel: 'email' | 'phone') => post<VerificationSendResult>('/auth/verification/send', { channel }),
  confirm: (channel: 'email' | 'phone', code: string) => post<VerificationStatus>('/auth/verification/confirm', { channel, code }),
};

export const supplierApi = {
  summary: () => get<SupplierSummary>('/suppliers/summary'),
  list: (params?: Query) => getPaginated<SupplierListItem>('/suppliers', params),
  get: (id: string) => get<Supplier>(`/suppliers/${id}`),
  create: (body: Record<string, unknown>) => post<Supplier>('/suppliers', body),
  update: (id: string, body: Record<string, unknown>) => patch<Supplier>(`/suppliers/${id}`, body),
  setStatus: (id: string, isActive: boolean) => post<Supplier>(`/suppliers/${id}/status`, { isActive }),
  remove: (id: string) => del<{ id: string }>(`/suppliers/${id}`),
};

export const exportApi = {
  /** The server-side registry of exportable datasets and formats. */
  datasets: () => get<ExportCatalog>('/exports/datasets'),
  history: (params?: Query) => getPaginated<ExportJob>('/exports', params),
  /** Streams the generated file; the server assigns the filename. */
  run: (body: Record<string, unknown>) => postDownload('/exports', body),
};

/**
 * Bulk product import. Two steps on purpose: the file is validated and
 * previewed first, and nothing is created until the preview is confirmed.
 */
export const productImportApi = {
  columns: () => get<ImportCatalog>('/products/import/columns'),
  history: (params?: Query) => getPaginated<ProductImportJob>('/products/import', params),
  preview: async (file: File, options: { createMissingCategories: boolean }) => {
    const form = new FormData();
    form.append('file', file);
    form.append('createMissingCategories', String(options.createMissingCategories));
    const res = await http.post<{ success: true; data: ImportPreview }>('/products/import/preview', form);
    return res.data.data;
  },
  commit: (importId: string, body: { skipInvalidRows: boolean }) => post<ImportResult>(`/products/import/${importId}/commit`, body),
  cancel: (importId: string) => post<{ importId: string; status: string }>(`/products/import/${importId}/cancel`, {}),
};

export const loyaltyApi = {
  summary: () => get<LoyaltySummary>('/loyalty/summary'),
  lookup: (code: string) => get<LoyaltyLookup>('/loyalty/lookup', { code }),
  list: (params?: Query) => getPaginated<LoyaltyMember>('/loyalty/memberships', params),
  get: (id: string) => get<LoyaltyMember>(`/loyalty/memberships/${id}`),
  forCustomer: (customerId: string) => get<LoyaltyMember | null>(`/loyalty/customers/${customerId}`),
  history: (id: string, params?: Query) => getPaginated<LoyaltyTransaction>(`/loyalty/memberships/${id}/history`, params),
  issue: (body: Record<string, unknown>) => post<LoyaltyMember>('/loyalty/memberships', body),
  setStatus: (id: string, body: { status: 'active' | 'inactive'; reason: string }) => post<LoyaltyMember>(`/loyalty/memberships/${id}/status`, body),
  adjust: (id: string, body: { points: number; reason: string; idempotencyKey: string }) => post<LoyaltyMember>(`/loyalty/memberships/${id}/adjust`, body),
};

export const saleApi = {
  list: (params?: Query) => getPaginated<Sale>('/sales', params),
  get: (id: string) => get<Sale>(`/sales/${id}`),
  create: (body: Record<string, unknown>) => post<Sale>('/sales', body),
  receipt: (id: string) => get<ReceiptPayload>(`/sales/${id}/receipt`),
  cancel: (id: string, reason: string) => post<Sale>(`/sales/${id}/cancel`, { reason }),
};

export const returnApi = {
  list: (params?: Query) => getPaginated<ReturnDoc>('/returns', params),
  get: (id: string) => get<ReturnDoc>(`/returns/${id}`),
  returnable: (saleId: string) => get<ReturnableSale>(`/returns/returnable/${saleId}`),
  create: (body: Record<string, unknown>) => post<ReturnDoc>('/returns', body),
};

export const staffApi = {
  list: (params?: Query) => getPaginated<StaffMember>('/staff', params),
  get: (id: string) => get<StaffMember>(`/staff/${id}`),
  create: (body: Record<string, unknown>) => post<StaffMember>('/staff', body),
  update: (id: string, body: Record<string, unknown>) => patch<StaffMember>(`/staff/${id}`, body),
  resetPassword: (id: string, newPassword: string) =>
    post<{ message: string }>(`/staff/${id}/reset-password`, { newPassword }),
  remove: (id: string) => del<{ id: string }>(`/staff/${id}`),
};

/** People from other workspaces of the account. Always about the active workspace. */
export const memberApi = {
  list: () => get<import('@/types/domain').WorkspaceMemberRow[]>('/staff/members'),
  add: (body: { email: string; roleId?: string | null; extraPermissions?: string[] }) =>
    post<import('@/types/domain').WorkspaceMemberRow>('/staff/members', body),
  update: (id: string, body: Record<string, unknown>) =>
    patch<import('@/types/domain').WorkspaceMemberRow>(`/staff/members/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`/staff/members/${id}`),
};

export const roleApi = {
  list: () => get<Role[]>('/roles'),
  catalog: () => get<PermissionGroup[]>('/roles/permissions/catalog'),
  create: (body: Record<string, unknown>) => post<Role>('/roles', body),
  update: (id: string, body: Record<string, unknown>) => patch<Role>(`/roles/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`/roles/${id}`),
};

export const reportApi = {
  /** Legacy combined endpoint, still used by nothing but kept for compatibility. */
  dashboard: (params?: Query) => get<DashboardReport>('/reports/dashboard', params),
  /** Quick business overview - powers the Dashboard. */
  overview: (params?: Query) => get<OverviewReport>('/reports/overview', params),
  /** Detailed analysis - powers Advanced Analytics (Showroom and Brand only). */
  sales: (params?: Query) => get<SalesProfitReport>('/reports/sales', params),
  breakdown: (params?: Query) => get<BreakdownReport>('/reports/breakdown', params),
  payments: (params?: Query) => get<{ rows: { method: string; amountMinor: number; count: number }[] }>('/reports/payments', params),
  returns: (params?: Query) => get<ReturnReport>('/reports/returns', params),
  staff: (params?: Query) => get<{ rows: StaffReportRow[] }>('/reports/staff', params),
  customers: (params?: Query) => get<CustomerReport>('/reports/customers', params),
  inventory: (params?: Query) => get<InventoryReport>('/reports/inventory', params),
  branches: (params?: Query) => get<BranchReport>('/reports/branches', params),
};

export const billingApi = {
  plans: () => get<SubscriptionPlan[]>('/plans'),
  /** Plans with limits and prices resolved for one POS vertical. */
  plansFor: (vertical: string) => get<SubscriptionPlan[]>('/plans', { vertical }),
  current: () =>
    get<{
      subscription: Subscription | null;
      entitlement: import('@/types/api').Entitlement;
      usage: {
        /** The vertical these meters were counted in. */
        vertical?: string;
        products: number;
        staff: number;
        stores: number;
        customers: number;
        monthlySales: number;
        storageBytes: number;
      };
    }>('/subscriptions/current'),
  history: () =>
    get<{ subscriptions: Subscription[]; events: SubscriptionEventRow[]; payments: unknown[] }>('/subscriptions/history'),
  cancel: (body: { immediate: boolean; reason?: string }) => post<Subscription>('/subscriptions/cancel', body),
  planOptions: () => get<PlanOptionsResponse>('/subscriptions/plan-options'),
  reactivate: () => post<Subscription>('/subscriptions/reactivate'),
  providers: () => get<{ name: string; displayName: string }[]>('/payments/providers'),
  /** Opens an online payment for a plan; the browser is then sent to the provider's page. */
  checkout: (body: { planId: string; provider: string }) =>
    post<{ paymentId: string; redirectUrl: string | null; status: string }>('/payments/checkout', body),
  /** Asks the server to confirm a payment with the provider. */
  verifyPayment: (paymentId: string) => post<{ _id: string; status: string }>('/payments/verify', { paymentId }),
  submitUpgrade: (body: Record<string, unknown>) => post<UpgradeRequest>('/subscriptions/upgrade-request', body),
  upgradeRequests: () => get<UpgradeRequest[]>('/subscriptions/upgrade-requests'),
  paymentInstructions: () =>
    get<{ instructions: PaymentInstruction[]; supportEmail: string; supportPhone: string }>(
      '/subscriptions/payment-instructions',
    ),
  cancelUpgrade: (id: string) => post<UpgradeRequest>(`/subscriptions/upgrade-requests/${id}/cancel`),
  /** What a plan costs this workspace, priced by the server. Buys nothing. */
  purchaseQuote: (body: { plan: string; billingCycle: 'monthly' | 'annual'; couponCode?: string }) =>
    post<PurchaseQuote>('/subscriptions/purchase/quote', body),
  /** Buys a plan. The body names a plan, a cycle and a method - never an amount. */
  purchase: (body: PurchaseBody) => post<PurchaseResult>('/subscriptions/purchase', body),
  renewal: () => get<RenewalInfo>('/subscriptions/renewal'),
  /** Automatic renewal from the account wallet, at the price in effect when it renews. */
  setAutoRenew: (enabled: boolean) => post<RenewalInfo>('/subscriptions/auto-renew', { enabled }),
  /** The plan to renew into at the end of the period; nothing changes before then. */
  scheduleChange: (body: { plan: string; billingCycle: 'monthly' | 'annual' }) =>
    post<RenewalInfo & { kind: string; breaches: { resource: string; label: string; excess: number; action: string }[] }>(
      '/subscriptions/scheduled-change',
      body,
    ),
  cancelScheduledChange: () => del<RenewalInfo>('/subscriptions/scheduled-change'),
};

export interface RenewalInfo {
  subscription: null | {
    id: string;
    status: string;
    planCode: string | null;
    planName: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    autoRenew: boolean;
    renewWith: 'wallet' | null;
    cancelAtPeriodEnd: boolean;
    failedRenewalAttempts: number;
    lastRenewalAttemptAt: string | null;
    /** Until when an overdue period stays usable while renewal is retried; null when not in grace. */
    graceEndsAt: string | null;
    /** Whether anything will renew this automatically (wallet auto-renew is on). */
    renewsAutomatically: boolean;
    manageable: boolean;
  };
  renewalWindowOpen: boolean;
  nextRenewal: null | {
    planId: string;
    code: string;
    name: string;
    catalogPlanCode: string | null;
    billingCycle: 'monthly' | 'annual';
    amountMinor: number | null;
    currency: string;
    available: boolean;
  };
  scheduledChange: null | {
    planCode: string;
    planName: string;
    catalogPlanCode: string | null;
    billingCycle: string;
    requestedAt: string;
    requestedByNameSnapshot: string;
    /** False when automatic renewal is off: the change then only applies if the owner renews. */
    appliesAutomatically: boolean;
  };
}

export interface PurchaseQuote {
  plan: { code: string; name: string; tier: number };
  billingCycle: 'monthly' | 'annual';
  posType: string;
  currency: string;
  listPriceMinor: number;
  discountMinor: number;
  payableMinor: number;
  paidMonths: number;
  freeMonths: number;
  savingsMinor: number;
  transition: { kind: string; currentPlanCode: string | null };
  paymentMethods: { wallet: boolean; online: string[]; manual: string[] };
  /** Credit for unused time on the current paid period, already taken off `payableMinor`. */
  proration: null | {
    sourcePlanCode: string;
    creditMinor: number;
    appliedMinor: number;
    walletRefundMinor: number;
    remainingMinutes: number;
    periodMinutes: number;
  };
  walletRefundMinor: number;
}

type PurchaseTarget = { plan: string; billingCycle: 'monthly' | 'annual'; couponCode?: string; idempotencyKey?: string };
export type PurchaseBody =
  | (PurchaseTarget & { paymentMethod: 'wallet'; note?: string })
  | (PurchaseTarget & { paymentMethod: 'online'; provider: 'bkash' })
  | (PurchaseTarget & { paymentMethod: 'manual'; manualMethod: 'bkash' | 'nagad' | 'bank'; senderNumber: string; transactionId: string; note?: string });

export type PurchaseResult =
  | { method: 'wallet' | 'manual'; request: UpgradeRequest; replayed: boolean }
  | { method: 'online'; paymentId: string; redirectUrl: string | null; status: string; amountMinor: number; currency: string; replayed: boolean };

export interface UsageCharge {
  _id: string;
  tenantId: string;
  accountId: string | null;
  service: 'sms' | 'email' | 'ai' | 'storage';
  unit: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: 'pending' | 'charged' | 'partially_refunded' | 'refunded' | 'failed';
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  performedByNameSnapshot: string;
  createdAt: string;
}

export interface UsageSummaryRow {
  service: UsageCharge['service'];
  label: string;
  unit: string;
  charges: number;
  quantity: number;
  chargedMinor: number;
  refundedMinor: number;
  netMinor: number;
}

export const walletApi = {
  usage: (params?: Query) =>
    get<{ items: UsageCharge[]; summary: UsageSummaryRow[]; page: number; limit: number; total: number }>('/wallet/usage', params),
  usagePrices: () =>
    get<{ service: UsageCharge['service']; label: string; unit: string; unitPriceMinor: number; currency: string }[]>('/wallet/usage/prices'),
  balance: () =>
    get<{ balanceMinor: number; currency: string; lifetimeCreditedMinor: number; lifetimeDebitedMinor: number; isFrozen: boolean }>(
      '/wallet',
    ),
  transactions: (params?: Query) => getPaginated<WalletTransaction>('/wallet/transactions', params),
  breakdown: (params?: Query) => get<WalletBreakdown>('/wallet/breakdown', params),
  topUps: (params?: Query) => getPaginated<TopUp>('/wallet/top-ups', params),
  requestTopUp: (body: Record<string, unknown>) => post<TopUp>('/wallet/top-ups', body),
  cancelTopUp: (id: string) => post<TopUp>(`/wallet/top-ups/${id}/cancel`),
};

export const messagingApi = {
  status: () => get<MessagingStatus>('/messaging/status'),
  estimate: (params: Query) => get<SmsEstimate>('/messaging/estimate', params),
  sendOne: (body: Record<string, unknown>) => post<SmsMessage>('/messaging/sms', body),
  sendCampaign: (body: Record<string, unknown>) => post<SmsCampaign>('/messaging/campaigns', body),
  sendEmailCampaign: (body: Record<string, unknown>) => post<SmsCampaign>('/messaging/email-campaigns', body),
  history: (params?: Query) => getPaginated<SmsMessage>('/messaging/sms', params),
  campaigns: (params?: Query) => getPaginated<SmsCampaign>('/messaging/campaigns', params),
};

/** A payment as the platform's payment operations queue shows it. */
export interface PlatformPaymentRow {
  _id: string;
  tenantId: { _id: string; name: string; slug: string } | null;
  planId: { _id: string; name: string; code: string } | null;
  amountMinor: number;
  currency: string;
  provider: string;
  providerTransactionId: string | null;
  providerReference: string | null;
  status: string;
  failureReason: string | null;
  paidAt: string | null;
  refundedMinor?: number;
  review?: {
    required: boolean;
    reason: string;
    flaggedAt: string | null;
    resolvedAt: string | null;
    resolvedByNameSnapshot: string;
    resolutionNote: string;
  };
  metadata?: Record<string, unknown>;
  subscriptionAdjustment?: {
    action: 'end_now' | 'shorten';
    until: string;
    previousEnd: string;
    reason: string;
    at: string;
    byNameSnapshot: string;
  } | null;
  createdAt: string;
}

/** A plan as the platform admin plan list returns it. */
export interface AdminPlan extends SubscriptionPlan {
  isPublic: boolean;
  verticalOverrides?: { vertical: string; isAvailable: boolean; features: Record<string, boolean>; limits: Record<string, number> }[];
  /** Subscriptions currently giving a workspace access on this plan. */
  runningSubscriptions: number;
}

export interface PlanUsage {
  plan: { _id: string; code: string; name: string; isActive: boolean; posProductCode?: string | null };
  subscriptionsByStatus: Record<string, number>;
  runningCount: number;
  pendingPayments: number;
  pendingRequests: number;
  workspaces: {
    subscriptionId: string;
    tenantId: string | null;
    name: string;
    vertical: string;
    workspaceStatus: string | null;
    status: string;
    currentPeriodEnd: string;
    priceMinor: number | null;
    currency: string | null;
  }[];
}

/** A platform POS product definition, as platform admins see it. */
export interface PosProduct {
  id: string;
  code: string;
  name: string;
  description: string;
  status: 'active' | 'inactive';
  icon: string;
  configuration: { sortOrder: number; highlights: string[] };
  /** A POS module exists in the codebase, so workspaces of this type can run. */
  moduleAvailable: boolean;
  isDefault: boolean;
  workspaceCount: number;
  /** Plans sold only to this POS type. */
  planCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionEventRow {
  _id: string;
  type: string;
  message: string;
  createdAt: string;
}

export interface PaymentAlertResult {
  status: 'disabled' | 'nothing_to_send' | 'no_recipients' | 'not_configured' | 'failed' | 'sent';
  review: number;
  stale: number;
  recipients: number;
  delivered: number;
  error?: string;
}

export interface PlatformPaymentDetail {
  payment: PlatformPaymentRow & {
    refunds: { _id: string; amountMinor: number; method: string; reference: string; reason: string; at: string; byNameSnapshot: string }[];
    userId: { name: string; email: string } | null;
  };
  subscription: { status: string; planSnapshot?: { name: string; code: string }; currentPeriodEnd: string } | null;
  events: { _id: string; type: string; message: string; createdAt: string }[];
  audit: { _id: string; action: string; actorNameSnapshot: string; createdAt: string; newValue?: Record<string, unknown> }[];
  refundableMinor: number;
  remainingRefundableMinor: number;
  provider: { name: string; configured: boolean; canRecheck: boolean };
  /** True while the subscription this payment opened is still the workspace's current one. */
  subscriptionIsCurrent: boolean;
}

export const platformApi = {
  overview: () => get<Record<string, unknown>>('/platform/overview'),
  tenants: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/tenants', params),
  tenant: (id: string) => get<Record<string, unknown>>(`/platform/tenants/${id}`),
  setTenantStatus: (id: string, body: { status: 'active' | 'suspended'; reason?: string }) =>
    patch<Record<string, unknown>>(`/platform/tenants/${id}/status`, body),
  subscriptions: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/subscriptions', params),
  assignSubscription: (body: Record<string, unknown>) => post<Subscription>('/platform/subscriptions', body),
  extendSubscription: (id: string, body: Record<string, unknown>) =>
    post<Subscription>(`/platform/subscriptions/${id}/extend`, body),
  setSubscriptionStatus: (id: string, body: Record<string, unknown>) =>
    patch<Subscription>(`/platform/subscriptions/${id}/status`, body),
  payments: (params?: Query) => getPaginated<PlatformPaymentRow>('/platform/payments', params),
  paymentSummary: () =>
    get<{ review: number; pending: number; stalePending: number; failedLastDay: number }>('/platform/payments/summary'),
  payment: (id: string) => get<PlatformPaymentDetail>(`/platform/payments/${id}`),
  recheckPayment: (id: string) =>
    post<{ outcome: string; reason?: string; payment: PlatformPaymentRow }>(`/platform/payments/${id}/recheck`, {}),
  markPaymentReceived: (id: string, body: { amountReceivedMinor: number; reference: string; note: string }) =>
    post<{ outcome: string; payment: PlatformPaymentRow }>(`/platform/payments/${id}/mark-paid`, body),
  recordRefund: (id: string, body: { amountMinor: number; method: string; reference: string; reason: string }) =>
    post<PlatformPaymentRow>(`/platform/payments/${id}/refunds`, body),
  resolvePaymentReview: (id: string, note: string) =>
    post<PlatformPaymentRow>(`/platform/payments/${id}/resolve-review`, { note }),
  adjustSubscriptionAfterRefund: (id: string, body: { action: 'end_now' | 'shorten'; until?: string; reason: string }) =>
    post<{ payment: PlatformPaymentRow; subscription: { status: string; currentPeriodEnd: string } }>(
      `/platform/payments/${id}/subscription-action`,
      body,
    ),
  sendPaymentAlerts: () => post<PaymentAlertResult>('/platform/payments/alerts/send-now', {}),
  posProducts: () => get<PosProduct[]>('/platform/pos-products'),
  posProduct: (code: string) => get<PosProduct>(`/platform/pos-products/${encodeURIComponent(code)}`),
  setPosProductStatus: (code: string, status: PosProduct['status']) =>
    patch<PosProduct>(`/platform/pos-products/${encodeURIComponent(code)}`, { status }),
  upgradeRequests: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/upgrade-requests', params),
  topUps: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/top-ups', params),
  approveTopUp: (id: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/top-ups/${id}/approve`, body),
  rejectTopUp: (id: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/top-ups/${id}/reject`, body),
  integrations: () => get<UntypedAdminPayload>('/platform/integrations'),
  analytics: (params?: Query) => get<UntypedAdminPayload>('/platform/analytics', params),
  workspaceLeaderboard: (params?: Query) => get<UntypedAdminPayload>('/platform/analytics/workspaces', params),
  /** Platform settings. Secrets are never included in the response. */
  settings: () => get<UntypedAdminPayload>('/platform/settings'),
  updateSettings: (body: Record<string, unknown>) => patch<Record<string, unknown>>('/platform/settings', body),
  testSmtp: () => post<{ ok: boolean; error?: string }>('/platform/integrations/smtp/test'),
  /** Verifies the stored gateway key by reading the account balance. */
  testSms: () =>
    post<{
      ok: boolean;
      provider?: string;
      balanceMinor?: number | null;
      currency?: string | null;
      message: string;
    }>('/platform/integrations/sms/test'),
  auditLog: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/audit-log', params),

  /** Wallet management for a named workspace. */
  tenantWallet: (tenantId: string) =>
    get<{
      wallet: { balanceMinor: number; currency: string; lifetimeCreditedMinor: number; lifetimeDebitedMinor: number; isFrozen: boolean };
      transactions: WalletTransaction[];
    }>(`/platform/tenants/${tenantId}/wallet`),
  adjustWallet: (tenantId: string, body: { direction: 'credit' | 'debit'; amountMinor: number; reason: string }) =>
    post<{ transaction: WalletTransaction; balanceMinor: number }>(`/platform/tenants/${tenantId}/wallet/adjust`, body),
  unassignedUsers: () => get<{ _id: string; name: string; email: string }[]>('/platform/users/unassigned'),
  updateUser: (id: string, body: Record<string, unknown>) => patch<Record<string, unknown>>(`/platform/users/${id}`, body),
  createWorkspace: (body: Record<string, unknown>) => post<Record<string, unknown>>('/platform/workspaces', body),

  /** Workspace-scoped management. The tenant is always explicit in the URL. */
  ws: (tenantId: string) => ({
    overview: () => get<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/overview`),
    analytics: (params?: Query) => get<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/analytics`, params),
    stores: () => get<UntypedAdminPayload[]>(`/platform/workspaces/${tenantId}/stores`),
    createStore: (body: Record<string, unknown>) => post<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/stores`, body),
    updateStore: (id: string, body: Record<string, unknown>) => patch<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/stores/${id}`, body),
    deleteStore: (id: string) => del<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/stores/${id}`),
    makeDefaultStore: (id: string) => post<UntypedAdminPayload>(`/platform/workspaces/${tenantId}/stores/${id}/make-default`),
    products: (params?: Query) => getPaginated<Product>(`/platform/workspaces/${tenantId}/products`, params),
    createProduct: (body: Record<string, unknown>) => post<Product>(`/platform/workspaces/${tenantId}/products`, body),
    updateProduct: (id: string, body: Record<string, unknown>) => patch<Product>(`/platform/workspaces/${tenantId}/products/${id}`, body),
    deleteProduct: (id: string) => del<Record<string, unknown>>(`/platform/workspaces/${tenantId}/products/${id}`),
    generateBarcode: () => post<{ barcode: string }>(`/platform/workspaces/${tenantId}/products/barcode/generate`),
    categories: (params?: Query) => getPaginated<Category>(`/platform/workspaces/${tenantId}/categories`, params),
    createCategory: (body: Record<string, unknown>) => post<Category>(`/platform/workspaces/${tenantId}/categories`, body),
    updateCategory: (id: string, body: Record<string, unknown>) => patch<Category>(`/platform/workspaces/${tenantId}/categories/${id}`, body),
    deleteCategory: (id: string) => del<Record<string, unknown>>(`/platform/workspaces/${tenantId}/categories/${id}`),
    staff: (params?: Query) => getPaginated<StaffMember>(`/platform/workspaces/${tenantId}/staff`, params),
    createStaff: (body: Record<string, unknown>) => post<StaffMember>(`/platform/workspaces/${tenantId}/staff`, body),
    updateStaff: (id: string, body: Record<string, unknown>) => patch<StaffMember>(`/platform/workspaces/${tenantId}/staff/${id}`, body),
    roles: () => get<Role[]>(`/platform/workspaces/${tenantId}/roles`),
    createRole: (body: Record<string, unknown>) => post<Role>(`/platform/workspaces/${tenantId}/roles`, body),
    updateRole: (id: string, body: Record<string, unknown>) => patch<Role>(`/platform/workspaces/${tenantId}/roles/${id}`, body),
    inventory: (params?: Query) => getPaginated<InventoryRow>(`/platform/workspaces/${tenantId}/inventory`, params),
    adjustStock: (body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/workspaces/${tenantId}/inventory/adjust`, body),
    sales: (params?: Query) => getPaginated<Sale>(`/platform/workspaces/${tenantId}/sales`, params),
  }),
  approveUpgrade: (id: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/upgrade-requests/${id}/approve`, body),
  rejectUpgrade: (id: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/upgrade-requests/${id}/reject`, body),
  allPlans: () => get<SubscriptionPlan[]>('/plans/all'),
  /** Every plan with its running subscription count; optionally one POS type, or `shared`. */
  adminPlans: (posProductCode?: string) => get<AdminPlan[]>('/plans/all', posProductCode ? { posProductCode } : undefined),
  planUsage: (id: string) => get<PlanUsage>(`/plans/${id}/usage`),
  /** Withdraws a plan from sale. Running subscriptions are not touched. */
  deactivatePlan: (id: string) => del<SubscriptionPlan>(`/plans/${id}`),
  createPlan: (body: Record<string, unknown>) => post<SubscriptionPlan>('/plans', body),
  updatePlan: (id: string, body: Record<string, unknown>) => patch<SubscriptionPlan>(`/plans/${id}`, body),
};

export type WorkspaceSubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'suspended';

export interface WorkspaceSubscriptionView {
  id: string;
  accountId: string | null;
  workspaceId: string;
  posProductId: string | null;
  posProductCode: string;
  planId: string;
  planCode: string | null;
  planName: string | null;
  billingCycle: 'monthly' | 'annual';
  status: WorkspaceSubscriptionStatus;
  priceMinor: number | null;
  currency: string | null;
  startAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
}

export type BillingAttention = 'suspended' | 'no_subscription' | 'expired' | 'in_grace' | 'renewal_failed' | 'cancelling' | 'trial_ending' | 'wallet_short';

export interface WorkspaceBillingItem {
  workspace: { id: string; name: string; vertical: string; status: string; posTypeLabel?: string };
  isActive: boolean;
  daysRemaining: number;
  subscription: WorkspaceSubscriptionView | null;
  renewal: {
    manageable: boolean;
    autoRenew: boolean;
    renewsAutomatically: boolean;
    graceEndsAt: string | null;
    failedRenewalAttempts: number;
    renewalWindowOpen: boolean;
    nextRenewal: RenewalInfo['nextRenewal'];
    scheduledChange: RenewalInfo['scheduledChange'];
  };
  attention: BillingAttention[];
}

export interface AccountBilling {
  wallet: { balanceMinor: number; currency: string; isFrozen: boolean } | null;
  totals: { workspaces: number; active: number; needsAttention: number; byStatus: Record<string, number> };
  upcoming: {
    windowDays: number;
    currency: string;
    dueMinor: number;
    shortfallMinor: number;
    renewals: {
      workspaceId: string;
      workspaceName: string;
      planName: string;
      catalogPlanCode: string | null;
      billingCycle: 'monthly' | 'annual';
      amountMinor: number;
      currency: string;
      renewsAt: string;
      overdue: boolean;
      coveredByWallet: boolean;
    }[];
  };
  workspaces: WorkspaceBillingItem[];
}

/** The account owner's billing across workspaces. The account is always the caller's own. */
export const accountApi = {
  billing: () => get<AccountBilling>('/account/billing'),
  setAutoRenew: (workspaceId: string, enabled: boolean) =>
    post<WorkspaceBillingItem>(`/workspaces/${encodeURIComponent(workspaceId)}/subscription/auto-renew`, { enabled }),
  cancelScheduledChange: (workspaceId: string) =>
    del<WorkspaceBillingItem>(`/workspaces/${encodeURIComponent(workspaceId)}/subscription/scheduled-change`),
  reactivate: (workspaceId: string) => post<WorkspaceBillingItem>(`/workspaces/${encodeURIComponent(workspaceId)}/subscription/reactivate`, {}),
  /** The plan the workspace moves to at its next renewal. The server applies the transition rules. */
  scheduleChange: (workspaceId: string, body: { plan: string; billingCycle: 'monthly' | 'annual' }) =>
    post<WorkspaceBillingItem & { change: { kind: string; breaches: { resource: string; current: number; limit: number }[] } }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/subscription/scheduled-change`,
      body,
    ),
};

export interface AccountWalletSummary {
  balanceMinor: number;
  currency: string;
  status: 'active' | 'frozen';
  isFrozen: boolean;
  totalCreditsMinor: number;
  totalRefundsMinor: number;
  totalDebitsMinor: number;
  services: { service: 'subscription' | 'sms' | 'email' | 'other'; label: string; amountMinor: number }[];
  pendingTopUps: number;
  fundingMethods: { manual: string[]; online: string[] };
}

export interface AccountWalletTransaction {
  id: string;
  workspaceId: string;
  type: string;
  direction: 'in' | 'out';
  amountMinor: number;
  currency: string;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
  description: string;
  source: string;
  status: string;
  referenceType: string | null;
  performedByNameSnapshot: string;
  createdAt: string;
}

/** The account wallet across every workspace. The account is always the caller's own. */
export const accountWalletApi = {
  summary: (params?: Query) => get<AccountWalletSummary>('/account/wallet', params),
  transactions: (params?: Query) => getPaginated<AccountWalletTransaction>('/account/wallet/transactions', params),
};

export type InvoiceStatus = 'paid' | 'partially_refunded' | 'refunded';

export interface InvoiceSummary {
  id: string;
  number: string;
  issuedAt: string;
  status: InvoiceStatus;
  kind: string;
  workspace: { id: string; name: string };
  planName: string | null;
  billingCycle: 'monthly' | 'annual' | null;
  posType: string | null;
  currency: string;
  totalMinor: number;
  refundedMinor: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  issuer: { name: string; address: string; email: string; phone: string };
  billedTo: { accountName: string; workspaceName: string; email: string; phone: string; country: string };
  lines: {
    description: string;
    planCode: string;
    planName: string;
    billingCycle: 'monthly' | 'annual';
    posType: string;
    periodStart: string | null;
    periodEnd: string | null;
    quantity: number;
    unitAmountMinor: number;
    amountMinor: number;
  }[];
  subtotalMinor: number;
  discountMinor: number;
  couponCode: string | null;
  creditMinor: number;
  adjustmentMinor: number;
  netMinor: number;
  refunds: { amountMinor: number; method: string; at: string }[];
  payment: { method: string; reference: string | null; paidAt: string | null };
}

export interface PaymentHistoryRow {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';
  paidAt: string | null;
  createdAt: string;
  refundedMinor: number;
  refunds: { amountMinor: number; method: string; at: string }[];
  failureReason: string | null;
  underReview: boolean;
  invoice: { id: string; number: string | null } | null;
}

/** Subscription invoices and payments. Account-wide for the owner; one workspace inside it. */
export const invoiceApi = {
  accountInvoices: (params?: Query) => getPaginated<InvoiceSummary>('/account/invoices', params),
  accountInvoice: (id: string) => get<InvoiceDetail>(`/account/invoices/${encodeURIComponent(id)}`),
  accountPayments: (params?: Query) => getPaginated<PaymentHistoryRow>('/account/payments', params),
  workspaceInvoices: (params?: Query) => getPaginated<InvoiceSummary>('/subscriptions/invoices', params),
  workspaceInvoice: (id: string) => get<InvoiceDetail>(`/subscriptions/invoices/${encodeURIComponent(id)}`),
};

export interface WalletReceiptView {
  id: string;
  number: string;
  issuedAt: string;
  topUpId: string;
  workspace: { id: string; name: string };
  amountMinor: number;
  currency: string;
  issuer: { name: string; address: string; email: string; phone: string };
  receivedFrom: { accountName: string; workspaceName: string; email: string; phone: string };
  payment: { method: string; transactionId: string; senderLast4: string };
  balanceAfterMinor: number | null;
}

export type StatementCategory = 'topup' | 'subscription' | 'sms' | 'email' | 'ai' | 'storage' | 'adjustment' | 'refund' | 'other';

export interface StatementEntry {
  id: string;
  at: string;
  workspace: { id: string; name: string };
  category: StatementCategory;
  direction: 'in' | 'out';
  amountMinor: number;
  balanceAfterMinor: number | null;
  description: string;
  reference: { kind: 'receipt' | 'invoice' | 'usage'; id: string | null; label: string } | null;
}

export interface AccountStatement {
  period: { from: string; to: string };
  currency: string;
  workspaceId: string | null;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  moneyInMinor: number;
  moneyOutMinor: number;
  categories: { category: StatementCategory; inMinor: number; outMinor: number }[];
  entries: StatementEntry[];
  truncated: boolean;
  reconciled: boolean | null;
  paidOutsideWallet: { id: string; number: string; issuedAt: string; workspace: { id: string; name: string }; amountMinor: number; currency: string; method: string }[];
}

/** The account statement and top-up receipts. */
export const statementApi = {
  account: (params?: Query) => get<AccountStatement>('/account/statement', params),
  receipts: (params?: Query) => getPaginated<WalletReceiptView>('/account/receipts', params),
  receipt: (id: string) => get<WalletReceiptView>(`/account/receipts/${encodeURIComponent(id)}`),
  topUpReceipt: (topUpId: string) => get<WalletReceiptView>(`/wallet/top-ups/${encodeURIComponent(topUpId)}/receipt`),
};

export interface AccountTopUp {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  transactionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewNote: string;
  createdAt: string;
  receipt: { id: string; number: string | null } | null;
}

/** Adding money and cancelling, from the account's Billing page. The account is always the caller's own. */
export const accountBillingActionsApi = {
  paymentInstructions: () =>
    get<{ instructions: PaymentInstruction[]; supportEmail: string; supportPhone: string }>('/account/payment-instructions'),
  topUps: (params?: Query) => getPaginated<AccountTopUp>('/account/top-ups', params),
  requestTopUp: (body: { amountMinor: number; paymentMethod: string; senderNumber: string; transactionId: string; workspaceId?: string }) =>
    post<AccountTopUp>('/account/top-ups', body),
  cancelTopUp: (id: string) => post<AccountTopUp>(`/account/top-ups/${encodeURIComponent(id)}/cancel`, {}),
  cancelSubscription: (workspaceId: string, body: { immediate: boolean; reason?: string }) =>
    post<unknown>(`/workspaces/${encodeURIComponent(workspaceId)}/subscription/cancel`, body),
};

export interface PlatformAccountRow {
  id: string;
  name: string;
  contactEmail: string;
  status: 'active' | 'suspended';
  owner: { id: string; name: string; email: string } | null;
  workspaceCount: number;
  createdAt: string;
}

export interface PlatformAccountOverview {
  account: { id: string; name: string; contactEmail: string; contactPhone: string; country: string; status: 'active' | 'suspended'; trialUsed: boolean; createdAt: string };
  owner: { id: string; name: string; email: string; phone: string; isActive: boolean } | null;
  billing: AccountBilling;
  pendingTopUps: number;
  supportHistory: { id: string; actorName: string; at: string; section: string | null; reason: string | null }[];
}

/**
 * Platform support: READ-ONLY account views. Every call except the directory
 * carries the access reason, which the server records in the audit log.
 */
export const platformAccountsApi = {
  list: (params?: Query) => getPaginated<PlatformAccountRow>('/platform/accounts', params),
  overview: (id: string, reason: string) => get<PlatformAccountOverview>(`/platform/accounts/${encodeURIComponent(id)}`, { reason }),
  statement: (id: string, params: Query) => get<AccountStatement>(`/platform/accounts/${encodeURIComponent(id)}/statement`, params),
  invoices: (id: string, params: Query) => getPaginated<InvoiceSummary>(`/platform/accounts/${encodeURIComponent(id)}/invoices`, params),
  payments: (id: string, params: Query) => getPaginated<PaymentHistoryRow>(`/platform/accounts/${encodeURIComponent(id)}/payments`, params),
  receipts: (id: string, params: Query) => getPaginated<WalletReceiptView>(`/platform/accounts/${encodeURIComponent(id)}/receipts`, params),
  topUps: (id: string, params: Query) => getPaginated<AccountTopUp>(`/platform/accounts/${encodeURIComponent(id)}/top-ups`, params),
};

export interface PlatformLedgerRow {
  id: string;
  tenantId: string;
  walletId: string;
  type: 'credit' | 'debit' | 'refund' | 'adjustment' | 'transfer_in' | 'transfer_out';
  amountMinor: number;
  currency: string;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
  source: string;
  status: string;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string | null;
  reversalOfTransactionId: string | null;
  performedBy: string | null;
  performedByName: string;
  createdAt: string;
}

export interface PlatformAccountWallet {
  wallet: { id: string; balanceMinor: number; currency: string; status: 'active' | 'frozen'; lifetimeCreditedMinor: number; lifetimeDebitedMinor: number } | null;
  transactions: PlatformLedgerRow[];
  page: number;
  limit: number;
  total: number;
}

/** Platform wallet operations on an account: the ledger, manual adjustments and compensating reversals. */
export const platformWalletApi = {
  ledger: (accountId: string, params: Query) => get<PlatformAccountWallet>(`/platform/accounts/${encodeURIComponent(accountId)}/wallet`, params),
  adjust: (accountId: string, body: { direction: 'credit' | 'debit'; amountMinor: number; reason: string; source: 'admin_adjustment' | 'promotional_credit'; idempotencyKey: string }) =>
    post<{ transaction: PlatformLedgerRow; balanceMinor: number; replayed: boolean }>(`/platform/accounts/${encodeURIComponent(accountId)}/wallet/adjustments`, body),
  reverse: (accountId: string, transactionId: string, body: { reason: string }) =>
    post<{ transaction: PlatformLedgerRow; balanceMinor: number; replayed: boolean }>(
      `/platform/accounts/${encodeURIComponent(accountId)}/wallet/transactions/${encodeURIComponent(transactionId)}/reverse`,
      body,
    ),
};

export interface RenewalBillingState {
  state: 'renewed' | 'already_renewed' | 'insufficient_funds' | 'failed' | 'in_progress' | 'not_due' | 'not_renewable';
  subscriptionId: string;
  renewedSubscriptionId: string | null;
  planName: string | null;
  amountMinor: number | null;
  currency: string | null;
  walletBalanceMinor: number | null;
  currentPeriodEnd: string | null;
  message: string;
}

export interface AccountRenewals {
  wallet: { balanceMinor: number; currency: string; isFrozen: boolean } | null;
  renewals: {
    workspace: { id: string; name: string; vertical: string; status: string };
    subscriptionId: string | null;
    status: string;
    planName: string | null;
    billingCycle: string | null;
    nextRenewalAt: string | null;
    renewalAmountMinor: number | null;
    currency: string;
    renewsAutomatically: boolean;
    graceEndsAt: string | null;
    canRenewNow: boolean;
  }[];
  totals: { currency: string; walletBalanceMinor: number; nextCycleMinor: number; balanceAfterMinor: number; shortfallMinor: number };
}

/** Renewing now from the account wallet. Nothing but the workspace is sent: the server prices it. */
export const renewalApi = {
  accountRenewals: () => get<AccountRenewals>('/account/renewals'),
  renewWorkspace: (workspaceId: string) =>
    post<{ billing: RenewalBillingState; workspace: WorkspaceBillingItem }>(`/workspaces/${encodeURIComponent(workspaceId)}/subscription/renew`, {}),
  renewCurrent: () => post<{ billing: RenewalBillingState }>('/subscriptions/renew', {}),
};

export interface PricingCatalog {
  posType: string;
  posProductName: string;
  plans: { code: string; displayName: string; description: string; tier: number; highlights: string[]; monthly: unknown; annual: unknown }[];
}

export interface WorkspacePlanOptions {
  workspace: { id: string; name: string; posType: string };
  isActive: boolean;
  current: { planCode: string | null; planName: string | null; billingCycle: string; status: string; currentPeriodEnd: string } | null;
  catalog: PricingCatalog;
}

export interface AccountDashboard {
  account: { id: string; name: string; status: string } | null;
  wallet: { balanceMinor: number; currency: string; isFrozen: boolean } | null;
  totals: AccountRenewals['totals'];
  workspaces: {
    id: string;
    name: string;
    posType: string;
    posTypeLabel: string;
    status: string;
    isActive: boolean;
    needsPlan: boolean;
    subscription: { planName: string | null; planCode: string | null; billingCycle: string; status: string } | null;
    renewalDate: string | null;
    renewalAmountMinor: number | null;
    currency: string;
    renewsAutomatically: boolean;
    canRenewNow: boolean;
    attention: BillingAttention[];
    canOpen: boolean;
  }[];
  addPos: { canAdd: boolean; maxWorkspaces: number; options: WorkspaceVerticalOption[] };
}

/** Onboarding and the account dashboard. Every price comes from the server; the account is always the session's. */
export const onboardingApi = {
  publicPosTypes: () => get<WorkspaceVerticalOption[]>('/workspaces/verticals/public'),
  dashboard: () => get<AccountDashboard>('/account/dashboard'),
  plans: (workspaceId: string) => get<WorkspacePlanOptions>(`/workspaces/${encodeURIComponent(workspaceId)}/plans`),
  quote: (workspaceId: string, body: { plan: string; billingCycle: 'monthly' | 'annual' }) =>
    post<PurchaseQuote>(`/workspaces/${encodeURIComponent(workspaceId)}/checkout/quote`, body),
  checkoutFromWallet: (workspaceId: string, body: { plan: string; billingCycle: 'monthly' | 'annual'; idempotencyKey: string; expectedPayableMinor: number }) =>
    post<{ quote: PurchaseQuote; result: unknown }>(`/workspaces/${encodeURIComponent(workspaceId)}/checkout`, { paymentMethod: 'wallet', ...body }),
};
