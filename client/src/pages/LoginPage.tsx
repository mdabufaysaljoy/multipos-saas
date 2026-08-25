import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const session = await login(values.email, values.password);
      toast.success(`Welcome back, ${session.user.name.split(' ')[0]}`);
      if (session.user.role === 'platform_admin') navigate('/platform', { replace: true });
      else navigate(session.needsStoreSetup ? '/onboarding' : '/pos', { replace: true });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in';
      form.setError('password', { message });
      toast.error(message);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to your store</h1>
          <p className="text-sm text-muted-foreground">Point of sale for clothing retailers</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Welcome back</CardTitle>
            <CardDescription>Enter your credentials to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  aria-invalid={Boolean(form.formState.errors.email)}
                  {...form.register('email')}
                />
                {form.formState.errors.email && (
                  <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={Boolean(form.formState.errors.password)}
                  {...form.register('password')}
                />
                {form.formState.errors.password && (
                  <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
                )}
              </div>

              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create a workspace
          </Link>
        </p>

        {import.meta.env.DEV && (
          <Card className="bg-muted/50">
            <CardContent className="space-y-1.5 p-4 text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">Development accounts</p>
              <p>Admin — admin@demostore.dev / Admin@123</p>
              <p>Cashier (no price override) — cashier@demostore.dev / Cashier@123</p>
              <p>Senior cashier (can override) — senior@demostore.dev / Cashier@123</p>
              <p>Platform admin — platform@pos.dev / Platform@123</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
