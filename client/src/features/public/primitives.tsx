import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Reveal } from './motion';

/** The small uppercase label above a section title. */
export function Eyebrow({ children, className, tone = 'dark' }: { children: React.ReactNode; className?: string; tone?: 'dark' | 'light' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
        tone === 'dark'
          ? 'bg-white/[0.06] text-slate-300 ring-1 ring-white/10'
          : 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A section's heading block.
 *
 * Titles are short by design: the sections carry their meaning in the visual
 * beside them, and a paragraph here would be the thing people skip.
 */
export function SectionHeading({
  eyebrow,
  title,
  copy,
  align = 'center',
  tone = 'light',
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  copy?: string;
  align?: 'left' | 'center';
  tone?: 'dark' | 'light';
  className?: string;
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && (
        <Reveal>
          <Eyebrow tone={tone === 'dark' ? 'dark' : 'light'}>{eyebrow}</Eyebrow>
        </Reveal>
      )}
      <Reveal delay={60}>
        <h2
          className={cn(
            'rs-h2 mt-5 text-pretty text-[2rem] font-bold sm:text-[2.6rem] lg:text-[3rem]',
            tone === 'dark' ? 'text-white' : 'text-slate-950',
          )}
        >
          {title}
        </h2>
      </Reveal>
      {copy && (
        <Reveal delay={120}>
          <p className={cn('mt-5 text-pretty text-base leading-7 sm:text-[1.0625rem]', tone === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
            {copy}
          </p>
        </Reveal>
      )}
    </div>
  );
}

/** The site's primary call to action. One shape, used everywhere. */
export function CtaButton({
  to,
  children,
  variant = 'primary',
  className,
  size = 'lg',
}: {
  to: string;
  children: React.ReactNode;
  variant?: 'primary' | 'ghost' | 'light';
  className?: string;
  size?: 'lg' | 'default';
}) {
  const base =
    'group/cta rounded-full font-semibold transition-all duration-300 focus-visible:ring-offset-0';
  const look = {
    primary:
      'bg-gradient-to-r from-indigo-500 to-cyan-400 text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] hover:shadow-[0_18px_50px_-10px_rgba(79,70,229,0.95)] hover:brightness-110',
    light: 'bg-white text-slate-950 shadow-lg hover:bg-slate-100',
    ghost: 'bg-white/[0.06] text-white ring-1 ring-white/15 backdrop-blur hover:bg-white/[0.12]',
  }[variant];

  return (
    <Button asChild size={size} className={cn(base, look, size === 'lg' && 'h-12 px-7 text-[0.95rem]', className)}>
      <Link to={to}>
        {children}
        <ArrowRight className="transition-transform duration-300 group-hover/cta:translate-x-0.5" />
      </Link>
    </Button>
  );
}

/**
 * The page's standard horizontal rhythm.
 *
 * Every section uses it, which is what keeps the site feeling like one product
 * rather than a stack of separately designed blocks.
 */
export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[82rem] px-5 sm:px-8', className)}>{children}</div>;
}

/** A dark section with the ambient aurora behind it. */
export function DarkSection({
  children,
  className,
  grid = false,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  grid?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cn('relative isolate overflow-hidden bg-[#050915]', className)}>
      <div aria-hidden className="rs-aurora opacity-60" />
      {grid && <div aria-hidden className="rs-grid" />}
      <div className="relative">{children}</div>
    </section>
  );
}
