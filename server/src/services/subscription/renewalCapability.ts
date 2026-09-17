import { paymentRegistry } from '../payment/registry';

/**
 * Whether anything can renew a subscription without the owner: the account
 * wallet, or a configured gateway that supports recurring charges. A manual
 * transfer, a bank payment or a one-off checkout cannot.
 */
export function canRenewAutomatically(subscription: { renewWith?: string | null; provider?: string | null }): boolean {
  if (subscription.renewWith === 'wallet') return true;
  return recurringProviderFor(subscription.provider) !== null;
}

/** The configured provider that can charge this subscription again, or null. */
export function recurringProviderFor(name: string | null | undefined) {
  if (!name) return null;
  try {
    const provider = paymentRegistry.get(name);
    return provider.isConfigured() && provider.supportsRecurring() && provider.chargeRecurring ? provider : null;
  } catch {
    return null;
  }
}
