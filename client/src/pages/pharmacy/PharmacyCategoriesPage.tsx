import { PosCategoriesScreen } from '@/features/catalogue/PosCategoriesScreen';
import { pharmacyCategoriesApi } from '@/api/posCategories';

/** The categories this pharmacy groups its medicines under. */
export function PharmacyCategoriesPage() {
  return (
    <PosCategoriesScreen
      title="Categories"
      description="How medicines are grouped on the till. Renaming one moves every medicine that carries it; past sales keep the old name."
      noun={{ one: 'medicine', many: 'medicines' }}
      api={pharmacyCategoriesApi}
      invalidate={['pharmacy']}
    />
  );
}
