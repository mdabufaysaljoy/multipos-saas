/**
 * Screens that belong to one POS vertical only.
 *
 * Navigation ergonomics, not security: the server refuses every one of these
 * modules to a workspace of another vertical (VERTICAL_NOT_SUPPORTED). This
 * keeps the UI from offering doors that are already bolted.
 */
const VERTICAL_ONLY_PATHS: Record<string, string[]> = {
  // `/dashboard`, `/analytics` and `/pos` are shared: each vertical renders its own there.
  clothing: ['/sales', '/returns', '/catalogue', '/categories', '/inventory'],
  restaurant: ['/menu', '/menu-categories', '/menu-import', '/tables', '/orders', '/kitchen', '/shifts', '/refunds'],
  pharmacy: ['/medicines', '/pharmacy-categories', '/pharmacy-import', '/stock', '/pharmacy-sales', '/pharmacy-returns'],
  supershop: ['/shop-products', '/shop-categories', '/shop-import', '/shop-inventory', '/shop-sales', '/shop-returns'],
};

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isPathAllowedForVertical(pathname: string, vertical: string | null | undefined): boolean {
  const current = vertical ?? 'clothing';
  return Object.entries(VERTICAL_ONLY_PATHS).every(
    ([owner, prefixes]) => owner === current || !prefixes.some((prefix) => matches(pathname, prefix)),
  );
}

/** Where a workspace lands after finishing store setup. */
export function homePathForVertical(vertical: string | null | undefined): string {
  if (vertical === 'restaurant') return '/menu';
  if (vertical === 'pharmacy') return '/medicines';
  if (vertical === 'supershop') return '/shop-products';
  return '/catalogue';
}
