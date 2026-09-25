import { PosImportScreen } from '@/features/import/PosImportScreen';
import { restaurantImportsApi } from '@/api/posImports';

/** Filling a menu from a spreadsheet. */
export function MenuImportPage() {
  return (
    <PosImportScreen
      title="Import menu"
      description="Create many dishes at once from an Excel or CSV file."
      api={restaurantImportsApi}
      backTo={{ href: '/menu', label: 'Back to the menu' }}
      invalidate="restaurant"
    />
  );
}
