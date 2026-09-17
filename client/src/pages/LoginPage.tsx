import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ChevronRight, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/api/client';
import type { LoginChoice, LoginSelection } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import type { Session } from '@/types/api';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

const VERTICAL_LABEL: Record<string, string> = { clothing: 'Clothing POS', restaurant: 'Restaurant POS' };

export function LoginPage() {
  const { login, completeLogin } = useAuth();
  const navigate = useNavigate();
  const [selection, setSelection] = React.useState<LoginSelection | null>(null);
  const [choosing, setChoosing] = React.useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const enter = (session: Session) => {
    toast.success(`Welcome back, ${session.user.name.split(' ')[0]}`);
    if (session.user.role === 'platform_admin') navigate('/platform', { replace: true });
    else navigate(session.needsStoreSetup ? '/onboarding' : '/pos', { replace: true });
  };

  const onSubmit = async (values: FormValues) => {
    try {
      const result = await login(values.email, values.password);
      if ('requiresWorkspaceSelection' in result) {
        setSelection(result);
        return;
      }
      enter(result);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in';
      form.setError('password', { message });
      toast.error(message);
    }
  };

  const choose = async (choice: LoginChoice) => {
    if (!selection) return;
    setChoosing(choice.userId);
    try {
      enter(await completeLogin(selection.selectionToken, choice.userId));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not sign in');
      // An expired or invalidated choice means the password must be entered again.
      setSelection(null);
      form.setValue('password', '');
    } finally {
      setChoosing(null);
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
          <p className="text-sm text-muted-foreground">Point of sale for your business</p>
        </div>

        {selection ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Choose where to sign in</CardTitle>
              <CardDescription>This email has more than one login. Pick the one you want to use.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {selection.choices.map((choice) => (
                <button
                  key={choice.userId}
                  type="button"
                  disabled={Boolean(choosing)}
                  onClick={() => void choose(choice)}
                  className="flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{choice.workspaceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {choice.roleLabel}
                      {choice.vertical ? ` · ${VERTICAL_LABEL[choice.vertical] ?? choice.vertical}` : ''}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
              <Button variant="ghost" className="w-full" onClick={() => setSelection(null)} disabled={Boolean(choosing)}>
                <ArrowLeft />
                Use a different account
              </Button>
            </CardContent>
          </Card>
        ) : (
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
        )}

        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create a workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
