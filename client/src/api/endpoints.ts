import { del, get, getPaginated, patch, post } from './client';
import type {
  Category,
  Customer,
  DashboardReport,
  InventoryRow,
  InventorySummary,
  LedgerEntry,
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
} from '@/types/domain';
import type { AuthTokens, Session } from '@/types/api';

type Query = Record<string, unknown>;

export const authApi = {
  login: (body: { email: string; password: string }) =>
    post<Session & { tokens: AuthTokens }>('/auth/login', body),
  register: (body: { businessName: string; name: string; email: string; phone?: string; password: string }) =>
    post<Session & { tokens: AuthTokens }>('/auth/register', body),
  me: () => get<Session>('/auth/me'),
  logout: () => post<{ message: string }>('/auth/logout'),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    post<{ message: string }>('/auth/change-password', body),
};

export const storeApi = {
  list: () => get<StoreSettings[]>('/stores'),
  create: (body: Record<string, unknown>) => post<StoreSettings>('/stores', body),
  current: () => get<StoreSettings>('/stores/current'),
  /** Lightweight config every till can read, regardless of settings.view. */
  posConfig: () =>
    get<Pick<StoreSettings, '_id' | 'name' | 'currency' | 'paymentMethods' | 'tax' | 'receipt' | 'lowStockThreshold' | 'logoUrl'>>(
      '/stores/pos-config',
    ),
  updateCurrent: (body: Record<string, unknown>) => patch<StoreSettings>('/stores/current', body),
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

export const roleApi = {
  list: () => get<Role[]>('/roles'),
  catalog: () => get<PermissionGroup[]>('/roles/permissions/catalog'),
  create: (body: Record<string, unknown>) => post<Role>('/roles', body),
  update: (id: string, body: Record<string, unknown>) => patch<Role>(`/roles/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`/roles/${id}`),
};

export const reportApi = {
  dashboard: (params?: Query) => get<DashboardReport>('/reports/dashboard', params),
};

export const billingApi = {
  plans: () => get<SubscriptionPlan[]>('/plans'),
  current: () =>
    get<{
      subscription: Subscription | null;
      entitlement: import('@/types/api').Entitlement;
      usage: { products: number; staff: number; stores: number };
    }>('/subscriptions/current'),
  history: () => get<{ subscriptions: Subscription[]; events: unknown[]; payments: unknown[] }>('/subscriptions/history'),
  cancel: (body: { immediate: boolean; reason?: string }) => post<Subscription>('/subscriptions/cancel', body),
  reactivate: () => post<Subscription>('/subscriptions/reactivate'),
  providers: () => get<{ name: string; displayName: string }[]>('/payments/providers'),
};

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
  payments: (params?: Query) => getPaginated<Record<string, unknown>>('/platform/payments', params),
  markPaid: (id: string, body: Record<string, unknown>) => post<Record<string, unknown>>(`/platform/payments/${id}/mark-paid`, body),
  allPlans: () => get<SubscriptionPlan[]>('/plans/all'),
  createPlan: (body: Record<string, unknown>) => post<SubscriptionPlan>('/plans', body),
  updatePlan: (id: string, body: Record<string, unknown>) => patch<SubscriptionPlan>(`/plans/${id}`, body),
};
