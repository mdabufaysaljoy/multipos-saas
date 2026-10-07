import * as React from 'react';
import { BadgeCheck, Banknote, Receipt, ScanLine, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The hero's animated till.
 *
 * It runs one loop of a real checkout - scan, basket fills, total settles,
 * tender splits, receipt prints - because that is the product. A stock Lottie
 * of an abstract shopping cart would say less and weigh more; this is ~4kB of
 * markup animated by keyframes already in the stylesheet, so there is no
 * animation runtime, no remote asset and no licence to audit.
 *
 * The same component backs the POS ecosystem switcher, which is why the
 * contents are data rather than markup: one till, four menus.
 */

export type TerminalVertical = 'clothing' | 'restaurant' | 'supershop' | 'pharmacy';

interface TillLine {
  name: string;
  detail: string;
  qty: number;
  price: number;
}

interface TillScene {
  label: string;
  accent: string;
  glow: string;
  lines: TillLine[];
  tenders: { icon: typeof Banknote; label: string; amount: number }[];
}

const money = (minor: number) =>
  `৳ ${minor.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export const TERMINAL_SCENES: Record<TerminalVertical, TillScene> = {
  clothing: {
    label: 'Clothing POS',
    accent: 'from-violet-500 to-fuchsia-500',
    glow: 'rgba(168,85,247,0.35)',
    lines: [
      { name: 'Oxford shirt', detail: 'Navy · M', qty: 2, price: 1850 },
      { name: 'Classic chinos', detail: 'Sand · 32', qty: 1, price: 2250 },
      { name: 'Canvas tote', detail: 'Natural', qty: 1, price: 720 },
    ],
    tenders: [
      { icon: Banknote, label: 'Cash', amount: 4000 },
      { icon: Smartphone, label: 'bKash', amount: 2670 },
    ],
  },
  restaurant: {
    label: 'Restaurant POS',
    accent: 'from-orange-500 to-rose-500',
    glow: 'rgba(244,63,94,0.32)',
    lines: [
      { name: 'Mexican Hot Pizza', detail: '12 inch · Extra cheese', qty: 1, price: 930 },
      { name: 'Kacchi Biryani', detail: 'Half', qty: 2, price: 400 },
      { name: 'Borhani', detail: '', qty: 2, price: 80 },
    ],
    tenders: [
      { icon: Banknote, label: 'Cash', amount: 1500 },
      { icon: Smartphone, label: 'Nagad', amount: 390 },
    ],
  },
  supershop: {
    label: 'Super Shop POS',
    accent: 'from-emerald-500 to-teal-500',
    glow: 'rgba(16,185,129,0.32)',
    lines: [
      { name: 'Basmati rice', detail: '5 kg', qty: 1, price: 780 },
      { name: 'Fresh milk', detail: '1 L', qty: 3, price: 120 },
      { name: 'Orange juice', detail: '1 L', qty: 2, price: 240 },
    ],
    tenders: [
      { icon: Banknote, label: 'Cash', amount: 1200 },
      { icon: Smartphone, label: 'bKash', amount: 420 },
    ],
  },
  pharmacy: {
    label: 'Pharmacy POS',
    accent: 'from-cyan-500 to-blue-500',
    glow: 'rgba(14,165,233,0.32)',
    lines: [
      { name: 'Napa', detail: '500 mg · Batch A4', qty: 2, price: 12 },
      { name: 'Seclo', detail: '20 mg · Batch B1', qty: 1, price: 70 },
      { name: 'Vitamin C', detail: '250 mg', qty: 1, price: 95 },
    ],
    tenders: [
      { icon: Banknote, label: 'Cash', amount: 200 },
      { icon: Smartphone, label: 'Card', amount: 0 },
    ],
  },
};

export function PosTerminal({
  vertical = 'clothing',
  className,
}: {
  vertical?: TerminalVertical;
  className?: string;
}) {
  const scene = TERMINAL_SCENES[vertical];
  const subtotal = scene.lines.reduce((sum, line) => sum + line.price * line.qty, 0);
  const paid = scene.tenders.reduce((sum, tender) => sum + tender.amount, 0);
  const change = Math.max(0, paid - subtotal);

  return (
    <div className={cn('relative', className)}>
      {/* The glow sits behind the glass so the till reads as lit, not flat. */}
      <div
        aria-hidden
        className="absolute -inset-10 rounded-[3rem] opacity-70 blur-3xl transition-colors duration-700"
        style={{ background: `radial-gradient(60% 60% at 50% 40%, ${scene.glow}, transparent 70%)` }}
      />

      <div className="rs-ring rs-glass relative overflow-hidden rounded-[1.75rem] shadow-[0_50px_120px_-40px_rgba(2,6,23,0.9)]">
        {/* chrome */}
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-3 text-[11px] font-medium tracking-wide text-slate-400">{scene.label}</span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/20">
            <span className="rs-pulse-soft h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>

        <div className="grid gap-px bg-white/5 sm:grid-cols-[1.25fr_1fr]">
          {/* ---------------------------------------------------- basket */}
          <div className="relative bg-slate-950/60 p-5">
            {/* the scan sweep */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-full overflow-hidden">
              <div className="rs-scanline h-16 w-full bg-gradient-to-b from-transparent via-cyan-400/15 to-transparent" />
            </div>

            <div className="relative mb-4 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
              <ScanLine className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden />
              <span className="text-xs text-slate-400">Scan or search…</span>
              <span className="ml-auto font-mono text-[10px] text-slate-500">F2</span>
            </div>

            <ul className="relative space-y-2.5">
              {scene.lines.map((line, index) => (
                <li
                  key={line.name}
                  className="rs-line-in flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5"
                  style={{ '--rs-delay': `${index * 260}ms` } as React.CSSProperties}
                >
                  <span className={cn('h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br', scene.accent)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-slate-100">{line.name}</span>
                    {line.detail && <span className="block truncate text-[11px] text-slate-500">{line.detail}</span>}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-[11px] text-slate-500">× {line.qty}</span>
                    <span className="block font-mono text-[13px] font-semibold text-slate-100">
                      {money(line.price * line.qty)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* ---------------------------------------------------- tender */}
          <div className="flex flex-col bg-slate-950/80 p-5">
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between text-slate-400">
                <dt>Subtotal</dt>
                <dd className="font-mono">{money(subtotal)}</dd>
              </div>
              <div className="flex items-baseline justify-between border-t border-white/10 pt-2.5">
                <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">To pay</dt>
                <dd className="font-mono text-2xl font-bold text-white">{money(subtotal)}</dd>
              </div>
            </dl>

            <div className="mt-4 space-y-2">
              {scene.tenders
                .filter((tender) => tender.amount > 0)
                .map((tender, index) => (
                  <div
                    key={tender.label}
                    className="rs-line-in flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2"
                    style={{ '--rs-delay': `${900 + index * 220}ms` } as React.CSSProperties}
                  >
                    <tender.icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                    <span className="text-[12px] text-slate-300">{tender.label}</span>
                    <span className="ml-auto font-mono text-[12px] text-slate-100">{money(tender.amount)}</span>
                  </div>
                ))}
            </div>

            {change > 0 && (
              <p className="mt-3 flex justify-between text-[12px] text-emerald-300">
                <span>Change</span>
                <span className="font-mono">{money(change)}</span>
              </p>
            )}

            {/* the printed receipt */}
            <div className="rs-receipt mt-4 overflow-hidden rounded-lg bg-white/90 px-3 py-2.5 shadow-lg">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-900">
                <Receipt className="h-3 w-3" aria-hidden />
                Receipt
              </p>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-slate-600">
                {scene.lines.length} items · {money(subtotal)}
                <br />
                Paid in full · Thank you
              </p>
            </div>

            <p className="mt-auto flex items-center gap-1.5 pt-4 text-[11px] font-medium text-emerald-300">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
              Sale recorded
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
