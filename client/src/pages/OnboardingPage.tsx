import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError } from '@/api/client';
import { storeApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';

const schema = z.object({
  name: z.string().trim().min(2, 'Store name is required'),
  phone: z.string().trim().optional(),
  email: z.string().email('Enter a valid email').or(z.literal('')).optional(),
  address: z.string().trim().optional(),
  currency: z.string().length(3),
  invoicePrefix: z.string().trim().min(1).max(12),
});

type FormValues = z.infer<typeof schema>;

export function OnboardingPage() {
  const { session, refresh, logout } = useAuth();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: session?.tenant?.name ? `${session.tenant.name} - Main` : '',
      phone: '',
      email: session?.user.email ?? '',
      address: '',
      currency: 'BDT',
      invoicePrefix: 'INV-',
    },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      await storeApi.create(values);
      await refresh();
      toast.success('Your store is ready');
      navigate('/products', { replace: true });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not create the store';
      toast.error(message);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-lg space-y-6 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Set up your store</h1>
          <p className="text-sm text-muted-foreground">
            This is the shop your sales, stock and receipts belong to.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Store details</CardTitle>
            <CardDescription>These appear on your printed receipts</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="name">Store name</Label>
                <Input id="name" autoFocus {...form.register('name')} />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" placeholder="+880 1700-000000" {...form.register('phone')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" {...form.register('email')} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="address">Address</Label>
                <Textarea id="address" rows={2} placeholder="House, road, area, city" {...form.register('address')} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="currency">Currency</Label>
                  <Select
                    value={form.watch('currency')}
                    onValueChange={(value) => form.setValue('currency', value)}
                  >
                    <SelectTrigger id="currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BDT">BDT — Bangladeshi Taka</SelectItem>
                      <SelectItem value="USD">USD — US Dollar</SelectItem>
                      <SelectItem value="INR">INR — Indian Rupee</SelectItem>
                      <SelectItem value="GBP">GBP — Pound Sterling</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="invoicePrefix">Invoice prefix</Label>
                  <Input id="invoicePrefix" {...form.register('invoicePrefix')} />
                  <p className="text-xs text-muted-foreground">Receipts will read INV-000001</p>
                </div>
              </div>

              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
                Create store and continue
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          <button className="hover:underline" onClick={() => void logout().then(() => navigate('/login'))}>
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
