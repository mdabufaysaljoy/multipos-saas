import type { Entitlement } from '@/types/api';

/**
 * The only routes a workspace can reach without a usable subscription.
 *
 * A locked-out owner needs exactly two things: somewhere to put money, and
 * somewhere to spend it on a plan. Everything else stays shut until they do.
 * The server enforces the same rule (`requireSubscribedAccess`) - this list
 * only keeps the UI from offering doors that are already bolted.
 */
export const UNLOCKED_PATHS = ['/wallet', '/subscription', '/billing', '/account', '/onboarding'];

/** Where a locked-out user is sent when they aim at a locked page. */
export const LOCK_REDIRECT = '/subscription';

export function isSubscriptionLocked(entitlement: Entitlement | null | undefined): boolean {
  // No entitlement at all means we could not determine one (platform admin,
  // or a session that predates a tenant) - never lock on missing information.
  if (!entitlement) return false;
  return !entitlement.isUsable;
}

export function isPathUnlocked(pathname: string): boolean {
  return UNLOCKED_PATHS.some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`));
}
