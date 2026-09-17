import { useAuth } from '@/hooks/useAuth';
import { lazyPage } from '@/lib/lazyPage';

// Loaded separately so a workspace only downloads its own vertical's POS.
const PosPage = lazyPage(() => import('@/pages/PosPage'), 'PosPage');
const RestaurantPosPage = lazyPage(() => import('@/pages/restaurant/RestaurantPosPage'), 'RestaurantPosPage');
const PharmacyPosPage = lazyPage(() => import('@/pages/pharmacy/PharmacyPosPage'), 'PharmacyPosPage');
const SupershopPosPage = lazyPage(() => import('@/pages/supershop/SupershopPosPage'), 'SupershopPosPage');

/** `/pos` is the point of sale for whichever POS vertical the workspace runs. */
export function VerticalPos() {
  const { session } = useAuth();
  const vertical = session?.tenant?.vertical;
  if (vertical === 'restaurant') return <RestaurantPosPage />;
  if (vertical === 'pharmacy') return <PharmacyPosPage />;
  if (vertical === 'supershop') return <SupershopPosPage />;
  return <PosPage />;
}
