import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The public site's motion system.
 *
 * Deliberately not a library. Everything the marketing pages need is one
 * IntersectionObserver and a handful of keyframes in `index.css`, so there is
 * no animation runtime in the bundle - and the authenticated POS, which ships
 * to tills on slow connections, pays nothing for the website's choreography.
 *
 * Two rules hold throughout:
 *   - motion never gates content. A reveal that never fires still leaves its
 *     children readable, and nothing is hidden behind an animation.
 *   - `prefers-reduced-motion` is honoured in CSS, not here, so it applies to
 *     looping decoration as well as entrances.
 */

/** True when the visitor has asked for less movement. Re-reads if they change it. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/**
 * Fires once when the element first comes near the viewport.
 *
 * Without IntersectionObserver the answer is "yes, it is in view", so the page
 * renders complete rather than blank - the failure mode that matters.
 */
export function useInView<T extends HTMLElement>(options?: IntersectionObserverInit) {
  const ref = React.useRef<T>(null);
  const [inView, setInView] = React.useState(false);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setInView(true);
        observer.disconnect();
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1, ...options },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [options]);

  return { ref, inView };
}

type Direction = 'up' | 'down' | 'left' | 'right' | 'none';

const OFFSET: Record<Direction, { x: string; y: string }> = {
  up: { x: '0', y: '26px' },
  down: { x: '0', y: '-26px' },
  left: { x: '28px', y: '0' },
  right: { x: '-28px', y: '0' },
  none: { x: '0', y: '0' },
};

/** Reveals its children once, on the way in. */
export function Reveal({
  children,
  className,
  delay = 0,
  from = 'up',
  scale,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  from?: Direction;
  /** Start slightly small, for hero art and cards that should feel placed. */
  scale?: number;
  as?: 'div' | 'section' | 'li' | 'span';
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const offset = OFFSET[from];
  return (
    <Tag
      ref={ref as React.Ref<never>}
      className={cn('rs-reveal', inView && 'is-in', className)}
      style={
        {
          '--rs-delay': `${delay}ms`,
          '--rs-from-x': offset.x,
          '--rs-from-y': offset.y,
          ...(scale ? { '--rs-from-scale': String(scale) } : {}),
        } as React.CSSProperties
      }
    >
      {children}
    </Tag>
  );
}

/**
 * Reveals a list, one item after the next.
 *
 * Children are wrapped rather than cloned, so any element works and nothing
 * depends on a child forwarding a ref.
 */
export function Stagger({
  children,
  className,
  step = 80,
  start = 0,
  from = 'up',
  itemClassName,
}: {
  children: React.ReactNode;
  className?: string;
  step?: number;
  start?: number;
  from?: Direction;
  itemClassName?: string;
}) {
  return (
    <div className={className}>
      {React.Children.toArray(children).map((child, index) => (
        <Reveal key={index} delay={start + index * step} from={from} className={itemClassName}>
          {child}
        </Reveal>
      ))}
    </div>
  );
}

/**
 * Counts up to a number when it scrolls into view.
 *
 * Driven by requestAnimationFrame against wall-clock time, so a slow frame
 * shortens the animation rather than stretching it, and the final value is
 * always exact. With reduced motion it simply starts at the answer.
 */
export function Counter({
  to,
  duration = 1600,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
}: {
  to: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const { ref, inView } = useInView<HTMLSpanElement>();
  const [value, setValue] = React.useState(0);

  React.useEffect(() => {
    if (!inView) return;
    if (reduced) {
      setValue(to);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      // Ease-out cubic: fast first, settles gently on the real figure.
      setValue(to * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
      else setValue(to);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, reduced, to, duration]);

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {prefix}
      {value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/**
 * Follows the pointer with a soft highlight.
 *
 * Only a CSS custom property changes, so the browser repaints a gradient
 * rather than re-rendering React on every mouse move.
 */
export function Spotlight({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const track = (event: React.MouseEvent<HTMLDivElement>) => {
    if (reduced) return;
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    node.style.setProperty('--rs-x', `${event.clientX - box.left}px`);
    node.style.setProperty('--rs-y', `${event.clientY - box.top}px`);
  };

  return (
    <div ref={ref} onMouseMove={track} className={cn('relative overflow-hidden', className)}>
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px opacity-0 transition-opacity duration-500 [background:radial-gradient(22rem_22rem_at_var(--rs-x,50%)_var(--rs-y,0%),rgba(129,140,248,0.16),transparent_70%)] group-hover:opacity-100"
      />
      {children}
    </div>
  );
}
