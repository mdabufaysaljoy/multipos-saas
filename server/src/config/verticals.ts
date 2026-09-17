/**
 * POS verticals a workspace can run.
 *
 * Only `clothing` ships today; the rest are reserved so the field's allowed
 * values are settled before any other vertical module exists. A workspace's
 * vertical is decided by the server, never taken from a client request.
 */
export const POS_VERTICALS = ['clothing', 'restaurant', 'pharmacy', 'supershop', 'grocery'] as const;

export type PosVertical = (typeof POS_VERTICALS)[number];

/** Every workspace that predates verticals is a Clothing POS workspace. */
export const DEFAULT_POS_VERTICAL: PosVertical = 'clothing';

export const VERTICAL_LABELS: Record<PosVertical, string> = {
  clothing: 'Clothing',
  restaurant: 'Restaurant',
  pharmacy: 'Pharmacy',
  supershop: 'Supershop',
  grocery: 'Grocery',
};

/**
 * Verticals whose POS module actually ships, and which a customer may
 * therefore create a workspace for. Adding a vertical here is the switch that
 * opens it for sale; the client only ever displays this list.
 */
export const SELF_SERVE_VERTICALS: readonly PosVertical[] = ['clothing', 'restaurant', 'pharmacy', 'supershop'];

/**
 * Stable internal code of a platform POS product (see `models/PosProduct`).
 * Lowercase, starts with a letter, never changes once created.
 */
export const POS_PRODUCT_CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

/** Whether this code has a POS module in the codebase (and so can run a workspace). */
export const hasPosModule = (code: string): code is PosVertical =>
  (SELF_SERVE_VERTICALS as readonly string[]).includes(code);
