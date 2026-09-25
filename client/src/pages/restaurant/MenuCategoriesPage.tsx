import { PosCategoriesScreen } from '@/features/catalogue/PosCategoriesScreen';
import { restaurantCategoriesApi } from '@/api/posCategories';

/** The sections the menu is served in. */
export function MenuCategoriesPage() {
  return (
    <PosCategoriesScreen
      title="Menu sections"
      description="How the menu is grouped on the till. Renaming one moves every dish that carries it; past orders keep the old name."
      noun={{ one: 'dish', many: 'dishes' }}
      api={restaurantCategoriesApi}
      invalidate={['restaurant']}
    />
  );
}
