import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  Receipt,
  ScanBarcode,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTrialOffer } from '@/hooks/useTrialDays';
import { SAAS_PRODUCTS } from './products.data';

export function HomePage() {
  const { days: trialDays, planName: trialPlanName } = useTrialOffer();

  return (
    <>
      {/* ---------------------------------------------------------- hero */}
      <section className="border-b bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-6xl px-4 py-20 text-center lg:px-6 lg:py-28">
          <Badge variant="secondary" className="mb-4">
            Now serving retailers across Bangladesh
          </Badge>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Point-of-sale software that fits the shop you actually run
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            One platform, four purpose-built systems — Clothing, Supershop, Restaurant and Pharmacy POS — sharing one
            account and one wallet.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button size="lg" asChild>
              <Link to="/register">
                {trialDays ? `Start your ${trialDays}-day trial` : 'Start your free trial'}
                <ArrowRight />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/pricing">See pricing</Link>
            </Button>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">No card required. Set up your first shop in minutes.</p>
        </div>
      </section>

      {/* ------------------------------------------------------ products */}
      <section className="mx-auto max-w-6xl px-4 py-16 lg:px-6">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Our products</h2>
          <p className="mt-2 text-muted-foreground">A dedicated system per trade, sharing one account and one wallet.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SAAS_PRODUCTS.map((product) => (
            <Card key={product.slug} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-start justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <product.icon className="h-5 w-5" />
                  </span>
                  <Badge variant="success">Available now</Badge>
                </div>

                <div>
                  <h3 className="font-semibold">{product.name}</h3>
                  <p className="text-xs text-muted-foreground">{product.tagline}</p>
                </div>

                <p className="flex-1 text-sm text-muted-foreground">{product.description}</p>

                <Button variant="outline" size="sm" className="mt-auto w-full" asChild>
                  <Link to={`/products/${product.slug}`}>
                    Learn more
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ features */}
      <section className="border-y bg-muted/30">
        <div className="mx-auto max-w-6xl px-4 py-16 lg:px-6">
          <div className="mb-10 text-center">
            <h2 className="text-3xl font-bold tracking-tight">Everything at the till, and behind it</h2>
            <p className="mt-2 text-muted-foreground">
              Clothing POS in detail — the parts shopkeepers tell us actually matter.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={<Boxes className="h-5 w-5" />} title="Variants done properly">
              Every colour and size is its own sellable unit with its own SKU, price and stock — not a note in a
              description field.
            </Feature>
            <Feature icon={<ScanBarcode className="h-5 w-5" />} title="Scan and go">
              Works with any USB or Bluetooth scanner. Generate and print your own barcode labels for unlabelled stock.
            </Feature>
            <Feature icon={<Receipt className="h-5 w-5" />} title="Split payments">
              Cash, bKash, Nagad, bank and card on one sale. The breakdown is stored and printed on the receipt.
            </Feature>
            <Feature icon={<BarChart3 className="h-5 w-5" />} title="Real profit, not guesswork">
              Cost is captured at the moment of sale, so last month's profit never changes when you re-price today.
            </Feature>
            <Feature icon={<Store className="h-5 w-5" />} title="Multiple branches">
              Separate stock, staff and sales per branch, with one aggregated view for the owner.
            </Feature>
            <Feature icon={<ShieldCheck className="h-5 w-5" />} title="Staff you can trust">
              Granular permissions — a cashier changes a price only if you allow it, enforced on the server.
            </Feature>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- cta */}
      <section className="mx-auto max-w-4xl px-4 py-20 text-center lg:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Ready to ring up your first sale?</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Create your workspace, add a few products and open the till. You can be selling in under ten minutes.
        </p>

        <ul className="mx-auto mt-6 flex max-w-md flex-col gap-2 text-left text-sm">
          {[
            trialDays ? `${trialDays}-day free trial on ${trialPlanName}` : 'Free trial',
            'No card required',
            'Upgrade or cancel whenever you like',
          ].map((line) => (
            <li key={line} className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              {line}
            </li>
          ))}
        </ul>

        <Button size="lg" className="mt-8" asChild>
          <Link to="/register">
            Create your workspace
            <ArrowRight />
          </Link>
        </Button>
      </section>
    </>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</span>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
