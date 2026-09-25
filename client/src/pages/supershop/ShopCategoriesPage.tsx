import { PosCategoriesScreen } from '@/features/catalogue/PosCategoriesScreen';
import { shopCategoriesApi } from '@/api/posCategories';

/** The departments this shop sells under. */
export function ShopCategoriesPage() {
  return (
    <PosCategoriesScreen
      title="Departments"
      description="How the shelves are grouped on the till. Renaming one moves every product that carries it; past sales keep the old name."
      noun={{ one: 'product', many: 'products' }}
      api={shopCategoriesApi}
      invalidate={['supershop']}
    />
  );
}
