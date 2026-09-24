import type { PosVertical } from '../../../config/verticals';
import { ApiError } from '../../../utils/ApiError';
import type { InventoryAdapter } from '../adapter';
import { clothingInventoryAdapter } from './clothing.adapter';
import { pharmacyInventoryAdapter } from './pharmacy.adapter';
import { restaurantInventoryAdapter } from './restaurant.adapter';
import { supershopInventoryAdapter } from './supershop.adapter';

/**
 * Shared code never touches a reservation's `detail` - that belongs to the
 * vertical that made it - so the registry hands out adapters whose detail type
 * is `never`. Ask a vertical's own adapter by name when you need to read it.
 */
const opaque = (adapter: InventoryAdapter<never> | unknown) => adapter as InventoryAdapter<never>;

const ADAPTERS: Partial<Record<PosVertical, InventoryAdapter<never>>> = {
  clothing: opaque(clothingInventoryAdapter),
  pharmacy: opaque(pharmacyInventoryAdapter),
  supershop: opaque(supershopInventoryAdapter),
  restaurant: opaque(restaurantInventoryAdapter),
};

/**
 * The stock behind a workspace, whichever POS it runs.
 *
 * Shared code asks for this and then talks in ids and quantities. Nothing
 * outside a vertical's own module should import that vertical's stock models.
 */
export function inventoryAdapterFor(vertical: PosVertical): InventoryAdapter<never> {
  const adapter = ADAPTERS[vertical];
  // `grocery` is a reserved code with no POS module; only four verticals ship.
  if (!adapter) throw ApiError.badRequest(`No POS module is available for "${vertical}"`);
  return adapter;
}

export { clothingInventoryAdapter, pharmacyInventoryAdapter, restaurantInventoryAdapter, supershopInventoryAdapter };
