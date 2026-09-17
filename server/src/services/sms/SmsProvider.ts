export interface SendSmsInput {
  /** E.164 or local format; the provider adapter normalises it. */
  to: string;
  message: string;
  /** Optional sender/mask ID where the provider supports one. */
  senderId?: string;
}

export interface SendSmsResult {
  success: boolean;
  providerMessageId: string | null;
  /** Provider-reported cost, when it returns one. */
  providerCostMinor: number | null;
  error?: string;
  raw?: unknown;
}

export interface ProviderBalance {
  balanceMinor: number | null;
  currency: string | null;
  raw?: unknown;
}

/**
 * Contract every SMS gateway implements.
 *
 * Adding a provider means adding one adapter and registering it - no change to
 * billing, history or the campaign logic.
 */
export interface SmsProvider {
  readonly name: string;
  readonly displayName: string;
  /** False when credentials are missing; unconfigured providers refuse to send. */
  isConfigured(): boolean;
  send(input: SendSmsInput): Promise<SendSmsResult>;
  /** Provider account balance, where the API exposes it. */
  getBalance?(): Promise<ProviderBalance>;
}

export class SmsProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`The "${provider}" SMS provider is not configured. Set its credentials in the environment.`);
    this.name = 'SmsProviderNotConfiguredError';
  }
}

/**
 * SMS is billed per SEGMENT, and the segment size depends on the alphabet.
 * GSM-7 fits 160 characters; anything outside it (Bengali, emoji) forces UCS-2
 * at 70 characters. Getting this wrong would under-charge every Bengali
 * campaign, so it is computed here rather than assumed.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = '^{}\\[~]|€';

export const isGsm7 = (text: string): boolean =>
  [...text].every((char) => GSM7.includes(char) || GSM7_EXTENDED.includes(char));

export interface SegmentInfo {
  encoding: 'GSM7' | 'UCS2';
  characters: number;
  segments: number;
  charactersPerSegment: number;
}

export function countSegments(message: string): SegmentInfo {
  const gsm = isGsm7(message);

  // Extended GSM characters occupy two septets each.
  const length = gsm
    ? [...message].reduce((sum, char) => sum + (GSM7_EXTENDED.includes(char) ? 2 : 1), 0)
    : [...message].length;

  const single = gsm ? 160 : 70;
  // Concatenated messages lose room to the UDH header.
  const multi = gsm ? 153 : 67;

  const segments = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi);

  return { encoding: gsm ? 'GSM7' : 'UCS2', characters: length, segments, charactersPerSegment: single };
}
