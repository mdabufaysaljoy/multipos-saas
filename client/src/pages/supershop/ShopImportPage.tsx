import { PosImportScreen } from '@/features/import/PosImportScreen';
import { shopImportsApi } from '@/api/posImports';

/** Filling a Super Shop catalogue from a spreadsheet. */
export function ShopImportPage() {
  return (
    <PosImportScreen
      title="Import products"
      description="Create many products at once from an Excel or CSV file, with their opening stock."
      api={shopImportsApi}
      backTo={{ href: '/shop-products', label: 'Back to products' }}
      invalidate="supershop"
    />
  );
}
