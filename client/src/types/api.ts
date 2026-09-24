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
  /** Owns the customer account: sees billing across every workspace. */
  isAccountOwner?: boolean;
  /** Which contact details this person has proven. Buying a plan needs one. */
  verification?: VerificationStatus;
}

/** Email / phone verification, as the session reports it. */
export interface VerificationStatus {
  email: { destination: string; masked: string; verified: boolean };
  phone: { destination: string; masked: string; verified: boolean };
  anyVerified: boolean;
}

export interface VerificationSendResult {
  channel: 'email' | 'phone';
  masked: string;
  expiresAt: string;
  resendAfterSeconds: number;
  /** Development and test only - never returned by a production server. */
  devCode?: string;
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
  /** The POS vertical the plan's entitlements were resolved for. */
  vertical?: 'clothing' | 'restaurant' | 'pharmacy' | 'supershop' | 'grocery' | null;
  interval: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  currentPeriodEnd: string | null;
  daysRemaining: number;
  cancelAtPeriodEnd: boolean;
  /** Set while an ended period stays usable because its automatic renewal is being retried. */
  graceEndsAt?: string | null;
  isUsable: boolean;
  isReadOnly: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  vertical: 'clothing' | 'restaurant' | 'pharmacy' | 'supershop' | 'grocery';
  status: string;
  isHome: boolean;
  isActive: boolean;
}

export interface Session {
  user: SessionUser;
  /** The active POS workspace, its owning account and its POS vertical. */
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    accountId: string | null;
    vertical: 'clothing' | 'restaurant' | 'pharmacy' | 'supershop' | 'grocery';
  } | null;
  /**
   * Workspaces this user may switch between. The account owner sees every
   * workspace of the account; staff see only their own.
   */
  workspaces: WorkspaceSummary[];
  stores: SessionStore[];
  entitlement: Entitlement | null;
  needsStoreSetup: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
