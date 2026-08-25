import * as React from 'react';
import { Input } from '@/components/ui/input';
import { isMoneyDraft, minorToMoneyString, parseMoneyToMinor } from '@/lib/money';
import { cn } from '@/lib/utils';

export interface MoneyInputProps {
  /** Amount in MINOR units. null means the field is empty. */
  value: number | null;
  onChange: (minor: number | null) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  currencySymbol?: string;
  onEnter?: () => void;
  autoFocus?: boolean;
  max?: number;
}

/**
 * Money input over integer minor units.
 *
 * It follows the same discipline as QuantityInput: a string draft, an empty
 * state that stays empty, and no fallback value. It additionally guarantees
 * that no floating-point arithmetic ever touches the amount - "1234.5" is
 * converted to 123450 by splitting the string, so a price cannot drift by a
 * fraction of a unit no matter how it is edited.
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  (
    {
      value,
      onChange,
      disabled,
      className,
      placeholder = '0.00',
      ariaLabel = 'Amount',
      currencySymbol = '৳',
      onEnter,
      autoFocus,
      max = 99_999_999_99,
    },
    forwardedRef,
  ) => {
    const [draft, setDraft] = React.useState<string>(value === null ? '' : minorToMoneyString(value));

    React.useEffect(() => {
      const parsed = parseMoneyToMinor(draft);
      if (parsed !== value) {
        setDraft(value === null ? '' : minorToMoneyString(value));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const emit = (next: string) => {
      setDraft(next);
      onChange(parseMoneyToMinor(next));
    };

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      if (next === '') {
        // Deleting everything leaves the field empty and reports null. It does
        // NOT become 0, 0.001, or the previous value.
        emit('');
        return;
      }
      if (!isMoneyDraft(next)) return;
      const parsed = parseMoneyToMinor(next);
      if (parsed !== null && parsed > max) return;
      // "12." is kept verbatim so the user can carry on typing the decimals.
      emit(next);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (['e', 'E', '+', '-'].includes(event.key)) {
        event.preventDefault();
        return;
      }
      // Only one decimal point is ever allowed.
      if (event.key === '.' && draft.includes('.')) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && onEnter) {
        event.preventDefault();
        onEnter();
      }
    };

    const handleBlur = () => {
      // Tidy the presentation on blur, but only when there is a real value.
      // An empty field is left empty.
      const parsed = parseMoneyToMinor(draft);
      if (parsed === null) return;
      setDraft(minorToMoneyString(parsed));
    };

    const isInvalid = draft === '' || parseMoneyToMinor(draft) === null || (parseMoneyToMinor(draft) ?? 0) <= 0;

    return (
      <div className={cn('relative', className)}>
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
          {currencySymbol}
        </span>
        <Input
          ref={forwardedRef}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onFocus={(e) => e.currentTarget.select()}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-invalid={isInvalid}
          placeholder={placeholder}
          className={cn('tabular pl-7 text-right', isInvalid && 'text-destructive')}
        />
      </div>
    );
  },
);
MoneyInput.displayName = 'MoneyInput';
