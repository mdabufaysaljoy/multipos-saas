import { useQuery } from '@tanstack/react-query';
import {
  Check,
  Monitor,
  Package,
  Printer,
  ReceiptText,
  ScanBarcode,
  Tags,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { publicHardwareApi, type HardwareCategory, type HardwareItem, type HardwarePackage } from '@/api/hardware';
import { formatPlanPrice } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, SectionHeading } from '@/features/public/primitives';

/**
 * The devices that sit on the counter beside the software.
 *
 * Every package, device, price and spec is read live from the platform
 * catalogue, so what the page offers is exactly what a platform admin has
 * published — the page itself knows no prices. Ordering is a conversation
 * rather than a checkout: hardware is delivered and installed, so each card
 * leads to contact rather than to a cart.
 */

const CATEGORY_ICONS: Record<HardwareCategory, LucideIcon> = {
  computer: Monitor,
  scanner: ScanBarcode,
  cash_drawer: Wallet,
  receipt_printer: ReceiptText,
  label_printer: Tags,
  printer_combo: Printer,
  accessory: Package,
};

const CATEGORY_LABELS: Record<HardwareCategory, string> = {
  computer: 'Computer',
  scanner: 'Scanner',
  cash_drawer: 'Cash drawer',
  receipt_printer: 'Receipt printer',
  label_printer: 'Label printer',
  printer_combo: 'Receipt + label printer',
  accessory: 'Accessory',
};

/** Shown on every price: the packages quote devices, and nothing else. */
const SCOPE_NOTE = 'Hardware only. Software subscription, delivery and installation are quoted separately.';

export function HardwarePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['public', 'hardware'],
    queryFn: publicHardwareApi.catalogue,
    staleTime: 5 * 60 * 1000,
  });

  const currency = data?.currency ?? 'BDT';
  const packages = data?.packages ?? [];
  const items = data?.items ?? [];

  return (
    <>
      <DarkSection grid className="py-20 sm:py-28">
        <Container>
          <SectionHeading
            tone="dark"
            eyebrow="POS hardware"
            title={<>The counter, not just the software.</>}
            copy="Scanners, cash drawers, receipt printers and label printers — as a complete counter package, or one device at a time. Everything here is tested with Retailer Suites before it ships."
          />
        </Container>
      </DarkSection>

      <section className="bg-white py-20 sm:py-24">
        <Container>
          <SectionHeading
            align="left"
            eyebrow="Packages"
            title={<>Complete counter setups</>}
            copy="Pick the setup that matches your counter. Each package is priced as a whole, and lists exactly which devices are in it."
            className="max-w-3xl"
          />

          <div className="mt-12">
            {isLoading && <CardGridSkeleton count={3} />}
            {isError && <CatalogueUnavailable />}
            {!isLoading && !isError && packages.length === 0 && (
              <p className="text-[0.9375rem] text-slate-600">No packages are on offer right now. Talk to us about what your counter needs.</p>
            )}
            {packages.length > 0 && (
              <Stagger className="grid gap-6 md:grid-cols-2 xl:grid-cols-3" itemClassName="h-full">
                {packages.map((pkg) => (
                  <PackageCard key={pkg.slug} pkg={pkg} currency={currency} />
                ))}
              </Stagger>
            )}
          </div>
        </Container>
      </section>

      <section className="border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
        <Container>
          <SectionHeading
            align="left"
            eyebrow="Single devices"
            title={<>Buy one device at a time</>}
            copy="Replacing a printer, or adding a second scanner? Every device in the packages is sold on its own at the same price."
            className="max-w-3xl"
          />

          <div className="mt-12">
            {isLoading && <CardGridSkeleton count={6} />}
            {isError && <CatalogueUnavailable />}
            {!isLoading && !isError && items.length === 0 && (
              <p className="text-[0.9375rem] text-slate-600">No devices are listed right now.</p>
            )}
            {items.length > 0 && (
              <Stagger className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" itemClassName="h-full" step={60}>
                {items.map((item) => (
                  <ItemCard key={item.slug} item={item} currency={currency} />
                ))}
              </Stagger>
            )}
          </div>

          <Reveal delay={120}>
            <p className="mt-10 text-[0.8125rem] text-slate-500">{SCOPE_NOTE}</p>
          </Reveal>
        </Container>
      </section>

      <DarkSection className="py-20 sm:py-24">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <Reveal>
              <h2 className="rs-h2 text-[2rem] font-bold text-white sm:text-[2.5rem]">Not sure what your counter needs?</h2>
            </Reveal>
            <Reveal delay={80}>
              <p className="mt-5 text-[1.0625rem] leading-8 text-slate-400">
                Tell us the shop and how busy the counter gets. We will put a setup together and quote delivery and installation with it.
              </p>
            </Reveal>
            <Reveal delay={150}>
              <div className="mt-9 flex flex-wrap justify-center gap-3">
                <CtaButton to="/contact">Order now</CtaButton>
                <CtaButton to="/pricing" variant="ghost">
                  See software pricing
                </CtaButton>
              </div>
            </Reveal>
          </div>
        </Container>
      </DarkSection>
    </>
  );
}

