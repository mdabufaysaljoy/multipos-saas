import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, Building2, Layers, Receipt, ShieldCheck, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SAAS_PRODUCTS } from './products.data';

const PLATFORM_FEATURES = [
  { icon: Layers, title: 'Several POS on one account', text: 'Run a clothing shop, a supershop, a restaurant and a pharmacy from one login. Each is its own workspace with its own stock, staff and subscription.' },
  { icon: Wallet, title: 'One wallet for everything', text: 'Top up once and pay every workspace subscription and service from the same balance, with a full statement of every movement.' },
  { icon: BarChart3, title: 'Dashboard and analytics', text: 'A sales dashboard on every plan. Advanced Analytics - profit, products, customers and staff - on Professional and Enterprise.' },
  { icon: Building2, title: 'Branches', text: 'Separate stock, staff and sales per branch, with an owner view across all of them. The number of branches depends on the plan.' },
  { icon: Users, title: 'Staff and roles', text: 'Give each person exactly the access they need. Permissions are enforced on the server, not just hidden in the app.' },
  { icon: Receipt, title: 'Receipts and invoices', text: 'Thermal receipts at the till, and invoices for every subscription payment you make.' },
  { icon: ShieldCheck, title: 'Your data stays yours', text: 'Every workspace is isolated. Staff of one business never see another business, and past sales never change when you re-price today.' },
];

/** What the platform does across every POS, with a way into each POS's own page. */
export function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 lg:px-6 lg:py-16">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Features</h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
          The platform every POS runs on, and what each one adds for its trade.
        </p>
      </header>

      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORM_FEATURES.map((feature) => (
          <Card key={feature.title}>
            <CardContent className="space-y-2 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <feature.icon className="h-5 w-5" />
              </span>
              <h2 className="font-semibold">{feature.title}</h2>
              <p className="text-sm text-muted-foreground">{feature.text}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-16">
        <h2 className="text-center text-2xl font-bold tracking-tight">Features by POS</h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">See each system in detail, with what every plan includes.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {SAAS_PRODUCTS.map((product) => (
            <Card key={product.slug} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <product.icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold">{product.name}</h3>
                    <p className="text-xs text-muted-foreground">{product.tagline}</p>
                  </div>
                </div>
                <ul className="flex-1 space-y-1 text-sm text-muted-foreground">
                  {product.highlights.map((line) => (
                    <li key={line}>• {line}</li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" className="w-full sm:w-auto sm:self-start" asChild>
                  <Link to={`/products/${product.slug}`}>
                    {product.name} features and plans
                    <ArrowRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
