import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import type { SiteSettings } from '@/types/site';

/**
 * The public website's own settings.
 *
 * One query, shared by every public page through React Query's cache, so the
 * header, the footer and the page body all read the same object and the site
 * cannot show two different brand names at once.
 *
 * It is deliberately long-lived. These values change a few times a year, the
 * server caches them for a minute anyway, and refetching them when somebody
 * tabs back to a pricing page buys nothing.
 */
export function useSite() {
  const { data } = useQuery({
    queryKey: ['public-site'],
    queryFn: () => get<SiteSettings>('/public/site'),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // The site must render before this resolves and if it never resolves:
    // a marketing page that fails to paint because a settings call failed
    // would be a worse outage than one showing its built-in defaults.
    retry: 1,
  });
  return data ?? null;
}

/** The brand name, falling back to the built-in one until the settings load. */
export function useSiteName() {
  return useSite()?.name || 'Retailer Suites';
}

/**
 * A phone number as a `tel:` URI.
 *
 * Keeps a leading `+` and digits and drops everything a human reads it by -
 * spaces, hyphens, brackets. Stripping only whitespace left `tel:+8801700-111222`,
 * which some dialers hand to the network verbatim.
 */
export const telHref = (phone: string) => `tel:${phone.trim().replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')}`;