function PackageCard({ pkg, currency }: { pkg: HardwarePackage; currency: string }) {
  return (
    <article
      className={cn(
        'flex h-full flex-col rounded-2xl border bg-white p-6 shadow-sm transition-shadow duration-300 hover:shadow-lg',
        pkg.featured ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200',
      )}
    >
      <Art url={pkg.imageUrl} alt={pkg.name} className="aspect-[4/3]" fallback={Package} />

      <div className="mt-5 flex items-start justify-between gap-3">
        <h3 className="text-[1.125rem] font-bold text-slate-950">{pkg.name}</h3>
        {pkg.featured && (
          <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-indigo-700">
            Popular
          </span>
        )}
      </div>
      {pkg.tagline && <p className="mt-1 text-[0.875rem] font-medium text-indigo-600">{pkg.tagline}</p>}
      {pkg.description && <p className="mt-3 text-[0.875rem] leading-6 text-slate-600">{pkg.description}</p>}

      <ul className="mt-5 space-y-2 border-t border-slate-100 pt-5">
        {pkg.lines.map((line) => {
          const Icon = CATEGORY_ICONS[line.item.category] ?? Package;
          return (
            <li key={line.itemSlug} className="flex items-start gap-2.5 text-[0.875rem] text-slate-700">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span className="flex-1">
                {line.item.name}
                {line.quantity > 1 && <span className="text-slate-500"> × {line.quantity}</span>}
                {line.item.summary && <span className="block text-[0.8125rem] text-slate-500">{line.item.summary}</span>}
              </span>
              <span className="tabular shrink-0 text-[0.8125rem] text-slate-500">
                {formatPlanPrice(line.item.priceMinor * line.quantity, currency)}
              </span>
            </li>
          );
        })}
      </ul>

      {pkg.bestFor.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {pkg.bestFor.map((trade) => (
            <span key={trade} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
              {trade}
            </span>
          ))}
        </div>
      )}

      {pkg.highlights.length > 0 && (
        <ul className="mt-5 space-y-1.5">
          {pkg.highlights.map((highlight) => (
            <li key={highlight} className="flex items-center gap-2 text-[0.8125rem] text-slate-600">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
              {highlight}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-6">
        <p className="tabular text-[2rem] font-bold leading-none text-slate-950">{formatPlanPrice(pkg.priceMinor, currency)}</p>
        {pkg.savingsMinor > 0 ? (
          <p className="mt-1.5 text-[0.8125rem] text-emerald-600">
            Save {formatPlanPrice(pkg.savingsMinor, currency)} against{' '}
            <span className="line-through">{formatPlanPrice(pkg.componentsTotalMinor, currency)}</span> bought separately
          </p>
        ) : (
          <p className="mt-1.5 text-[0.8125rem] text-slate-500">Hardware only</p>
        )}
        <CtaButton to="/contact" size="default" className="mt-4 w-full justify-center">
          Order now
        </CtaButton>
      </div>
    </article>
  );
}

function ItemCard({ item, currency }: { item: HardwareItem; currency: string }) {
  const Icon = CATEGORY_ICONS[item.category] ?? Package;
  return (
    <article className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow duration-300 hover:shadow-lg">
      <Art url={item.imageUrl} alt={item.name} className="aspect-[4/3]" fallback={Icon} />

      <span className="mt-5 inline-flex w-fit items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {CATEGORY_LABELS[item.category] ?? 'Device'}
      </span>
      <h3 className="mt-3 text-[1.0625rem] font-bold text-slate-950">{item.name}</h3>
      {item.summary && <p className="mt-1 text-[0.875rem] text-slate-600">{item.summary}</p>}

      {item.specs.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {item.specs.map((spec) => (
            <li key={spec} className="flex items-start gap-2 text-[0.8125rem] leading-5 text-slate-600">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
              {spec}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-end justify-between gap-3 pt-6">
        <p className="tabular text-[1.5rem] font-bold leading-none text-slate-950">{formatPlanPrice(item.priceMinor, currency)}</p>
        <CtaButton to="/contact" size="default">
          Order now
        </CtaButton>
      </div>
    </article>
  );
}

/**
 * A catalogue photo, or a drawn placeholder.
 *
 * An admin can publish a device before its photo exists, so a missing image is
 * a normal state rather than a broken one and never leaves a torn card behind.
 */
function Art({ url, alt, className, fallback: Fallback }: { url: string; alt: string; className?: string; fallback: LucideIcon }) {
  if (!url) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl bg-slate-100', className)}>
        <Fallback className="h-10 w-10 text-slate-300" aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn('overflow-hidden rounded-xl bg-slate-100', className)}>
      <img src={url} alt={alt} loading="lazy" className="h-full w-full object-contain" />
    </div>
  );
}

function CardGridSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-2xl border border-slate-200 bg-white p-6">
          <Skeleton className="aspect-[4/3] w-full rounded-xl" />
          <Skeleton className="mt-5 h-5 w-2/3" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-5/6" />
          <Skeleton className="mt-6 h-8 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** The catalogue is the page; without it there is nothing honest to show. */
function CatalogueUnavailable() {
  return (
    <p className="text-[0.9375rem] text-slate-600">
      The hardware catalogue could not be loaded just now. Please{' '}
      <a className="font-semibold text-indigo-600 underline-offset-4 hover:underline" href="/contact">
        contact us
      </a>{' '}
      and we will quote your setup directly.
    </p>
  );
}
