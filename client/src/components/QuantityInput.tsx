import * as React from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isQuantityDraft, parseQuantity, sanitizeDigits } from '@/lib/numeric';
import { cn } from '@/lib/utils';

export interface QuantityInputProps {
  /** null means the field is empty. It is a legitimate editing state. */
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  onEnter?: () => void;
  autoFocus?: boolean;
  showSteppers?: boolean;
}

/**
 * A whole-number input that behaves the way a cashier expects.
 *
 * The rules that matter, and why:
 *
 *  1. The field holds a STRING internally. React never re-formats what is being
 *     typed, so the caret does not jump and a partially typed value is never
 *     rewritten underneath the user.
 *  2. Clearing the field with Backspace leaves it EMPTY and reports `null`.
 *     There is no `|| 1`, no `|| 0.001`, no fallback of any kind - the classic
 *     way a quantity silently mutates into a nonsense decimal is to substitute
 *     a value for empty input, so this component never does that.
 *  3. Only digits are accepted. `.`, `e`, `+` and `-` are rejected at the
 *     keystroke, which makes a fractional quantity unrepresentable rather than
 *     merely validated-against.
 *  4. It is a text input with an inputMode, not `type="number"`, so a stray
 *     scroll wheel cannot change a quantity and the browser cannot hand back
 *     "" for a value it considers invalid.
 */
export const QuantityInput = React.forwardRef<HTMLInputElement, QuantityInputProps>(
  (
    {
      value,
      onChange,
      min = 0,
      max = 999_999,
      disabled,
      className,
      inputClassName,
      ariaLabel = 'Quantity',
      onEnter,
      autoFocus,
      showSteppers = true,
    },
    forwardedRef,
  ) => {
    const [draft, setDraft] = React.useState<string>(value === null ? '' : String(value));

    // Re-sync only when the parent's value genuinely differs from what the
    // draft represents. Without this guard, typing "10" would be rebuilt from
    // the parent on every keystroke and fight the user for the caret.
    React.useEffect(() => {
      const parsed = parseQuantity(draft);
      if (parsed !== value) {
        setDraft(value === null ? '' : String(value));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const emit = (next: string) => {
      setDraft(next);
      onChange(parseQuantity(next));
    };

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      // Empty is always allowed - this is the whole point.
      if (next === '') {
        emit('');
        return;
      }
      if (!isQuantityDraft(next)) return; // reject the keystroke outright
      const parsed = parseQuantity(next);
      if (parsed !== null && parsed > max) return;
      emit(next);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Block the characters that would create a non-integer.
      if (['e', 'E', '+', '-', '.', ','].includes(event.key)) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && onEnter) {
        event.preventDefault();
        onEnter();
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        step(1);
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        step(-1);
      }
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const digits = sanitizeDigits(event.clipboardData.getData('text'));
      if (digits === '') return;
      const parsed = parseQuantity(digits);
      if (parsed === null || parsed > max) return;
      emit(String(parsed));
    };

    const step = (delta: number) => {
      // Stepping from empty starts at the minimum sensible value.
      const current = parseQuantity(draft) ?? (delta > 0 ? min : min);
      const next = Math.min(max, Math.max(min, current + delta));
      emit(String(next));
    };

    const handleBlur = () => {
      // On blur an empty field stays empty. The checkout validator - not this
      // input - decides that an empty quantity blocks the sale.
      const parsed = parseQuantity(draft);
      if (parsed !== null && parsed < min) emit(String(min));
    };

    const numeric = parseQuantity(draft);
    const isEmpty = draft === '';
    const isInvalid = isEmpty || numeric === null || numeric < 1;

    return (
      <div className={cn('flex items-center', className)}>
        {showSteppers && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="rounded-r-none"
            disabled={disabled || (numeric ?? min) <= min}
            onClick={() => step(-1)}
            tabIndex={-1}
            aria-label="Decrease quantity"
          >
            <Minus />
          </Button>
        )}
        <Input
          ref={forwardedRef}
          // Text, not number: see rule 4 above.
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={handleBlur}
          onFocus={(e) => e.currentTarget.select()}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-invalid={isInvalid}
          placeholder="0"
          className={cn(
            'tabular h-8 w-16 text-center',
            showSteppers && 'rounded-none border-x-0',
            isInvalid && 'text-destructive',
            inputClassName,
          )}
        />
        {showSteppers && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="rounded-l-none"
            disabled={disabled || (numeric ?? 0) >= max}
            onClick={() => step(1)}
            tabIndex={-1}
            aria-label="Increase quantity"
          >
            <Plus />
          </Button>
        )}
      </div>
    );
  },
);
QuantityInput.displayName = 'QuantityInput';
