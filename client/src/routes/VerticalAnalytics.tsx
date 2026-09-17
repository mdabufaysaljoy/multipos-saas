import { useAuth } from '@/hooks/useAuth';
import { lazyPage } from '@/lib/lazyPage';

// Loaded separately so a workspace only downloads its own vertical's analytics.
const ReportsPage = lazyPage(() => import('@/pages/ReportsPage'), 'ReportsPage');
const RestaurantReportsPage = lazyPage(
  () => import('@/pages/restaurant/RestaurantReportsPage'),
  'RestaurantReportsPage',
);
const PharmacyReportsPage = lazyPage(() => import('@/pages/pharmacy/PharmacyReportsPage'), 'PharmacyReportsPage');
const SupershopReportsPage = lazyPage(() => import('@/pages/supershop/SupershopReportsPage'), 'SupershopReportsPage');

/** `/analytics` is Advanced Analytics for whichever POS vertical the workspace runs. */
export function VerticalAnalytics() {
  const { session } = useAuth();
  const vertical = session?.tenant?.vertical;
  if (vertical === 'restaurant') return <RestaurantReportsPage />;
  if (vertical === 'pharmacy') return <PharmacyReportsPage />;
  if (vertical === 'supershop') return <SupershopReportsPage />;
  return <ReportsPage />;
}
