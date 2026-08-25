import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';

interface PermissionGateProps {
  /** Any one of these is enough. */
  anyOf?: string[];
  /** All of these are required. */
  allOf?: string[];
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * Hides UI the current user cannot use.
 *
 * This is presentation only. Every operation it guards is independently
 * enforced by `requirePermission` on the server, so removing this component
 * would change what a user SEES and nothing about what they can DO.
 */
export function PermissionGate({ anyOf, allOf, children, fallback = null }: PermissionGateProps) {
  const { can } = useAuth();

  if (allOf && !allOf.every(can)) return <>{fallback}</>;
  if (anyOf && !anyOf.some(can)) return <>{fallback}</>;

  return <>{children}</>;
}
