/**
 * Single source of truth for the permission catalogue.
 * Permissions are never hardcoded in route handlers as free-form strings; they
 * are referenced through PERMISSIONS so a typo becomes a compile error.
 */
export const PERMISSIONS = {
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_EDIT: 'products.edit',
  PRODUCTS_DELETE: 'products.delete',

  CATEGORIES_VIEW: 'categories.view',
  CATEGORIES_CREATE: 'categories.create',
  CATEGORIES_EDIT: 'categories.edit',
  CATEGORIES_DELETE: 'categories.delete',

  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',

  SALES_VIEW: 'sales.view',
  SALES_CREATE: 'sales.create',
  SALES_CANCEL: 'sales.cancel',
  SALES_CHANGE_PRICE: 'sales.changePrice',
  SALES_DISCOUNT: 'sales.discount',

  RETURNS_VIEW: 'returns.view',
  RETURNS_CREATE: 'returns.create',

  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.edit',
  CUSTOMERS_DELETE: 'customers.delete',

  REPORTS_VIEW: 'reports.view',

  MARKETING_VIEW: 'marketing.view',
  MARKETING_CREATE_CAMPAIGN: 'marketing.createCampaign',
  MARKETING_SEND_SMS: 'marketing.sendSMS',
  MARKETING_SEND_EMAIL: 'marketing.sendEmail',
  MARKETING_VIEW_HISTORY: 'marketing.viewHistory',
  MARKETING_MANAGE_RECIPIENTS: 'marketing.manageRecipients',

  STAFF_VIEW: 'staff.view',
  STAFF_CREATE: 'staff.create',
  STAFF_EDIT: 'staff.edit',
  STAFF_DELETE: 'staff.delete',

  ROLES_VIEW: 'roles.view',
  ROLES_MANAGE: 'roles.manage',

  SETTINGS_VIEW: 'settings.view',
  SETTINGS_EDIT: 'settings.edit',

  SUBSCRIPTION_VIEW: 'subscription.view',
  SUBSCRIPTION_MANAGE: 'subscription.manage',

  /** Account-level money. Never implied by subscription permissions. */
  WALLET_VIEW: 'wallet.view',
  WALLET_MANAGE: 'wallet.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export interface PermissionGroup {
  group: string;
  label: string;
  permissions: { key: Permission; label: string; description: string }[];
}

