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
          <p className="text-sm text-muted-foreground">Start with a 14-day trial. No card required.</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Business details</CardTitle>
            <CardDescription>You can change any of this later</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
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
