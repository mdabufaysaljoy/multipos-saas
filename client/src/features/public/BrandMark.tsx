import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Retailer Suites, as a mark.
 *
 * The glyph is a till drawn from two stacked receipts - one product, many
 * shops - rather than a stock shopping icon, and it is inline SVG so it stays
 * crisp, themes with currentColor and costs no request.
 */
export function BrandMark({
  className,
  compact = false,
  tone = 'light',
}: {
  className?: string;
  compact?: boolean;
  /** `light` for dark backgrounds, `dark` for white ones. */
  tone?: 'light' | 'dark';
}) {
  return (
    <Link
      to="/"
      className={cn(
        'group inline-flex items-center gap-2.5 rounded-xl font-semibold tracking-tight outline-none transition focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2',
        tone === 'light' ? 'text-white focus-visible:ring-offset-[#050915]' : 'text-slate-950 focus-visible:ring-offset-white',
        className,
      )}
    >
      <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[0.65rem] bg-gradient-to-br from-indigo-500 via-indigo-500 to-cyan-400 shadow-[0_8px_24px_-8px_rgba(79,70,229,0.9)] transition-transform duration-300 group-hover:scale-[1.04]">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
          <path d="M5 8.5h14M5 8.5 6.6 4.8A1.4 1.4 0 0 1 7.9 4h8.2a1.4 1.4 0 0 1 1.3.8L19 8.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 8.5v9.9A1.6 1.6 0 0 0 6.6 20h10.8a1.6 1.6 0 0 0 1.6-1.6V8.5" stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M9.3 12.3h5.4M9.3 15.4h3.2" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity=".85" />
        </svg>
      </span>
      {!compact && (
        <span className="text-[15px] sm:text-[1.0625rem]">
          Retailer <span className="font-bold">Suites</span>
        </span>
      )}
      <span className="sr-only">Retailer Suites home</span>
    </Link>
  );
}
