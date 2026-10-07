import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Keeps a tab selection in the URL, so reloading lands where you were.
 *
 * Without it every tabbed screen snapped back to its first tab on reload -
 * which is exactly when you least want it, because a reload usually follows
 * saving something on the tab you were looking at. It also makes a tab
 * linkable: `/platform?tab=billing` opens the billing tab for whoever you send
 * it to.
 *
 * Three decisions worth knowing:
 *
 *  - The default tab writes NO parameter, so `/platform` stays `/platform`
 *    rather than growing `?tab=workspaces` the moment the page loads.
 *  - Switching tabs REPLACES the history entry instead of pushing one.
 *    Pushing would mean Back walks through every tab you clicked before it
 *    leaves the page, and people press Back to leave a page.
 *  - An unrecognised value falls back to the default. A hand-typed or stale
 *    link renders the first tab rather than a blank panel.
 *
 * Nested tabs each take their own key (`?tab=settings&section=website`), so an
 * inner tab survives a reload as well as the outer one.
 */
export function useTabParam(key: string, fallback: string, allowed: readonly string[]) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(key);
  const value = raw && allowed.includes(raw) ? raw : fallback;

  const setValue = React.useCallback(
    (next: string) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          if (next === fallback) updated.delete(key);
          else updated.set(key, next);
          return updated;
        },
        { replace: true },
      );
    },
    [key, fallback, setParams],
  );

  return [value, setValue] as const;
}
