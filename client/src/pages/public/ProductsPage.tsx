import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SAAS_PRODUCTS } from './products.data';

export function PublicProductsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 lg:px-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">One platform, many trades</h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
          Each system is built for how that trade actually works, rather than one generic till bent into shape.
        </p>
      </div>

      <div className="mt-12 space-y-6">
        {SAAS_PRODUCTS.map((product) => (
          <Card key={product.slug}>
            <CardContent className="grid gap-6 p-6 md:grid-cols-[auto_1fr_auto] md:items-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <product.icon className="h-7 w-7" />
              </span>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold">{product.name}</h2>
                  {product.status === 'live' ? (
                    <Badge variant="success">Available now</Badge>
                  ) : (
                    <Badge variant="secondary">Coming soon</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{product.description}</p>

                <ul className="grid gap-1 pt-1 sm:grid-cols-2">
                  {product.highlights.map((line) => (
                    <li key={line} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="md:text-right">
                {product.status === 'live' ? (
                  <Button asChild>
                    <Link to="/register">
                      Start free
                      <ArrowRight />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" disabled>
                    In development
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
