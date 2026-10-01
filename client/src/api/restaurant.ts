import { del, get, getPaginated, patch, post } from './client';
import type {
  DiningTable,
  KitchenTicketPayload,
  MenuItem,
  MenuAddOnRow,
  RestaurantDashboard,
  RestaurantOrder,
  RestaurantReceiptPayload,
  RestaurantReports,
  RestaurantShift,
  RestaurantSummary,
  ShiftPayload,
} from '@/types/restaurant';
import type { SaleCustomerFields } from '@/features/customers/CustomerPicker';

type Query = Record<string, unknown>;

/**
 * One line as a till sends it: what to make, and which version of it. Never a
 * price - the server prices the variant and every add-on from the menu.
 */
export interface OrderLineBody {
  menuItemId: string;
  /** Required when the dish has sizes; refused when it has none. */
  variantId?: string;
  /** The extras chosen, by option id. */
  addOnOptionIds?: string[];
  quantity: number;
  note?: string;
}

export interface CreateOrderInput extends SaleCustomerFields {
  type: 'dine_in' | 'takeaway';
  tableId?: string;
  items: OrderLineBody[];
  note?: string;
}

/**
 * Restaurant POS API. Prices are never sent: order lines carry a menu item and
 * a quantity, and the server prices them from the menu.
 */
export const restaurantApi = {
  menu: (params?: Query) => getPaginated<MenuItem>('/restaurant/menu', params),
  createMenuItem: (body: Record<string, unknown>) => post<MenuItem>('/restaurant/menu', body),
  updateMenuItem: (id: string, body: Record<string, unknown>) => patch<MenuItem>(`/restaurant/menu/${id}`, body),
  removeMenuItem: (id: string) => del<{ id: string }>(`/restaurant/menu/${id}`),

  /** The workspace's reusable extras: define one, pick it on any dish. */
  addOns: (params?: Query) => get<MenuAddOnRow[]>('/restaurant/addons', params),
  createAddOn: (body: { name: string; defaultPriceMinor: number; sortOrder?: number }) => post<MenuAddOnRow>('/restaurant/addons', body),
  updateAddOn: (id: string, body: { name?: string; defaultPriceMinor?: number; isActive?: boolean; sortOrder?: number }) =>
    patch<MenuAddOnRow>(`/restaurant/addons/${id}`, body),
  removeAddOn: (id: string) => del<{ id: string }>(`/restaurant/addons/${id}`),

  tables: () => get<DiningTable[]>('/restaurant/tables'),
  createTable: (body: { name: string; seats?: number }) => post<DiningTable>('/restaurant/tables', body),
  updateTable: (id: string, body: Record<string, unknown>) => patch<DiningTable>(`/restaurant/tables/${id}`, body),
  removeTable: (id: string) => del<{ id: string }>(`/restaurant/tables/${id}`),

  orders: (params?: Query) => getPaginated<RestaurantOrder>('/restaurant/orders', params),
  order: (id: string) => get<RestaurantOrder>(`/restaurant/orders/${id}`),
  createOrder: (body: CreateOrderInput) => post<RestaurantOrder>('/restaurant/orders', body),
  addItems: (id: string, items: OrderLineBody[]) => post<RestaurantOrder>(`/restaurant/orders/${id}/items`, { items }),
  updateLine: (id: string, lineId: string, quantity: number) =>
    patch<RestaurantOrder>(`/restaurant/orders/${id}/items/${lineId}`, { quantity }),
  removeLine: (id: string, lineId: string) => del<RestaurantOrder>(`/restaurant/orders/${id}/items/${lineId}`),
  pay: (
    id: string,
    body: {
      payments: { method: string; amountMinor: number }[];
      discountMinor: number;
      rev: number;
      /** The scanned card, and the points the cashier chose to redeem on it. */
      loyaltyMembershipId?: string;
      redeemPoints?: number;
    },
  ) =>
    post<RestaurantOrder>(`/restaurant/orders/${id}/pay`, body),

  cancel: (id: string, reason: string) => post<RestaurantOrder>(`/restaurant/orders/${id}/cancel`, { reason }),

  /**
   * Sends the order: the server works out what has not been sent yet and
   * answers with the order carrying its new token (a KOT number).
   */
  sendToKitchen: (id: string, rev: number) => post<RestaurantOrder>(`/restaurant/orders/${id}/send-to-kitchen`, { rev }),
  kitchenTicket: (orderId: string, ticketId: string) =>
    get<KitchenTicketPayload>(`/restaurant/orders/${orderId}/tickets/${ticketId}`),
  receipt: (id: string) => get<RestaurantReceiptPayload>(`/restaurant/orders/${id}/receipt`),
  /** The branch's open shift, or null. The server computes every cash figure. */
  currentShift: () => get<ShiftPayload | null>('/restaurant/shifts/current'),
  openShift: (body: { openingFloatMinor: number; note?: string }) => post<ShiftPayload>('/restaurant/shifts', body),
  cashMovement: (id: string, body: { type: 'pay_in' | 'pay_out'; amountMinor: number; reason: string }) =>
    post<ShiftPayload>(`/restaurant/shifts/${id}/cash-movements`, body),
  closeShift: (id: string, body: { countedCashMinor: number; note?: string }) =>
    post<ShiftPayload>(`/restaurant/shifts/${id}/close`, body),
  shifts: (params?: Query) => getPaginated<RestaurantShift>('/restaurant/shifts', params),
  shift: (id: string) => get<ShiftPayload>(`/restaurant/shifts/${id}`),
  reports: (params?: Query) => get<RestaurantReports>('/restaurant/reports', params),

  summary: (params?: Query) => get<RestaurantSummary>('/restaurant/summary', params),
  dashboard: (params?: Query) => get<RestaurantDashboard>('/restaurant/dashboard', params),
};
