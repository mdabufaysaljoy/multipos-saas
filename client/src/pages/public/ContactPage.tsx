import { useQuery } from '@tanstack/react-query';
import { Mail, MapPin, Phone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { get } from '@/api/client';

/** Contact details come from platform settings, so support can change them. */
export function ContactPage() {
  const { data } = useQuery({
    queryKey: ['public', 'contact'],
    queryFn: () => get<{ supportEmail: string; supportPhone: string }>('/public/contact'),
    retry: false,
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 lg:px-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Talk to us</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Questions about a plan, a migration or a trade we do not cover yet? We answer every message.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-2 p-5 text-center">
            <Mail className="mx-auto h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Email</p>
            <p className="break-all text-sm text-muted-foreground">{data?.supportEmail || 'support@retailsuite.dev'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-5 text-center">
            <Phone className="mx-auto h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Phone</p>
            <p className="text-sm text-muted-foreground">{data?.supportPhone || '+880 1700-000000'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-5 text-center">
            <MapPin className="mx-auto h-6 w-6 text-primary" />
            <p className="text-sm font-semibold">Office</p>
            <p className="text-sm text-muted-foreground">Dhanmondi, Dhaka</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-10 rounded-lg border bg-muted/40 p-6">
        <h2 className="font-semibold">About RetailSuite</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We build point-of-sale software for independent retailers. Rather than one system that half-fits every shop,
          we build a focused product per trade on shared foundations — one account, one wallet, one place to manage
          billing. Clothing POS is live today; the rest are in development.
        </p>
      </div>
    </div>
  );
}
