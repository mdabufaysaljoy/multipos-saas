import { PosReturnsScreen } from '@/features/returns/PosReturnsScreen';
import { supershopApi } from '@/api/supershop';
import type { ShopSale } from '@/types/supershop';

/** What has come back in this branch, and the way to take something back. */
export function ShopReturnsPage() {
  return (
    <PosReturnsScreen<ShopSale>
      title="Returns"
      description="Every return belongs to a sale. The goods go back on the shelf unless the till says otherwise."
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
        }))
      }
      createReturn={(saleId, input) => supershopApi.createReturn(saleId, input)}
      invalidate={['supershop']}
      searchPlaceholder="Return number, sale number or item…"
    />
  );
}
