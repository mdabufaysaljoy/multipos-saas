import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PosReturnsScreen } from '@/features/returns/PosReturnsScreen';
import { ShopExchangeDialog } from '@/features/supershop/ShopExchangeDialog';
import { ShopReceiptDialog } from '@/features/supershop/ShopReceiptDialog';
import { supershopApi } from '@/api/supershop';
import { storeApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import type { ShopSale } from '@/types/supershop';

/** What has come back in this branch, and the way to take something back. */
export function ShopReturnsPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  return (
    <>
      <PosReturnsScreen<ShopSale>
        title="Returns & exchanges"
        description="Return or exchange items against their original sale. Restocked goods go back on the shelf."
        noun={{ one: 'return', New: 'Return' }}
        listReturns={(params) => supershopApi.returns(params)}
        findSales={async (search) => {
          const page = await supershopApi.sales({ search, limit: 8, status: 'completed' });
          return { items: page.items.filter((sale) => !sale.fullyReturned) };
        }}
        summarise={(sale) => ({
          id: sale._id,
          number: sale.saleNumber,
          at: sale.soldAt,
          detail: `${sale.customerNameSnapshot || 'Walk-in'} · ${sale.items.length} line${sale.items.length === 1 ? '' : 's'}`,
          totalMinor: sale.totalMinor,
        })}
        linesOf={(sale) =>
          sale.items.map((line) => ({
            _id: line._id,
            label: line.nameSnapshot,
            detail: line.unitType === 'weight' ? 'by weight' : undefined,
            quantity: line.quantity,
            returnedQuantity: line.returnedQuantity,
            unitPriceMinor: line.unitPriceMinor,
            unitType: line.unitType,
          }))
        }
        createReturn={(saleId, input) => supershopApi.createReturn(saleId, input)}
        invalidate={['supershop']}
        searchPlaceholder="Return number, sale number or item…"
        renderExchange={(sale, onClose) => (
          <ShopExchangeDialog
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
      <ShopReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} />
    </>
  );
}
