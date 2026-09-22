import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { billingApi } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { availableOn, formatLimit } from '@/lib/planCatalog';
import { PlanComparisonTable } from '@/features/billing/PlanComparisonTable';
import { cn } from '@/lib/utils';
import { SAAS_PRODUCTS, SHARED_FEATURES, productBySlug } from './products.data';

const HEADLINE_LIMITS: { key: string; label: string; format?: 'bytes' }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff' },
  { key: 'maxProducts', label: 'Products' },
  { key: 'maxMonthlySales', label: 'Sales / month' },
  { key: 'maxCustomers', label: 'Customers' },
  { key: 'maxStorageBytes', label: 'Storage', format: 'bytes' },
];

const tierName = (name: string) => name.replace(/ Annual$/, '');

/**
 * One POS system in detail: what it does, and what each subscription plan
 * includes FOR THIS POS TYPE. Plans, prices, limits and feature ticks are read
 * from the API resolved for this vertical, so the page matches what the
 * backend enforces.
 */
export function PosProductPage() {
  const { slug } = useParams();
  const product = productBySlug(slug);
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');

  const { data: plans, isLoading, isError } = useQuery({
    queryKey: ['public', 'plans', product?.vertical],
    queryFn: () => billingApi.plansFor(product!.vertical),
    enabled: Boolean(product),
  });

  if (!product) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 lg:px-6">
        <EmptyState title="We couldn't find that POS" description="It may have moved. See all our POS systems." />
        <div className="mt-6 text-center">
          <Button asChild variant="outline">
            <Link to="/products">
              <ArrowLeft />
              All POS systems
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const visible = (plans ?? []).filter((plan) => plan.interval === interval).sort((a, b) => a.sortOrder - b.sortOrder);
  const monthlyByTier = new Map((plans ?? []).filter((plan) => plan.interval === 'monthly').map((plan) => [plan.tier, plan]));
  const others = SAAS_PRODUCTS.filter((other) => other.slug !== product.slug);
  const registerLink = `/register?pos=${product.vertical}`;

  return (
    <div>
      {/* ---------------------------------------------------------- hero */}
      <section className="border-b bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-6xl px-4 py-12 lg:px-6 lg:py-16">
          <Link to="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            All POS systems
          </Link>
          <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-center">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <product.icon className="h-8 w-8" />
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{product.name}</h1>
                <Badge variant="success">Available now</Badge>
              </div>
              <p className="text-muted-foreground">{product.tagline}</p>
              <p className="max-w-3xl">{product.description}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row md:flex-col">
              <Button size="lg" asChild>
                <Link to={registerLink}>
                  Start free trial
                  <ArrowRight />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#plans">See plans</a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ features */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-6">
        <h2 className="text-2xl font-bold tracking-tight">What {product.name} does</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {product.features.map((group) => (
            <FeatureGroupCard key={group.title} title={group.title} items={group.items} />
          ))}
        </div>

        <h3 className="mt-10 text-lg font-semibold">Included with every POS</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SHARED_FEATURES.map((group) => (
            <FeatureGroupCard key={group.title} title={group.title} items={group.items} muted />
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- plans */}
      <section id="plans" className="scroll-mt-20 border-t bg-muted/20">
        <div className="mx-auto max-w-6xl px-4 py-12 lg:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{product.name} plans</h2>
            <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">What each subscription includes for a {product.name} workspace.</p>
          </div>

          <div className="mt-6 flex justify-center">
            <div className="inline-flex rounded-lg border bg-background p-1">
              {(['monthly', 'yearly'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setInterval(value)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                    interval === value ? 'bg-muted shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {value === 'monthly' ? 'Monthly' : 'Yearly'}
                  {value === 'yearly' && <Badge variant="success">2 months free</Badge>}
                </button>
              ))}
            </div>
          </div>

          {isLoading && <LoadingState label="Loading plans…" />}
          {!isLoading && (isError || visible.length === 0) && <EmptyState title="Plans are not available right now" />}

          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {visible.map((plan, index) => {
              const featured = index === 1;
              const monthlyTwin = monthlyByTier.get(plan.tier);
              const offersTrial = (monthlyTwin?.trialDays ?? plan.trialDays) > 0;
              return (
                <Card key={plan._id} className={cn('flex flex-col', featured && 'border-primary shadow-md ring-1 ring-primary')}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle>{tierName(plan.name)}</CardTitle>
                      {offersTrial ? <Badge variant="success">Free trial</Badge> : featured ? <Badge>Most popular</Badge> : null}
                    </div>
                    <CardDescription>{plan.description.replace(/ Billed yearly - two months free\.$/, '')}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-4">
                    <p className="tabular text-3xl font-bold">
                      {formatPlanPrice(plan.priceMinor, plan.currency)}
                      <span className="text-base font-normal text-muted-foreground"> / {plan.interval === 'yearly' ? 'year' : 'month'}</span>
                    </p>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-4 text-sm">
                      {HEADLINE_LIMITS.map((limit) => (
                        <div key={limit.key}>
                          <dt className="text-xs text-muted-foreground">{limit.label}</dt>
                          <dd className="tabular font-semibold">{formatLimit(plan.limits[limit.key], limit.format)}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex items-start gap-2 border-t pt-3 text-sm">
                      {plan.features.advancedReports ? (
                        <>
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                          <span className="font-medium">Advanced Analytics</span>
                        </>
                      ) : (
                        <>
                          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <span>
                            <span className="font-medium">Advanced Analytics</span>
                            <span className="block text-xs text-muted-foreground">Available on {availableOn(visible, 'advancedReports')}</span>
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex-1" />
                    <Button className="w-full" variant={featured ? 'default' : 'outline'} asChild>
                      <Link to={registerLink}>
                        {offersTrial ? 'Start free trial' : `Choose ${tierName(plan.name)}`}
                        <ArrowRight />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {visible.length > 0 && (
            <div className="mt-12">
              <h3 className="text-center text-xl font-bold tracking-tight">Compare {product.name} plans</h3>
              <p className="mt-1 text-center text-sm text-muted-foreground">Everything each plan includes, and everything it does not.</p>
              <div className="mt-6">
                <PlanComparisonTable plans={visible} />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------- other POS */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-6">
        <h2 className="text-xl font-semibold">Other POS systems</h2>
        <p className="mt-1 text-sm text-muted-foreground">One account and one wallet can run several.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {others.map((other) => (
            <Link key={other.slug} to={`/products/${other.slug}`} className="rounded-lg border p-4 transition-colors hover:bg-accent">
              <other.icon className="h-5 w-5 text-primary" />
              <p className="mt-2 font-medium">{other.name}</p>
              <p className="text-xs text-muted-foreground">{other.tagline}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function FeatureGroupCard({ title, items, muted }: { title: string; items: string[]; muted?: boolean }) {
  return (
    <Card className={cn(muted && 'bg-muted/30')}>
      <CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">{title}</h3>
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              {item}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
