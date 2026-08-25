export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export type Permission = string;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'platform_admin' | 'admin' | 'staff';
  tenantId: string | null;
  storeId: string | null;
  isActive: boolean;
  permissions: Permission[];
}

export interface SessionStore {
  id: string;
  name: string;
  code: string;
  currency: string;
  logoUrl: string | null;
  isDefault: boolean;
}

export interface Entitlement {
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired' | 'suspended';
  planCode: string | null;
  planName: string | null;
  interval: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  currentPeriodEnd: string | null;
  daysRemaining: number;
  cancelAtPeriodEnd: boolean;
  isUsable: boolean;
  isReadOnly: boolean;
}

export interface Session {
  user: SessionUser;
  tenant: { id: string; name: string; slug: string; status: string } | null;
  stores: SessionStore[];
  entitlement: Entitlement | null;
  needsStoreSetup: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
