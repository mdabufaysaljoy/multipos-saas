import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LoadingState } from '@/components/states';
import { EmptyState } from '@/components/states';
import { useAuth } from '@/hooks/useAuth';
import { ShieldAlert } from 'lucide-react';

interface ProtectedRouteProps {
  children: ReactNode;
  /** Any one of these is enough to enter the route. */
  anyOf?: string[];
  platformAdmin?: boolean;
}

/**
 * Route-level access control.
 *
 * This is navigation ergonomics, not security: a user who forces the URL simply
 * sees a "no access" panel, while the API behind the page independently rejects
 * anything they are not permitted to do.
 */
export function ProtectedRoute({ children, anyOf, platformAdmin }: ProtectedRouteProps) {
  const { session, loading, can, isPlatformAdmin } = useAuth();
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
    return <Navigate to={session.needsStoreSetup ? '/onboarding' : '/pos'} replace />;
  }
  return <>{children}</>;
}
