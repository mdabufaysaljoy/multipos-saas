/**
 * Clothing is sold in whole units. Every quantity that enters the system is
 * validated here so a fractional value such as 0.001 can never be persisted,
 * no matter what the client sends.
 */
export const isValidQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const isNonNegativeQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
