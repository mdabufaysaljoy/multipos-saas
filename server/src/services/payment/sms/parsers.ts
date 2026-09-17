import { PAYMENT_PROVIDERS } from '../../../config/constants';
import { decimalStringToMinor } from '../money';

/**
 * Provider-specific parsers for mobile-money payment SMS.
 *
 * One parser per provider, each declaring the sender ids it accepts and the
 * shapes it understands - never one regex for everything. A message whose
 * sender is not recognised, or whose shape does not match, yields null and is
 * recorded as rejected rather than guessed at.
 *
 * A parser extracts evidence ONLY. It decides nothing about money: whether the
 * transaction pays for anything is the matching engine's judgement.
 *
 * NOTE: the exact wording of live bKash/Nagad messages must be confirmed against
 * real samples per merchant account before enabling a parser in production; the
 * patterns below are deliberately anchored on the stable parts (amount,
 * TrxID/reference, sender, timestamp) and reject anything they do not recognise.
 */
export interface ParsedPaymentSms {
  provider: string;
  reference: string;
  amountMinor: number;
  currency: string;
  senderPhone: string;
  merchantAccount: string;
  occurredAt: Date | null;
}

export interface SmsParser {
  readonly provider: string;
  /** SMS sender ids this provider legitimately sends from, lower-cased. */
  readonly senders: readonly string[];
  parse(message: string): ParsedPaymentSms | null;
}

const clean = (message: string) => message.replace(/\s+/g, ' ').trim();
const digits = (value: string) => value.replace(/[^\d+]/g, '');

/** "1,234.50" -> 123450 minor units. Rejects anything that is not a plain amount. */
function amountToMinor(raw: string): number | null {
  const normalised = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  try {
    return decimalStringToMinor(normalised);
  } catch {
    return null;
  }
}

/**
 * bKash payment messages. The stable parts are the amount, the sender number
 * and "TrxID <reference>"; wording around them varies by message type, so the
 * parser keys on those and ignores the rest.
 */
class BkashSmsParser implements SmsParser {
  readonly provider = PAYMENT_PROVIDERS.BKASH;
  readonly senders = ['bkash'] as const;

  parse(message: string): ParsedPaymentSms | null {
    const text = clean(message);
    const reference = /\bTrxID\s*[:\s]\s*([A-Z0-9]{6,20})\b/i.exec(text)?.[1];
    const amount = /(?:Tk|BDT|৳)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text)?.[1];
    if (!reference || !amount) return null;
    const amountMinor = amountToMinor(amount);
    if (amountMinor === null) return null;

    return {
      provider: this.provider,
      reference: reference.toUpperCase(),
      amountMinor,
      currency: 'BDT',
      senderPhone: digits(/\bfrom\s+(\+?\d[\d\s-]{8,15})/i.exec(text)?.[1] ?? ''),
      merchantAccount: digits(/\bto\s+(\+?\d[\d\s-]{8,15})/i.exec(text)?.[1] ?? ''),
      occurredAt: null,
    };
  }
}

/**
 * Nagad payment messages. Nagad calls the reference "TxnID"; the amount and
 * sender are otherwise expressed the same way.
 */
class NagadSmsParser implements SmsParser {
  readonly provider = PAYMENT_PROVIDERS.NAGAD;
  readonly senders = ['nagad'] as const;

  parse(message: string): ParsedPaymentSms | null {
    const text = clean(message);
    const reference = /\b(?:TxnID|TrxID)\s*[:\s]\s*([A-Z0-9]{6,20})\b/i.exec(text)?.[1];
    const amount = /(?:Tk|BDT|৳)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text)?.[1];
    if (!reference || !amount) return null;
    const amountMinor = amountToMinor(amount);
    if (amountMinor === null) return null;

    return {
      provider: this.provider,
      reference: reference.toUpperCase(),
      amountMinor,
      currency: 'BDT',
      senderPhone: digits(/\bfrom\s+(\+?\d[\d\s-]{8,15})/i.exec(text)?.[1] ?? ''),
      merchantAccount: digits(/\bto\s+(\+?\d[\d\s-]{8,15})/i.exec(text)?.[1] ?? ''),
      occurredAt: null,
    };
  }
}

const PARSERS: SmsParser[] = [new BkashSmsParser(), new NagadSmsParser()];

/** The parser for a provider, or null when that provider is not supported. */
export const parserFor = (provider: string): SmsParser | null =>
  PARSERS.find((parser) => parser.provider === provider.trim().toLowerCase()) ?? null;

/** Whether an SMS sender id is one this provider legitimately sends from. */
export const isKnownSender = (provider: string, sender: string): boolean => {
  const parser = parserFor(provider);
  if (!parser) return false;
  const normalised = sender.trim().toLowerCase();
  return parser.senders.some((known) => normalised === known || normalised.includes(known));
};

export const supportedSmsProviders = (): string[] => PARSERS.map((parser) => parser.provider);

/**
 * Mobile-money numbers are written differently everywhere - "01700-111222",
 * "+8801700111222", "01700 111222" - so they are only ever compared as digits,
 * and only by their last 11 (the national number), never as free text.
 */
export const accountKey = (value: string): string => {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 11 ? digits.slice(-11) : digits;
};
