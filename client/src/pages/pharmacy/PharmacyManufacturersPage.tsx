import { pharmacyManufacturersApi } from '@/api/pharmacyManufacturers';
import { PosCategoriesScreen } from '@/features/catalogue/PosCategoriesScreen';

export function PharmacyManufacturersPage() {
  return (
    <PosCategoriesScreen
      title="Manufacturers"
      description="Manage the medicine manufacturers shown in Pharmacy product forms and POS filters. Renaming one updates its medicines."
      noun={{ one: 'medicine', many: 'medicines' }}
      api={pharmacyManufacturersApi}
      invalidate={['pharmacy']}
      entityLabel="manufacturer"
      maxNameLength={120}
    />
  );
}
