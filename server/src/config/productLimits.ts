/**
 * Universal catalogue limits for every POS vertical.
 *
 * Keep these values independent of plan codes: the codes are permanent billing
 * identifiers, while these tier names describe the package customers see.
 * `-1` is the entitlement system's existing unlimited sentinel.
 */
export const PRODUCT_LIMITS = {
  starter: 3_000,
  professional: 30_000,
  enterprise: -1,
} as const;
