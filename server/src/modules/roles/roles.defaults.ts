import { Types, type ClientSession } from 'mongoose';
import { DEFAULT_CASHIER_PERMISSIONS, PERMISSIONS, type Permission } from '../../config/permissions';
import { RoleModel } from '../../models/Role';

interface SystemRoleSeed {
  name: string;
  description: string;
  permissions: Permission[];
}

/**
 * Roles every new tenant starts with. They are marked `isSystem` so they cannot
 * be deleted out from under existing staff, but their permissions remain
 * editable by the tenant admin.
 */
export const SYSTEM_ROLES: SystemRoleSeed[] = [
  {
    name: 'Cashier',
    description: 'Runs the POS. Cannot change prices or manage the catalogue.',
    permissions: DEFAULT_CASHIER_PERMISSIONS,
  },
  {
    name: 'Senior Cashier',
    description: 'A cashier who may override prices and process returns.',
    permissions: [
      ...DEFAULT_CASHIER_PERMISSIONS,
      PERMISSIONS.SALES_CHANGE_PRICE,
      PERMISSIONS.SALES_DISCOUNT,
      PERMISSIONS.SALES_SELL_OUT_OF_STOCK,
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.LOYALTY_VIEW,
    ],
  },
  {
    name: 'Store Manager',
    description: 'Full operational access: catalogue, stock, staff and reports.',
    permissions: [
      ...DEFAULT_CASHIER_PERMISSIONS,
      PERMISSIONS.PRODUCTS_CREATE,
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.PRODUCTS_DELETE,
      PERMISSIONS.CATEGORIES_CREATE,
      PERMISSIONS.CATEGORIES_EDIT,
      PERMISSIONS.CATEGORIES_DELETE,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.SALES_CHANGE_PRICE,
      PERMISSIONS.SALES_DISCOUNT,
      PERMISSIONS.SALES_CANCEL,
      PERMISSIONS.SALES_SELL_OUT_OF_STOCK,
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.LOYALTY_VIEW,
      PERMISSIONS.LOYALTY_MANAGE,
      PERMISSIONS.CUSTOMERS_EDIT,
      PERMISSIONS.REPORTS_VIEW,
      PERMISSIONS.REPORTS_EXPORT,
      PERMISSIONS.STAFF_VIEW,
      PERMISSIONS.SETTINGS_VIEW,
      // A manager may look at marketing, but spending the wallet stays with
      // the owner unless explicitly granted.
      PERMISSIONS.MARKETING_VIEW,
      PERMISSIONS.MARKETING_VIEW_HISTORY,
    ],
  },
];

/** Every permission a default-grant migration has ever added; new roles already have today's defaults. */
export const APPLIED_DEFAULT_KEYS = [
  PERMISSIONS.REPORTS_EXPORT,
  PERMISSIONS.SALES_SELL_OUT_OF_STOCK,
  PERMISSIONS.LOYALTY_VIEW,
  PERMISSIONS.LOYALTY_REDEEM,
  PERMISSIONS.LOYALTY_MANAGE,
];

export async function createSystemRoles(tenantId: Types.ObjectId, session?: ClientSession) {
  return RoleModel.create(
    // New roles already carry today's defaults, so later default-grant migrations skip them.
    SYSTEM_ROLES.map((role) => ({ ...role, tenantId, isSystem: true, isActive: true, appliedPermissionDefaults: [...APPLIED_DEFAULT_KEYS] })),
    { session },
  );
}
