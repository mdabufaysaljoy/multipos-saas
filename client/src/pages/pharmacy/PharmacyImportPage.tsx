import { PosImportScreen } from '@/features/import/PosImportScreen';
import { pharmacyImportsApi } from '@/api/posImports';

/** Filling a pharmacy catalogue from a spreadsheet. Stock is received separately. */
export function PharmacyImportPage() {
  return (
    <PosImportScreen
      title="Import medicines"
      description="Create medicines from Excel or CSV. For Excel workbooks, choose the worksheet to import before validating it."
      api={pharmacyImportsApi}
      backTo={{ href: '/medicines', label: 'Back to medicines' }}
      invalidate="pharmacy"
      allowWorksheetSelection
    />
  );
}
