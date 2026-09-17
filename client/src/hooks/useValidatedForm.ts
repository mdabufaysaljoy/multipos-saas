import * as React from 'react';
import type { ZodTypeAny } from 'zod';

export interface ValidationResult<T> {
  /** Field errors, keyed by the schema path. Empty while untouched. */
  errors: Record<string, string>;
  /** True when the whole schema passes, whether or not fields were touched. */
  valid: boolean;
  /** The parsed value when valid, otherwise null. */
  parsed: T | null;
  /** Error for one field, but only after the user has been there. */
  errorFor: (field: string) => string | undefined;
  /** Mark a field as visited, so its error may be shown. */
  touch: (field: string) => void;
  /** Reveal every error at once — call this on a failed submit attempt. */
  touchAll: () => void;
  reset: () => void;
}

/**
 * Validates a plain state object against a Zod schema.
 *
 * The existing forms hold their values in `useState` and compute an `invalid`
 * boolean by hand. This gives them real per-field rules and messages without
 * rewriting them onto react-hook-form, which would mean touching a lot of
 * working code to change how it stores a string.
 *
 * Errors stay hidden until a field is touched, so a form does not open covered
 * in red.
 */
export function useValidatedForm<T>(schema: ZodTypeAny, values: unknown): ValidationResult<T> {
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = React.useState(false);

  const { errors, valid, parsed } = React.useMemo<{
    errors: Record<string, string>;
    valid: boolean;
    parsed: T | null;
  }>(() => {
    const result = schema.safeParse(values);
    if (result.success) return { errors: {}, valid: true, parsed: result.data as T };

    const map: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_form';
      // First message per field: the earliest rule is the most specific.
      if (!map[key]) map[key] = issue.message;
    }
    return { errors: map, valid: false, parsed: null };
  }, [schema, values]);

  return {
    errors,
    valid,
    parsed,
    errorFor: (field) => (showAll || touched[field] ? errors[field] : undefined),
    touch: (field) => setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true })),
    touchAll: () => setShowAll(true),
    reset: () => {
      setTouched({});
      setShowAll(false);
    },
  };
}
