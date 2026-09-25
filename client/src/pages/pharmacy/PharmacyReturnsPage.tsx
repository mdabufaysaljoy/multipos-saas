import { PosReturnsScreen } from '@/features/returns/PosReturnsScreen';
import { pharmacyApi } from '@/api/pharmacy';
import type { PharmacySale } from '@/types/pharmacy';

/** What has come back in this branch. Medicines return to the batch they came out of. */
export function PharmacyReturnsPage() {
  return (
    <PosReturnsScreen<PharmacySale>
      title="Returns"
      description="Every return belongs to a sale. Medicines go back into the batch they were sold from, unless the till says otherwise."
      noun={{ one: 'return', New: 'Return' }}
      listReturns={(params) => pharmacyApi.returns(params)}
      findSales={async (search) => {
        const page = await pharmacyApi.sales({ search, limit: 8, status: 'completed' });
        return { items: page.items.filter((sale) => !sale.fullyReturned) };
      }}
      summarise={(sale) => ({
        id: sale._id,
        number: sale.saleNumber,
        at: sale.soldAt,
        detail: `${sale.customerNameSnapshot || sale.prescription?.patientName || 'Walk-in'} · ${sale.items.length} line${sale.items.length === 1 ? '' : 's'}`,
        totalMinor: sale.totalMinor,
      })}
      linesOf={(sale) =>
        sale.items.map((line) => ({
          _id: line._id,
          label: line.nameSnapshot,
          detail: [line.strengthSnapshot, line.dosageFormSnapshot].filter(Boolean).join(' · ') || undefined,
          quantity: line.quantity,
          returnedQuantity: line.returnedQuantity,
          unitPriceMinor: line.unitPriceMinor,
        }))
      }
      createReturn={(saleId, input) => pharmacyApi.createReturn(saleId, input)}
      invalidate={['pharmacy']}
      searchPlaceholder="Return number, sale number or medicine…"
    />
  );
}
