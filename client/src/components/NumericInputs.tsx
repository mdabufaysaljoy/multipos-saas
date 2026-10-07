import * as React from 'react';
import { Input, type InputProps } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Fields that refuse letters.
 *
 * The brief was "no text in a number field", and that is exactly what these
 * do: a letter typed into one of them does not appear. The character is
 * dropped as it is typed, and a paste is filtered the same way, so there is
 * nothing to correct afterwards and no error to read.
 *
 * Phone fields hold digits and nothing else - no +, brackets, dashes or
 * spaces. `type="tel"` rather than `type="number"`: browsers will not autofill
 * a saved telephone number into a number input, because a phone number is not
 * arithmetic, and the filter already makes a letter impossible to type. Three
 * things this still drags in, handled rather than left to bite:
 *
 *  - A stored number that still has formatting - "+8801741918615" - renders as
 *    EMPTY in a number input, so opening a record and saving it would silently
 *    wipe the number. Incoming values are stripped to digits, so a legacy
 *    number loads as 8801741918615 and stays editable.
 *  - A scroll wheel over a focused number input changes it. On a till, which
 *    gets scrolled constantly, that is quiet data corruption. The wheel is
 *    ignored while the field has focus.
 *  - `maxLength` does nothing on a number input, so the digit cap is enforced
 *    by the filter instead.
 *
 * The other fields stay text with an `inputMode`, because a number input
 * reports a half-typed "7." as EMPTY - which is exactly the bug that made the
 * VAT rate turn 7.5 into 75.
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

/** Digits and nothing else. Also used to clean a stored value on the way in. */
const phoneFilter = (raw: string) => raw.replace(/\D/g, '').slice(0, 15);

export function PhoneInput({ value, onChange, ...rest }: FilteredProps) {
  const digits = phoneFilter(value ?? '');

  // A legacy "+8801741918615" would render empty and save as blank. Rewriting
  // it to digits once, on load, keeps the record intact.
  React.useEffect(() => {
    if (digits !== value) onChange(digits);
  }, [digits, value, onChange]);

  const handle = useFiltered(digits, onChange, phoneFilter);
  return (
    <Input
      {...rest}
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      value={digits}
      onChange={handle}
      // The spinner is meaningless on a phone number, and the wheel would
      // change it by accident.
      onWheel={(event) => event.currentTarget.blur()}
      className={cn('[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none', rest.className)}
    />
  );
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
