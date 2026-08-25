import type { Types } from 'mongoose';
import type { UserRole } from '../config/constants';
import type { Permission } from '../config/permissions';

export interface AuthUser {
  id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  tenantId: Types.ObjectId | null;
  storeId: Types.ObjectId | null;
  permissions: Permission[];
  isAdmin: boolean;
  isPlatformAdmin: boolean;
}

/**
 * Everything a service needs to answer "who is asking, and on whose data?".
 * Services accept this instead of reading from the request, which makes the
 * tenant filter impossible to forget.
 */
export interface TenantContext {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  userId: Types.ObjectId;
  userName: string;
  role: UserRole;
  permissions: Permission[];
  isAdmin: boolean;
  can(permission: Permission): boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
      ctx?: TenantContext;
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
