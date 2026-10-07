import * as React from 'react';
import { Input, type InputProps } from '@/components/ui/input';

/**
 * Fields that refuse letters.
 *
 * The brief was "no text in a number field", and that is exactly what these
 * do: a letter typed into one of them does not appear. The character is
 * dropped as it is typed, and a paste is filtered the same way, so there is
 * nothing to correct afterwards and no error to read.
 *
 * WHY NOT `type="number"`, which is the obvious answer:
 *
 *  - It cannot hold a phone number. `+880 1700-111222` and `(880) 1700 111222`
 *    are not parseable as numbers, so the browser discards them - and those are
 *    the formats this product accepts and that people here actually write.
 *  - It loses a decimal while it is being typed. Browsers report a half-typed
 *    "7." as an EMPTY value, which is exactly the bug that made the VAT rate
 *    field turn 7.5 into 75.
 *  - A scroll wheel over a focused number input silently changes it. On a
 *    price or a stock count that is a quiet data-corruption bug, and tills get
 *    scrolled constantly.
 *  - Its default `step` of 1 marks every decimal invalid.
 *
 * `inputMode` is what actually matters on the tablet a till runs on: it chooses
 * the on-screen keypad. These set it correctly and keep the value a string, so
 * what the person typed is what the form holds.
 */

type FilteredProps = Omit<InputProps, 'onChange' | 'value' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
};

/** Applies a filter on every change, including pastes, and keeps the caret sane. */
function useFiltered(value: string, onChange: (next: string) => void, filter: (raw: string) => string) {
  return React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = filter(event.target.value);
      // Only report a real change: a rejected keystroke must not re-render the
      // field with the same value and jump the caret to the end.
      if (next !== value) onChange(next);
      else if (next !== event.target.value) event.target.value = next;
    },
    [value, onChange, filter],
  );
}

/**
 * A phone number.
 *
 * Keeps digits and the punctuation people write numbers with. `type="tel"` is
 * the correct type here - it asks for a telephone keypad without pretending
 * the value is arithmetic.
 */
const phoneFilter = (raw: string) => raw.replace(/[^\d+()\-\s]/g, '').slice(0, 32);

export function PhoneInput({ value, onChange, ...rest }: FilteredProps) {
  const handle = useFiltered(value, onChange, phoneFilter);
  return <Input {...rest} type="tel" inputMode="tel" autoComplete="tel" value={value} onChange={handle} />;
}

/**
 * A whole number: stock counts, pieces, quantities.
 *
 * No sign and no decimal point, because none of those fields takes one.
 */
const integerFilter = (max: number) => (raw: string) => raw.replace(/\D/g, '').slice(0, max);

export function IntegerInput({ value, onChange, maxDigits = 12, ...rest }: FilteredProps & { maxDigits?: number }) {
  const filter = React.useMemo(() => integerFilter(maxDigits), [maxDigits]);
  const handle = useFiltered(value, onChange, filter);
  return <Input {...rest} type="text" inputMode="numeric" value={value} onChange={handle} />;
}

/**
 * A decimal: prices, weights, percentages.
 *
 * One decimal point only, and a bounded number of places. A half-typed "7." is
 * deliberately allowed to exist - that intermediate state is what a person
 * types on the way to 7.5, and refusing it is what made the tax rate field
 * swallow the dot.
 */
const decimalFilter = (places: number) => (raw: string) => {
  let cleaned = raw.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    // Keep the first dot, drop any others.
    cleaned = `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
    const [whole, fraction = ''] = cleaned.split('.');
    cleaned = `${whole.slice(0, 12)}.${fraction.slice(0, places)}`;
  } else {
    cleaned = cleaned.slice(0, 12);
  }
  return cleaned;
};

export function DecimalInput({ value, onChange, places = 2, ...rest }: FilteredProps & { places?: number }) {
  const filter = React.useMemo(() => decimalFilter(places), [places]);
  const handle = useFiltered(value, onChange, filter);
  return <Input {...rest} type="text" inputMode="decimal" value={value} onChange={handle} />;
}

/** Exported for tests and for forms that filter a value before storing it. */
export const filters = { phone: phoneFilter, integer: integerFilter, decimal: decimalFilter };
