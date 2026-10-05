import { BarChart3, Check, CreditCard, Package, Search, ShoppingCart, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

type PreviewKind = 'clothing' | 'restaurant' | 'supershop' | 'pharmacy';

const PREVIEW = {
  clothing: {
    accent: 'from-violet-500 to-fuchsia-500',
    label: 'Clothing POS',
    products: ['Oxford shirt · Navy / M', 'Classic chinos · Sand / 32', 'Canvas tote · Natural'],
    prices: ['৳ 1,850', '৳ 2,250', '৳ 720'],
  },
  restaurant: {
    accent: 'from-orange-500 to-rose-500',
    label: 'Restaurant POS',
    products: ['Grilled chicken bowl', 'House lemonade', 'Chocolate tart'],
    prices: ['৳ 520', '৳ 180', '৳ 260'],
  },
  supershop: {
    accent: 'from-emerald-500 to-teal-500',
    label: 'Super Shop POS',
    products: ['Fresh milk · 1 L', 'Basmati rice · 5 kg', 'Orange juice · 1 L'],
    prices: ['৳ 120', '৳ 780', '৳ 240'],
  },
  pharmacy: {
    accent: 'from-cyan-500 to-blue-500',
    label: 'Pharmacy POS',
    products: ['Napa · 500 mg', 'Seclo · 20 mg', 'Vitamin C · 250 mg'],
    prices: ['৳ 12', '৳ 70', '৳ 95'],
  },
} as const;

export function ProductPreview({
  kind = 'supershop',
  className,
  compact = false,
}: {
  kind?: PreviewKind;
  className?: string;
  compact?: boolean;
}) {
  const content = PREVIEW[kind];
  return (
    <div
      className={cn(
        'public-preview relative overflow-hidden rounded-[1.6rem] border border-white/70 bg-white/92 shadow-[0_30px_80px_-30px_rgba(15,23,42,.32)] backdrop-blur',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-slate-200/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full bg-gradient-to-br', content.accent)} />
          <span className="text-xs font-semibold text-slate-700">{content.label}</span>
        </div>
        <div className="flex gap-1.5" aria-hidden="true">
          <i className="h-2 w-2 rounded-full bg-slate-200" />
          <i className="h-2 w-2 rounded-full bg-slate-200" />
          <i className="h-2 w-2 rounded-full bg-slate-200" />
        </div>
      </div>
      <div className={cn('grid', compact ? 'grid-cols-[1fr_42%]' : 'grid-cols-[1fr_40%]')}>
        <div className="border-r border-slate-200/80 p-3 sm:p-4">
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-400">
            <Search className="h-3.5 w-3.5" /> Search or scan a product
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {content.products.map((product, index) => (
              <div
                key={product}
                className="group rounded-xl bg-slate-50 p-2.5 transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md"
              >
                <div className={cn('mb-2 aspect-[1.45] rounded-lg bg-gradient-to-br opacity-80', content.accent)}>
                  <div className="flex h-full items-center justify-center">
                    <Package className="h-5 w-5 text-white/90" />
                  </div>
                </div>
                <p className="truncate text-[9px] font-semibold text-slate-700 sm:text-[10px]">{product}</p>
                <p className="mt-0.5 text-[9px] font-bold text-slate-950">{content.prices[index]}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-800">
              <ShoppingCart className="h-3.5 w-3.5" /> Cart
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[8px] text-slate-500">3 items</span>
          </div>
          <div className="my-3 space-y-2">
            {content.products.slice(0, 2).map((product, index) => (
              <div
                key={product}
                className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2 text-[8px] sm:text-[9px]"
              >
                <span className="truncate text-slate-600">{product}</span>
                <span className="font-semibold text-slate-900">{content.prices[index]}</span>
              </div>
            ))}
          </div>
          <div className="mt-auto space-y-2">
            <div className="flex justify-between text-[10px] font-bold text-slate-900">
              <span>Total</span>
              <span>৳ 2,750</span>
            </div>
            <div
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r py-2 text-[9px] font-semibold text-white shadow-lg',
                content.accent,
              )}
            >
              <CreditCard className="h-3 w-3" /> Complete sale
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPreview({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[1.75rem] border border-white/70 bg-slate-950 p-4 text-white shadow-[0_35px_90px_-35px_rgba(15,23,42,.8)] sm:p-6',
        className,
      )}
    >
      <div className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-blue-500/25 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-cyan-300">Live overview</p>
          <h3 className="mt-1 text-lg font-semibold">Today at a glance</h3>
        </div>
        <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[10px]">Updated now</span>
      </div>
      <div className="relative mt-5 grid grid-cols-3 gap-2">
        {[
          ['Net sales', '৳ 84,250'],
          ['Orders', '126'],
          ['Gross profit', '৳ 27,480'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/10 bg-white/[.07] p-3">
            <p className="text-[9px] text-slate-400">{label}</p>
            <p className="mt-1 text-xs font-bold sm:text-base">{value}</p>
          </div>
        ))}
      </div>
      <div className="relative mt-3 grid grid-cols-[1.45fr_.75fr] gap-3">
        <div className="rounded-xl border border-white/10 bg-white/[.06] p-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold">Sales trend</p>
            <BarChart3 className="h-3.5 w-3.5 text-cyan-300" />
          </div>
          <div className="mt-5 flex h-24 items-end gap-1.5">
            {[38, 55, 44, 72, 62, 88, 80, 96, 74, 100].map((height, index) => (
              <i
                key={index}
                className="flex-1 rounded-t bg-gradient-to-t from-blue-600 to-cyan-300"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[.06] p-3">
          <p className="text-[10px] font-semibold">Health</p>
          <div className="mt-4 space-y-3">
            {['Stock synced', 'Payments matched', 'Reports ready'].map((item) => (
              <p key={item} className="flex items-center gap-1.5 text-[9px] text-slate-300">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
                  <Check className="h-2.5 w-2.5" />
                </span>
                {item}
              </p>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-1 text-[9px] font-semibold text-violet-300">
            <Sparkles className="h-3 w-3" /> Clear next steps
          </div>
        </div>
      </div>
    </div>
  );
}
