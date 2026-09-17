import { ApiError } from '../../utils/ApiError';
import type { RenewalResult, RenewalState } from '../../services/subscription/walletRenewal.service';

/** Machine-readable codes for a renewal that did not happen. */
const REFUSAL_CODES: Record<Exclude<RenewalState, 'renewed' | 'already_renewed'>, string> = {
  insufficient_funds: 'INSUFFICIENT_FUNDS',
  failed: 'RENEWAL_FAILED',
  in_progress: 'RENEWAL_IN_PROGRESS',
  not_due: 'RENEWAL_NOT_DUE',
  not_renewable: 'NOT_RENEWABLE',
};

export const renewalSucceeded = (result: RenewalResult) => result.state === 'renewed' || result.state === 'already_renewed';

/**
 * A renewal that did not happen is a 409 carrying the billing state - the
 * price that applies, the wallet balance, the unchanged period end - so the
 * caller can say exactly why and what to do.
 */
export function assertRenewed(result: RenewalResult) {
  if (renewalSucceeded(result)) return result;
  const state = result.state as keyof typeof REFUSAL_CODES;
  throw ApiError.conflict(result.message, { reason: REFUSAL_CODES[state], billing: result });
}
