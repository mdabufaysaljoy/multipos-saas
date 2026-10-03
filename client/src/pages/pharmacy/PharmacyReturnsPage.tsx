import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PosReturnsScreen } from '@/features/returns/PosReturnsScreen';
import { PharmacyExchangeDialog } from '@/features/pharmacy/PharmacyExchangeDialog';
import { PharmacyReceiptDialog } from '@/features/pharmacy/PharmacyReceiptDialog';
import { pharmacyApi } from '@/api/pharmacy';
import { storeApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import type { PharmacySale } from '@/types/pharmacy';

/** Returns and exchanges; medicines return to the batch they came out of. */
export function PharmacyReturnsPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  return (
    <>
      <PosReturnsScreen<PharmacySale>
        title="Returns & exchanges"
        description="Return medicines or exchange them for an equal-or-higher-value replacement. Restocked medicines return to their original batches."
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
        exchangeForAnyStaff
        renderExchange={(sale, onClose) => (
          <PharmacyExchangeDialog
            sale={sale}
            currency={currency}
            posConfig={posConfig}
            onClose={onClose}
            onDone={(replacementSaleId) => {
              onClose();
              setReceiptFor(replacementSaleId);
            }}
          />
        )}
      />
      <PharmacyReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} />
    </>
  );
}
