import { useAuth } from '@/hooks/useAuth';
import { lazyPage } from '@/lib/lazyPage';

// Loaded separately so a workspace only downloads its own vertical's dashboard.
const DashboardPage = lazyPage(() => import('@/pages/DashboardPage'), 'DashboardPage');
const RestaurantDashboardPage = lazyPage(
  () => import('@/pages/restaurant/RestaurantDashboardPage'),
  'RestaurantDashboardPage',
);
const PharmacyDashboardPage = lazyPage(() => import('@/pages/pharmacy/PharmacyDashboardPage'), 'PharmacyDashboardPage');
const SupershopDashboardPage = lazyPage(() => import('@/pages/supershop/SupershopDashboardPage'), 'SupershopDashboardPage');

/** `/dashboard` is the dashboard for whichever POS vertical the workspace runs. */
export function VerticalDashboard() {
  const { session } = useAuth();
  const vertical = session?.tenant?.vertical;
  if (vertical === 'restaurant') return <RestaurantDashboardPage />;
  if (vertical === 'pharmacy') return <PharmacyDashboardPage />;
  if (vertical === 'supershop') return <SupershopDashboardPage />;
  return <DashboardPage />;
}
