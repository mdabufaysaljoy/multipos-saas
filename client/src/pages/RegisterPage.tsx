import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, Building2, Eye, EyeOff, Lock, Mail, Phone, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import { onboardingApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { useTrialOffer } from '@/hooks/useTrialDays';
import { AuthField, AuthHeading, AuthShell } from '@/features/public/AuthShell';
import type { SceneState } from '@/features/public/AuthScene';
import { cn } from '@/lib/utils';

/**
 * Mirrors the server's register schema. The only rule the backend enforces on
 * a password is 8-128 characters, so that is the only one treated as an error;
 * everything else the meter shows is advice.
 */
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

/** Advice, not a gate: the server asks only for length. */
function strengthOf(password: string) {
  if (!password) return { score: 0, label: '', tone: '' };
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  const label = score <= 2 ? 'Weak' : score === 3 ? 'Fair' : score === 4 ? 'Strong' : 'Excellent';
  const tone = score <= 2 ? 'bg-rose-400' : score === 3 ? 'bg-amber-400' : 'bg-emerald-400';
  return { score, label, tone };
}

export function RegisterPage() {
  const { register: signUp } = useAuth();
  const navigate = useNavigate();
  const { days: trialDays, planName: trialPlanName } = useTrialOffer();
  const [searchParams] = useSearchParams();
  const requestedPos = searchParams.get('pos');

  const [vertical, setVertical] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [scene, setScene] = React.useState<SceneState>('idle');
  const [formError, setFormError] = React.useState<string | null>(null);

  // The POS types come from the platform catalog: active products only.
  const { data: posTypes, isLoading: posTypesLoading } = useQuery({
    queryKey: ['public-pos-types'],
    queryFn: onboardingApi.publicPosTypes,
    staleTime: 5 * 60 * 1000,
  });
  const available = React.useMemo(() => (posTypes ?? []).filter((option) => option.available), [posTypes]);

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

  const password = form.watch('password');
  const strength = strengthOf(password ?? '');

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    setScene('scanning');
    try {
      await signUp({
        businessName: values.businessName,
        name: values.name,
        email: values.email,
        phone: values.phone,
        password: values.password,
        vertical: vertical || undefined,
      });
      // Only after the server has created the workspace.
      setScene('success');
      window.setTimeout(() => {
        toast.success('Workspace created. Let’s set up your store.');
        navigate('/onboarding', { replace: true });
      }, 620);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not create your workspace. Check your connection and try again.';
      setScene('error');
      setFormError(message);
      form.setError('email', { message: '' });
      form.setFocus('email');
    }
  };

  const busy = form.formState.isSubmitting || scene === 'scanning' || scene === 'success';

  return (
    <AuthShell
      eyebrow="Get started"
      title="Minutes from your first receipt."
      copy={trialDays ? `Start with a ${trialDays}-day free trial of ${trialPlanName}. No card required.` : 'Start free. No card required.'}
      sceneState={scene}
    >
      <AuthHeading
        title="Create your workspace"
        copy={trialDays ? `${trialDays} days free. No card required.` : 'Free to start. No card required.'}
      />

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
        {formError && (
          <div role="alert" className="rs-scan-pop flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
            <p className="text-[0.875rem] leading-6 text-rose-200">{formError}</p>
          </div>
        )}

        {/* ----------------------------------------------------- POS type */}
        <fieldset className="space-y-2.5">
          <legend className="text-[0.8125rem] font-medium text-slate-300">Which POS do you want?</legend>
          {posTypesLoading ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="h-[3.75rem] animate-pulse rounded-xl border border-white/10 bg-white/[0.04]" />
              ))}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="POS type">
              {available.map((option) => {
                const selected = vertical === option.vertical;
                return (
                  <label
                    key={option.vertical}
                    className={cn(
                      'cursor-pointer rounded-xl border p-3.5 text-left outline-none transition-all duration-300',
                      selected
                        ? 'border-indigo-400/60 bg-indigo-500/10 shadow-[0_12px_32px_-20px_rgba(79,70,229,0.9)]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]',
                      'focus-within:ring-2 focus-within:ring-indigo-400',
                    )}
                  >
                    <input
                      type="radio"
                      name="vertical"
                      className="sr-only"
                      value={option.vertical}
                      checked={selected}
                      onChange={() => setVertical(option.vertical)}
                      disabled={busy}
                    />
                    <span className={cn('block text-[0.875rem] font-semibold', selected ? 'text-white' : 'text-slate-300')}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-[0.75rem] leading-5 text-slate-500">{option.description}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        <AuthField
          id="businessName"
          label="Business name"
          icon={Building2}
          error={form.formState.errors.businessName?.message}
          inputProps={{ placeholder: 'Denim Republic', autoFocus: true, ...form.register('businessName') }}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <AuthField
            id="name"
            label="Your name"
            icon={User}
            error={form.formState.errors.name?.message}
            inputProps={{ placeholder: 'Ayesha Rahman', autoComplete: 'name', ...form.register('name') }}
          />
          <AuthField
            id="phone"
            label="Phone"
            icon={Phone}
            hint="Optional"
            error={form.formState.errors.phone?.message}
            inputProps={{ placeholder: '01700000000', autoComplete: 'tel', ...form.register('phone') }}
          />
        </div>

        <AuthField
          id="email"
          label="Email"
          icon={Mail}
          error={form.formState.errors.email?.message}
          inputProps={{ type: 'email', autoComplete: 'username', placeholder: 'you@business.com', ...form.register('email') }}
        />

        <div>
          <AuthField
            id="password"
            label="Password"
            icon={Lock}
            error={form.formState.errors.password?.message}
            inputProps={{
              type: showPassword ? 'text' : 'password',
              autoComplete: 'new-password',
              placeholder: 'At least 8 characters',
              ...form.register('password'),
            }}
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="rounded-md p-1 text-slate-500 outline-none transition-colors hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            }
          />
          {password && (
            <div className="mt-2.5 flex items-center gap-2.5">
              <div className="flex h-1 flex-1 gap-1" aria-hidden>
                {[0, 1, 2, 3, 4].map((step) => (
                  <span
                    key={step}
                    className={cn('flex-1 rounded-full transition-colors duration-300', step < strength.score ? strength.tone : 'bg-white/10')}
                  />
                ))}
              </div>
              <span className="text-[0.75rem] text-slate-400">{strength.label}</span>
            </div>
          )}
        </div>

        <AuthField
          id="confirmPassword"
          label="Confirm password"
          icon={Lock}
          error={form.formState.errors.confirmPassword?.message}
          inputProps={{
            type: showPassword ? 'text' : 'password',
            autoComplete: 'new-password',
            placeholder: 'Type it again',
            ...form.register('confirmPassword'),
          }}
        />

        <Button
          type="submit"
          disabled={busy}
          loading={scene === 'scanning'}
          className="h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
        >
          {scene === 'success' ? 'Workspace created' : 'Create workspace'}
          {scene !== 'success' && <ArrowRight />}
        </Button>
      </form>

      <p className="mt-8 text-center text-[0.875rem] text-slate-400">
        Already have an account?{' '}
        <Link
          to="/login"
          className="rounded font-semibold text-white outline-none transition-colors hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
