import { onboardingApi } from '@/api/endpoints';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useTrialOffer } from '@/hooks/useTrialDays';

const schema = z
  .object({
    businessName: z.string().trim().min(2, 'Business name is required'),
    name: z.string().trim().min(2, 'Your name is required'),
    email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
    phone: z.string().trim().optional(),
    password: z.string().min(8, 'Use at least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormValues = z.infer<typeof schema>;

export function RegisterPage() {
  const { register: signUp } = useAuth();
  const navigate = useNavigate();
  const { days: trialDays, planName: trialPlanName } = useTrialOffer();
  // The POS types come from the platform catalog: active products only.
  const { data: posTypes, isLoading: posTypesLoading } = useQuery({ queryKey: ['public-pos-types'], queryFn: onboardingApi.publicPosTypes, staleTime: 5 * 60 * 1000 });
  const available = (posTypes ?? []).filter((option) => option.available);
  const [searchParams] = useSearchParams();
  const requestedPos = searchParams.get('pos');
  const [vertical, setVertical] = React.useState('');
  React.useEffect(() => {
    if (vertical || available.length === 0) return;
    // A POS chosen on a product page is preselected - but only if it is really offered.
    const requested = available.find((option) => option.vertical === requestedPos);
    setVertical((requested ?? available[0]).vertical);
  }, [available, vertical, requestedPos]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { businessName: '', name: '', email: '', phone: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      await signUp({
        businessName: values.businessName,
        name: values.name,
        email: values.email,
        phone: values.phone,
        password: values.password,
        vertical: vertical || undefined,
      });
      toast.success('Workspace created. Let’s set up your store.');
      navigate('/onboarding', { replace: true });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not create your workspace';
      form.setError('email', { message });
      toast.error(message);
    }
  };

  const field = (name: keyof FormValues, label: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} aria-invalid={Boolean(form.formState.errors[name])} {...props} {...form.register(name)} />
      {form.formState.errors[name] && (
        <p className="text-xs text-destructive">{form.formState.errors[name]?.message}</p>
      )}
    </div>
  );

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md space-y-6 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Store className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="text-sm text-muted-foreground">
            {trialDays ? `Start with a ${trialDays}-day free trial of ${trialPlanName}.` : 'Start with a free trial.'}{' '}
            No card required.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Business details</CardTitle>
            <CardDescription>You can change any of this later</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What type of POS do you want to create?</legend>
                {posTypesLoading ? (
                  <p className="text-xs text-muted-foreground">Loading POS types…</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
                    {available.map((option) => (
                      <label
                        key={option.vertical}
                        className={`cursor-pointer rounded-md border p-3 text-sm ${vertical === option.vertical ? 'border-primary ring-1 ring-primary' : ''}`}
                      >
                        <input type="radio" name="vertical" className="sr-only" value={option.vertical} checked={vertical === option.vertical} onChange={() => setVertical(option.vertical)} />
                        <span className="font-medium">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              {field('businessName', 'Business name', { placeholder: 'Denim Republic', autoFocus: true })}
              {field('name', 'Your name', { placeholder: 'Ayesha Rahman' })}
              {field('email', 'Email', { type: 'email', autoComplete: 'username' })}
              {field('phone', 'Phone (optional)', { placeholder: '01700000000' })}
              {field('password', 'Password', { type: 'password', autoComplete: 'new-password' })}
              {field('confirmPassword', 'Confirm password', { type: 'password', autoComplete: 'new-password' })}

              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
                Create workspace
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
