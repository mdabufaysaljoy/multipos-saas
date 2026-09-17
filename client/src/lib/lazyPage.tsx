import { lazy, type ComponentType } from 'react';
import { LoadingState } from '@/components/states';

/**
 * Loads a page's code only when its route is first visited.
 *
 * Pages use named exports, while `React.lazy` needs a default export; this
 * adapts one to the other so page files did not have to change.
 */
export function lazyPage<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M & string) {
  return lazy(async () => ({ default: (await loader())[name] as ComponentType }));
}

/** Shown while a page's code downloads. */
export function PageFallback() {
  return <LoadingState label="Loading…" className="py-24" />;
}
