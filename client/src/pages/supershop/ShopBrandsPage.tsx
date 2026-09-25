import { PosCategoriesScreen } from '@/features/catalogue/PosCategoriesScreen';
import { shopBrandsApi } from '@/api/shopBrands';

/**
 * The brands this shop sells under.
 *
 * Independent of Departments: a product has a department, a brand, both or
 * neither, and the till filters by each separately. Managed on the same screen
 * a department is, because it behaves identically - the product carries the
 * name, renaming moves every product that carries it, and a brand still on the
 * shelf is hidden rather than removed.
 */
export function ShopBrandsPage() {
  return (
    <PosCategoriesScreen
      title="Brands"
      description="The brands the shop sells under, separate from the departments. Renaming one moves every product that carries it; past sales keep the old name."
      noun={{ one: 'product', many: 'products' }}
      api={shopBrandsApi}
      invalidate={['supershop']}
      entityLabel="brand"
      maxNameLength={80}
    />
  );
}
