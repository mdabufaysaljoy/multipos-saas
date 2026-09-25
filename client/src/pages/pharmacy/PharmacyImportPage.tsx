import { PosImportScreen } from '@/features/import/PosImportScreen';
import { pharmacyImportsApi } from '@/api/posImports';

/** Filling a pharmacy catalogue from a spreadsheet, batches and all. */
export function PharmacyImportPage() {
  return (
    <PosImportScreen
      title="Import medicines"
      description="Create many medicines at once from an Excel or CSV file. A row carrying a batch, an expiry and a quantity also receives its opening stock."
      api={pharmacyImportsApi}
      backTo={{ href: '/medicines', label: 'Back to medicines' }}
      invalidate="pharmacy"
    />
  );
}
