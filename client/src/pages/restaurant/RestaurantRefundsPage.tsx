import { PosReturnsScreen } from '@/features/returns/PosReturnsScreen';
import { restaurantApi } from '@/api/restaurant';
import type { RestaurantOrder } from '@/types/restaurant';

const matches = (order: RestaurantOrder, search: string) => {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [order.orderNumber, order.customerNameSnapshot, order.tableNameSnapshot].some((value) => (value ?? '').toLowerCase().includes(needle));
};

/** Money refunded against paid orders. A kitchen keeps no stock, so nothing is restocked. */
export function RestaurantRefundsPage() {
  return (
    <PosReturnsScreen<RestaurantOrder>
      title="Refunds"
      description="Money back against a paid order. Nothing is restocked: a kitchen keeps no shelf."
      noun={{ one: 'refund', New: 'Refund' }}
      listReturns={(params) => restaurantApi.returns(params)}
      // Orders are not searched on the server, so the recent paid ones are filtered here.
      findSales={async (search) => {
        const page = await restaurantApi.orders({ limit: 25, status: 'paid' });
        return { items: page.items.filter((order) => !order.fullyReturned && matches(order, search)).slice(0, 8) };
      }}
      summarise={(order) => ({
        id: order._id,
        number: order.orderNumber,
        at: order.paidAt ?? order.createdAt,
        detail: [order.tableNameSnapshot || order.type, order.customerNameSnapshot || 'Walk-in'].filter(Boolean).join(' · '),
        totalMinor: order.totalMinor,
      })}
      linesOf={(order) =>
        order.items
          .filter((line) => !line.voidedAt && line.quantity > 0)
          .map((line) => ({
            _id: line._id,
            label: line.nameSnapshot,
            quantity: line.quantity,
            returnedQuantity: line.returnedQuantity,
            unitPriceMinor: line.unitPriceMinor,
          }))
      }
      createReturn={(orderId, input) =>
        restaurantApi.createReturn(orderId, {
          items: input.items.map(({ saleItemId, quantity }) => ({ saleItemId, quantity })),
          reason: input.reason,
          refundMethod: input.refundMethod,
        })
      }
      invalidate={['restaurant']}
      restockable={false}
      searchPlaceholder="Refund number or order number…"
    />
  );
}
