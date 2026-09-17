import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/hooks/useAuth';
import { ApiError } from '@/api/client';
import { AppRoutes } from '@/routes/AppRoutes';
import { PageFallback } from '@/lib/lazyPage';
import '@/index.css';

const queryClient = new QueryClient({
  /**
   * Plan usage changes as a side effect of almost every write: adding a
   * product, a customer, a staff member, a branch, recording a sale, uploading
   * an image. Refreshing it centrally means the usage meters and limit banners
   * cannot go stale because one mutation site forgot a line - which is exactly
   * what had happened across the ten places that create a limited resource.
   *
   * One small request per successful mutation, and never in response to reading
   * the subscription itself.
   */
  mutationCache: new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry a request the server has definitively rejected.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          {/* Catches pages outside any layout (sign-in, onboarding, platform admin). */}
          <React.Suspense fallback={<PageFallback />}>
            <AppRoutes />
          </React.Suspense>
          <Toaster position="top-right" richColors closeButton duration={4000} />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
