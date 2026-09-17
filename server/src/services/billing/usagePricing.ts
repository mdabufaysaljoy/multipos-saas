import { getPlatformSettings } from '../../models/PlatformSettings';
import { USAGE_SERVICES, type UsageService } from '../../models/UsageCharge';
import { ApiError } from '../../utils/ApiError';

/**
 * Per-use prices, all set by the platform admin in platform settings. Nothing
 * here is a price: this maps each service to the setting that holds its price,
 * so SMS and email keep using the fields they always have.
 */
export const USAGE_UNITS: Record<UsageService, { unit: string; label: string }> = {
  sms: { unit: 'segment', label: 'SMS' },
  email: { unit: 'email', label: 'Email' },
  ai: { unit: 'request', label: 'AI' },
  storage: { unit: 'GB-month', label: 'Storage' },
};

type PriceFields = {
  smsCostMinor?: number;
  emailCostMinor?: number;
  aiRequestCostMinor?: number;
  storageGbMonthCostMinor?: number;
};

const PRICE_FIELD: Record<UsageService, keyof PriceFields> = {
  sms: 'smsCostMinor',
  email: 'emailCostMinor',
  ai: 'aiRequestCostMinor',
  storage: 'storageGbMonthCostMinor',
};

function readPrice(settings: PriceFields, service: UsageService): number {
  // A price not yet configured (a settings document from before the field
  // existed) is free. A configured but invalid price is refused outright
  // rather than billed at some guessed amount.
  const value = settings[PRICE_FIELD[service]] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw ApiError.internal('Usage pricing is misconfigured. Contact support.');
  }
  return value;
}

export async function unitPriceMinor(service: UsageService): Promise<number> {
  return readPrice((await getPlatformSettings()) as PriceFields, service);
}

/** The public price list: unit and price per service, nothing else. */
export async function usagePriceList() {
  const settings = (await getPlatformSettings()) as PriceFields & { currency?: string };
  return USAGE_SERVICES.map((service) => ({
    service,
    label: USAGE_UNITS[service].label,
    unit: USAGE_UNITS[service].unit,
    unitPriceMinor: readPrice(settings, service),
    currency: settings.currency ?? 'BDT',
  }));
}
