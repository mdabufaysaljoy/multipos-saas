import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoadingState } from '@/components/states';
import { EmptyState } from '@/components/states';
import { useAuth } from '@/hooks/useAuth';
import { ShieldAlert } from 'lucide-react';
import { LOCK_REDIRECT, isPathUnlocked, isSubscriptionLocked } from '@/lib/subscriptionLock';

interface ProtectedRouteProps {
  children: ReactNode;
  /** Any one of these is enough to enter the route. */
  anyOf?: string[];
  platformAdmin?: boolean;
  /** Only the account owner may enter (billing across workspaces). */
  accountOwner?: boolean;
}

/**
 * Route-level access control.
 *
 * This is navigation ergonomics, not security: a user who forces the URL simply
 * sees a "no access" panel, while the API behind the page independently rejects
 * anything they are not permitted to do.
 */
export function ProtectedRoute({ children, anyOf, platformAdmin, accountOwner }: ProtectedRouteProps) {
  const { session, loading, can, isPlatformAdmin, isAccountOwner } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking your session…" />;

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (platformAdmin && !isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  // A tenant user who has not created a store yet must finish onboarding.
  if (!platformAdmin && !isPlatformAdmin && session.needsStoreSetup && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  // Without a usable subscription the workspace is locked down to the wallet
  // and the subscription page. Platform admins are never subject to this.
  if (
    !platformAdmin &&
    !isPlatformAdmin &&
    isSubscriptionLocked(session.entitlement) &&
    !isPathUnlocked(location.pathname)
  ) {
    return <Navigate to={LOCK_REDIRECT} replace />;
  }

  if (accountOwner && !isAccountOwner) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" />}
          title="Only the account owner can see this page"
          description="Billing across workspaces belongs to the owner of the account."
        />
      </div>
    );
  }

  if (anyOf && !anyOf.some(can)) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" />}
          title="You do not have access to this page"
          description="Ask your administrator to grant you the required permission."
        />
      </div>
    );
  }

  return <>{children}</>;
}

/** Sends an already-authenticated visitor away from the sign-in screens. */
export function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { session, loading, isPlatformAdmin } = useAuth();
  if (loading) return <LoadingState />;
  if (session) {
    if (isPlatformAdmin) return <Navigate to="/platform" replace />;
    if (session.needsStoreSetup) return <Navigate to="/onboarding" replace />;
    if (isSubscriptionLocked(session.entitlement)) return <Navigate to={LOCK_REDIRECT} replace />;
    return <Navigate to="/pos" replace />;
  }
  return <>{children}</>;
}
