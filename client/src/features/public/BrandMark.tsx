import { Link } from 'react-router-dom';
import { Store } from 'lucide-react';
import { cn } from '@/lib/utils';

export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <Link to="/" className={cn('group inline-flex items-center gap-2.5 font-semibold tracking-tight', className)}>
      <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-slate-950 text-white shadow-lg shadow-primary/15">
        <span className="absolute inset-x-1 top-1 h-2 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 opacity-90" />
        <Store className="relative mt-1 h-4 w-4" aria-hidden="true" />
      </span>
      {!compact && (
        <span className="text-[15px] sm:text-base">
          Retailer<span className="text-primary">SWs</span>
        </span>
      )}
      <span className="sr-only">RetailerSWs home</span>
    </Link>
  );
}
