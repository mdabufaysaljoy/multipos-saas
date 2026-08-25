import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setSessionExpiredHandler, storeIdStore, tokenStore } from '@/api/client';
import { authApi } from '@/api/endpoints';
import type { Session, SessionStore } from '@/types/api';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  activeStore: SessionStore | null;
  /** True only for tenant admins - platform admins are a separate surface. */
  isAdmin: boolean;
  isPlatformAdmin: boolean;
  /**
   * Frontend permission check. This drives what is SHOWN. It is never the thing
   * that protects an operation - the backend re-checks every write.
   */
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<Session>;
  register: (input: { businessName: string; name: string; email: string; phone?: string; password: string }) => Promise<Session>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setActiveStore: (storeId: string) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const queryClient = useQueryClient();

  const loadSession = React.useCallback(async () => {
    if (!tokenStore.get()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      const next = await authApi.me();
      setSession(next);
      // Default the active store on first load.
      if (!storeIdStore.get() && next.stores[0]) storeIdStore.set(next.stores[0].id);
    } catch {
      tokenStore.clear();
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSession();
  }, [loadSession]);

  React.useEffect(() => {
    // When a refresh finally fails, drop straight back to the sign-in screen.
    setSessionExpiredHandler(() => {
      tokenStore.clear();
      storeIdStore.clear();
      setSession(null);
      queryClient.clear();
    });
  }, [queryClient]);

  const applyAuthResult = (result: Session & { tokens: { accessToken: string } }) => {
    tokenStore.set(result.tokens.accessToken);
    if (result.stores[0]) storeIdStore.set(result.stores[0].id);
    const { ...next } = result;
    setSession(next);
    return next;
  };

  const value: AuthContextValue = {
    session,
    loading,
    activeStore:
      session?.stores.find((s) => s.id === storeIdStore.get()) ?? session?.stores[0] ?? null,
    isAdmin: session?.user.role === 'admin',
    isPlatformAdmin: session?.user.role === 'platform_admin',
    can: (permission: string) => {
      if (!session) return false;
      if (session.user.role === 'admin' || session.user.role === 'platform_admin') return true;
      return session.user.permissions.includes(permission);
    },
    login: async (email, password) => applyAuthResult(await authApi.login({ email, password })),
    register: async (input) => applyAuthResult(await authApi.register(input)),
    logout: async () => {
      try {
        await authApi.logout();
      } finally {
        tokenStore.clear();
        storeIdStore.clear();
        setSession(null);
        queryClient.clear();
      }
    },
    refresh: loadSession,
    setActiveStore: (storeId: string) => {
      storeIdStore.set(storeId);
      queryClient.clear();
      void loadSession();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