export const PERMISSION_CATALOG: PermissionGroup[] = [
  {
    group: 'products',
    label: 'Products',
    permissions: [
      { key: PERMISSIONS.PRODUCTS_VIEW, label: 'View products', description: 'Browse the product catalogue' },
      { key: PERMISSIONS.PRODUCTS_CREATE, label: 'Create products', description: 'Add new products and variants' },
      { key: PERMISSIONS.PRODUCTS_EDIT, label: 'Edit products', description: 'Change product details and prices' },
      { key: PERMISSIONS.PRODUCTS_DELETE, label: 'Delete products', description: 'Deactivate or soft-delete products' },
    ],
  },
  {
    group: 'categories',
    label: 'Categories',
    permissions: [
      { key: PERMISSIONS.CATEGORIES_VIEW, label: 'View categories', description: 'See the category list' },
      { key: PERMISSIONS.CATEGORIES_CREATE, label: 'Create categories', description: 'Add new categories' },
      { key: PERMISSIONS.CATEGORIES_EDIT, label: 'Edit categories', description: 'Rename or reorganise categories' },
      { key: PERMISSIONS.CATEGORIES_DELETE, label: 'Delete categories', description: 'Soft-delete categories' },
    ],
  },
  {
    group: 'inventory',
    label: 'Inventory',
    permissions: [
      { key: PERMISSIONS.INVENTORY_VIEW, label: 'View inventory', description: 'See stock levels and the ledger' },
      { key: PERMISSIONS.INVENTORY_ADJUST, label: 'Adjust stock', description: 'Manually add or remove stock' },
    ],
  },
  {
    group: 'sales',
    label: 'Sales & POS',
    permissions: [
      { key: PERMISSIONS.SALES_VIEW, label: 'View sales', description: 'Browse sales history and receipts' },
      { key: PERMISSIONS.SALES_CREATE, label: 'Create sales', description: 'Use the POS to complete sales' },
      { key: PERMISSIONS.SALES_CANCEL, label: 'Cancel sales', description: 'Void a completed sale and restore stock' },
      { key: PERMISSIONS.SALES_CHANGE_PRICE, label: 'Change price at checkout', description: 'Override the selling price during a sale' },
      { key: PERMISSIONS.SALES_DISCOUNT, label: 'Apply discounts', description: 'Apply an order-level discount' },
    ],
  },
  {
    group: 'returns',
    label: 'Returns',
    permissions: [
      { key: PERMISSIONS.RETURNS_VIEW, label: 'View returns', description: 'Browse return history' },
      { key: PERMISSIONS.RETURNS_CREATE, label: 'Create returns', description: 'Process a return against a sale' },
    ],
  },
  {
    group: 'customers',
    label: 'Customers',
    permissions: [
      { key: PERMISSIONS.CUSTOMERS_VIEW, label: 'View customers', description: 'Search the customer directory' },
      { key: PERMISSIONS.CUSTOMERS_CREATE, label: 'Create customers', description: 'Add customers during or outside checkout' },
      { key: PERMISSIONS.CUSTOMERS_EDIT, label: 'Edit customers', description: 'Update customer details' },
      { key: PERMISSIONS.CUSTOMERS_DELETE, label: 'Delete customers', description: 'Soft-delete customers' },
    ],
  },
  {
    group: 'marketing',
    label: 'Marketing',
    permissions: [
      { key: PERMISSIONS.MARKETING_VIEW, label: 'View marketing', description: 'Open the marketing area and see rates' },
      { key: PERMISSIONS.MARKETING_CREATE_CAMPAIGN, label: 'Create campaigns', description: 'Compose SMS and email campaigns' },
      { key: PERMISSIONS.MARKETING_SEND_SMS, label: 'Send SMS', description: 'Spend wallet balance on SMS' },
      { key: PERMISSIONS.MARKETING_SEND_EMAIL, label: 'Send email', description: 'Spend wallet balance on email' },
      { key: PERMISSIONS.MARKETING_VIEW_HISTORY, label: 'View history', description: 'See past campaigns and messages' },
      { key: PERMISSIONS.MARKETING_MANAGE_RECIPIENTS, label: 'Manage recipients', description: 'Choose and filter campaign audiences' },
    ],
  },
  {
    group: 'reports',
    label: 'Reports',
    permissions: [
      { key: PERMISSIONS.REPORTS_VIEW, label: 'View reports', description: 'Access the dashboard and analytics' },
    ],
  },
  {
    group: 'staff',
    label: 'Staff',
    permissions: [
      { key: PERMISSIONS.STAFF_VIEW, label: 'View staff', description: 'See staff accounts' },
      { key: PERMISSIONS.STAFF_CREATE, label: 'Create staff', description: 'Invite new staff accounts' },
      { key: PERMISSIONS.STAFF_EDIT, label: 'Edit staff', description: 'Change staff details and permissions' },
      { key: PERMISSIONS.STAFF_DELETE, label: 'Delete staff', description: 'Deactivate staff accounts' },
    ],
  },
  {
    group: 'roles',
    label: 'Roles',
    permissions: [
      { key: PERMISSIONS.ROLES_VIEW, label: 'View roles', description: 'See role definitions' },
      { key: PERMISSIONS.ROLES_MANAGE, label: 'Manage roles', description: 'Create roles and assign permissions' },
    ],
  },
  {
    group: 'settings',
    label: 'Settings',
    permissions: [
      { key: PERMISSIONS.SETTINGS_VIEW, label: 'View settings', description: 'See store settings' },
      { key: PERMISSIONS.SETTINGS_EDIT, label: 'Edit settings', description: 'Change store and receipt settings' },
    ],
  },
  {
    group: 'subscription',
    label: 'Subscription',
    permissions: [
      { key: PERMISSIONS.SUBSCRIPTION_VIEW, label: 'View subscription', description: 'See the current plan and invoices' },
      { key: PERMISSIONS.SUBSCRIPTION_MANAGE, label: 'Manage subscription', description: 'Change or cancel the plan' },
    ],
  },
  {
    group: 'wallet',
    label: 'Account wallet',
    permissions: [
      { key: PERMISSIONS.WALLET_VIEW, label: 'View account wallet', description: 'See the shared account balance, its transactions and receipts' },
      { key: PERMISSIONS.WALLET_MANAGE, label: 'Use account wallet', description: 'Request top-ups and pay from the shared account balance' },
    ],
  },
];

/** Sensible default permission set for a newly created cashier. */
export const DEFAULT_CASHIER_PERMISSIONS: Permission[] = [
  PERMISSIONS.PRODUCTS_VIEW,
  PERMISSIONS.CATEGORIES_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.SALES_VIEW,
  PERMISSIONS.SALES_CREATE,
  PERMISSIONS.RETURNS_VIEW,
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_CREATE,
];
