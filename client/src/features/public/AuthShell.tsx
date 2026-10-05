import type { ReactNode } from 'react';
import { BarChart3, CheckCircle2, Layers3, ShieldCheck } from 'lucide-react';
import { BrandMark } from './BrandMark';

export function AuthShell({
  children,
  title = 'One calm place to run your business.',
  copy = 'Sell, manage stock, understand performance and keep every branch connected.',
}: {
  children: ReactNode;
  title?: string;
  copy?: string;
}) {
  return (
    <div className="grid min-h-full bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(30rem,.95fr)]">
      <aside className="relative hidden overflow-hidden bg-slate-950 p-10 text-white lg:flex lg:flex-col xl:p-14">
        <div className="absolute -left-20 top-1/3 h-72 w-72 rounded-full bg-violet-600/25 blur-3xl" />
        <div className="absolute -right-24 top-0 h-80 w-80 rounded-full bg-cyan-500/20 blur-3xl" />
        <BrandMark className="relative z-10 text-white" />
        <div className="relative z-10 my-auto max-w-xl py-12">
          <p className="text-xs font-bold uppercase tracking-[.24em] text-cyan-300">Built for everyday business</p>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-[-.045em] xl:text-5xl">{title}</h1>
          <p className="mt-5 max-w-lg text-lg leading-8 text-slate-300">{copy}</p>
          <div className="mt-10 grid grid-cols-3 gap-3">
            {[
              ['Fast checkout', Layers3],
              ['Clear insights', BarChart3],
              ['Secure access', ShieldCheck],
            ].map(([label, Icon]) => {
              const FeatureIcon = Icon as typeof Layers3;
              return (
                <div key={label as string} className="rounded-2xl border border-white/10 bg-white/[.06] p-4">
                  <FeatureIcon className="h-5 w-5 text-cyan-300" />
                  <p className="mt-3 text-xs font-semibold">{label as string}</p>
                </div>
              );
            })}
          </div>
        </div>
        <p className="relative z-10 flex items-center gap-2 text-xs text-slate-400">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" /> No card required to get started
        </p>
      </aside>
      <main className="relative flex min-w-0 items-center justify-center overflow-y-auto bg-[radial-gradient(circle_at_top_right,rgba(79,70,229,.08),transparent_38%)] px-4 py-8 sm:px-8 lg:px-12">
        <div className="absolute left-5 top-5 lg:hidden">
          <BrandMark />
        </div>
        <div className="w-full max-w-lg pt-14 lg:pt-0">{children}</div>
      </main>
    </div>
  );
}
