import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { BrandMark } from './BrandMark';
import { AuthScene, type SceneState } from './AuthScene';

/**
 * The shell both authentication pages share.
 *
 * A split composition on desktop - the counter scene on the left, the form on
 * the right - reflowing on a phone to branding, then the visual, then the form,
 * with the visual shrunk so the fields are not pushed below the fold.
 *
 * `.public-shell` is deliberate: it brings the website's design tokens and,
 * more importantly, its `prefers-reduced-motion` rules, so the scene respects
 * them without a second implementation.
 */
export function AuthShell({
  children,
  eyebrow,
  title,
  copy,
  sceneState = 'idle',
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
  copy: string;
  /** Drives the scene. The page passes the REAL request state. */
  sceneState?: SceneState;
}) {
  return (
    <div className="public-shell relative min-h-full bg-[#050915] text-white">
      <div aria-hidden className="rs-aurora opacity-50" />
      <div aria-hidden className="rs-grid" />

      <div className="relative grid min-h-full lg:grid-cols-2">
        {/* ------------------------------------------------------- visual */}
        <aside className="flex flex-col px-5 pb-2 pt-6 sm:px-8 lg:px-12 lg:py-10 xl:px-16">
          <div className="flex items-center justify-between gap-4">
            <BrandMark />
            <Link
              to="/"
              className="group inline-flex items-center gap-1.5 rounded text-[0.8125rem] font-medium text-slate-400 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-translate-x-0.5" aria-hidden />
              <span className="hidden sm:inline">Back to site</span>
              <span className="sm:hidden">Back</span>
            </Link>
          </div>

          <div className="my-auto w-full py-8 lg:py-14">
            {/* Smaller on a phone: the visual sets the tone, the form does the work. */}
            <AuthScene state={sceneState} className="mx-auto max-w-[19rem] sm:max-w-[24rem] lg:max-w-[27rem]" />

            <div className="mx-auto mt-10 hidden max-w-md text-center lg:block">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-indigo-300">{eyebrow}</p>
              <h2 className="rs-h2 mt-4 text-[1.75rem] font-bold text-white">{title}</h2>
              <p className="mt-3 text-[0.9375rem] leading-7 text-slate-400">{copy}</p>
            </div>
          </div>
        </aside>

        {/* --------------------------------------------------------- form */}
        <main className="flex items-start justify-center px-5 pb-12 pt-2 sm:px-8 lg:items-center lg:px-12 lg:py-10 xl:px-16">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** The heading block above each form. Same rhythm on both pages. */
export function AuthHeading({ title, copy, className }: { title: string; copy: string; className?: string }) {
  return (
    <div className={cn('mb-8', className)}>
      <h1 className="rs-h2 text-[1.875rem] font-bold text-white sm:text-[2.125rem]">{title}</h1>
      <p className="mt-2.5 text-[0.9375rem] text-slate-400">{copy}</p>
    </div>
  );
}

/**
 * One field, with its icon, label, error and optional trailing control.
 *
 * Shared by both auth pages so the two forms cannot drift apart.
 */
export function AuthField({
  id,
  label,
  icon: Icon,
  error,
  hint,
  inputProps,
  trailing,
}: {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  error?: string;
  hint?: string;
  inputProps: ComponentProps<typeof Input>;
  trailing?: ReactNode;
}) {
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[0.8125rem] font-medium text-slate-300">
        {label}
      </Label>
      <div className="relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        )}
        <Input
          id={id}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={cn(
            'h-12 rounded-xl border-white/10 bg-white/[0.04] text-white placeholder:text-slate-600',
            'focus-visible:border-indigo-400/60 focus-visible:ring-2 focus-visible:ring-indigo-400/40',
            Icon && 'pl-10',
            trailing && 'pr-11',
            error && 'border-rose-500/50',
          )}
          {...inputProps}
        />
        {trailing && <span className="absolute right-3 top-1/2 -translate-y-1/2">{trailing}</span>}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[0.75rem] text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[0.75rem] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
