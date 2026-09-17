import type { Types } from 'mongoose';
import type { UserRole } from '../config/constants';
import type { Permission } from '../config/permissions';
import type { PosVertical } from '../config/verticals';
import type { TenantDoc } from '../models/Tenant';

export interface AuthUser {
  id: Types.ObjectId;
  name: string;
  email: string;
  role: UserRole;
  tenantId: Types.ObjectId | null;
  storeId: Types.ObjectId | null;
  /** Additional branches this user may work in. */
  storeAccess: Types.ObjectId[];
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
  /** The workspace's POS vertical, loaded from the workspace record. */
  vertical: PosVertical;
  storeId: Types.ObjectId;
  /**
   * Branches this user may work in (home + granted). Empty for administrators,
   * who reach every branch. Bounds which branches a non-admin can hand out.
   */
  allowedStoreIds?: Types.ObjectId[];
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
      /** The account the signed-in user owns. Set by `resolveAccount`, never from input. */
      account?: { id: Types.ObjectId; status: string };
      /** A workspace the account was verified to own. Set by `requireWorkspaceAccess`. */
      workspace?: TenantDoc & { _id: Types.ObjectId };
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
