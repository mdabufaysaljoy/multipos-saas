import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, ArrowRight, ChevronRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import type { LoginChoice, LoginSelection } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import type { Session } from '@/types/api';
import { AuthField as Field, AuthHeading, AuthShell } from '@/features/public/AuthShell';
import type { SceneState } from '@/features/public/AuthScene';

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

const VERTICAL_LABEL: Record<string, string> = {
  clothing: 'Clothing POS',
  restaurant: 'Restaurant POS',
  supershop: 'Super Shop POS',
  pharmacy: 'Pharmacy POS',
};

export function LoginPage() {
  const { login, completeLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  /**
   * Where to go after signing in, when the session lapsed on the way to a
   * particular page. Only a path within this app is accepted - never a full
   * URL, a protocol-relative one, or anything else that could send somebody
   * who has just typed their password to another site.
   */
  const requested = (location.state as { from?: unknown } | null)?.from;
  const returnTo = typeof requested === 'string' && /^\/(?!\/)/.test(requested) ? requested : null;
  const [selection, setSelection] = React.useState<LoginSelection | null>(null);
  const [choosing, setChoosing] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);

  /**
   * What the counter scene is showing.
   *
   * It follows the REAL request: `scanning` while the call is in flight,
   * `success` only once the server has returned a session, `error` only on an
   * actual failure. Nothing here is on a timer, and the scene is never told
   * what was typed.
   */
  const [scene, setScene] = React.useState<SceneState>('idle');
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const enter = (session: Session) => {
    toast.success(`Welcome back, ${session.user.name.split(' ')[0]}`);
    if (session.user.role === 'platform_admin') navigate('/platform', { replace: true });
    // Back to whatever they were trying to reach, when that is still sensible:
    // somebody returning from a payment gateway with an expired session should
    // land on their result, not on the till.
    else if (!session.needsStoreSetup && returnTo) navigate(returnTo, { replace: true });
    else navigate(session.needsStoreSetup ? '/onboarding' : '/pos', { replace: true });
  };

  /** Lets the success frame land before the redirect takes the page away. */
  const settleThen = (run: () => void) => window.setTimeout(run, 620);

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    setScene('scanning');
    try {
      const result = await login(values.email, values.password);
      if ('requiresWorkspaceSelection' in result) {
        // Credentials were right; the account just has more than one login.
        setScene('success');
        settleThen(() => {
          setSelection(result);
          setScene('idle');
        });
        return;
      }
      setScene('success');
      settleThen(() => enter(result));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in. Check your connection and try again.';
      setScene('error');
      setFormError(message);
      form.setError('password', { message: '' });
      form.setFocus('password');
    }
  };

  const choose = async (choice: LoginChoice) => {
    if (!selection) return;
    setChoosing(choice.userId);
    setScene('scanning');
    try {
      const session = await completeLogin(selection.selectionToken, choice.userId);
      setScene('success');
      settleThen(() => enter(session));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not sign in';
      setScene('error');
      setFormError(message);
      toast.error(message);
      // An expired or invalidated choice means the password must be typed again.
      setSelection(null);
      form.setValue('password', '');
    } finally {
      setChoosing(null);
    }
  };

  // One flag for every path that must not be submitted twice.
  const busy = form.formState.isSubmitting || scene === 'scanning' || scene === 'success' || Boolean(choosing);

  return (
    <AuthShell
      eyebrow="Secure sign in"
      title="Your counter is open and waiting."
      copy="Stock, team, sales and reports are exactly as you left them."
      sceneState={scene}
    >
      {selection ? (
        <>
          <AuthHeading title="Choose a workspace" copy="This email signs in to more than one. Pick the one you want." />
          <div className="space-y-2.5">
            {selection.choices.map((choice) => (
              <button
                key={choice.userId}
                type="button"
                disabled={busy}
                onClick={() => void choose(choice)}
                className="group flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-4 text-left outline-none transition-all duration-300 hover:border-white/20 hover:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.9375rem] font-semibold text-white">{choice.workspaceName}</span>
                  <span className="block truncate text-[0.8125rem] text-slate-400">
                    {choice.roleLabel}
                    {choice.vertical ? ` · ${VERTICAL_LABEL[choice.vertical] ?? choice.vertical}` : ''}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-500 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-white" aria-hidden />
              </button>
            ))}
            <Button
              variant="ghost"
              className="w-full rounded-xl text-slate-400 hover:bg-white/5 hover:text-white"
              onClick={() => {
                setSelection(null);
                setScene('idle');
              }}
              disabled={busy}
            >
              <ArrowLeft />
              Use a different account
            </Button>
          </div>
        </>
      ) : (
        <>
          <AuthHeading title="Sign in" copy="Welcome back to Retailer Suites." />

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            {formError && (
              <div
                role="alert"
                className="rs-scan-pop flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
                <p className="text-[0.875rem] leading-6 text-rose-200">{formError}</p>
              </div>
            )}

            <Field
              id="email"
              label="Email"
              icon={Mail}
              error={form.formState.errors.email?.message}
              inputProps={{
                type: 'email',
                autoComplete: 'username',
                autoFocus: true,
                placeholder: 'you@business.com',
                ...form.register('email'),
              }}
            />

            <Field
              id="password"
              label="Password"
              icon={Lock}
              error={form.formState.errors.password?.message}
              // The one way back in for somebody locked out. It sits on the
              // password field because that is where they discover the problem.
              labelAside={
                <Link
                  to="/forgot-password"
                  className="rounded text-[0.8125rem] font-medium text-slate-400 outline-none transition-colors hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  Forgot password?
                </Link>
              }
              inputProps={{
                type: showPassword ? 'text' : 'password',
                autoComplete: 'current-password',
                placeholder: '••••••••',
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

            <Button
              type="submit"
              disabled={busy}
              loading={scene === 'scanning'}
              className="h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
            >
              {scene === 'success' ? 'Verified' : 'Sign in'}
              {scene !== 'success' && <ArrowRight />}
            </Button>
          </form>
        </>
      )}

      <p className="mt-8 text-center text-[0.875rem] text-slate-400">
        New here?{' '}
        <Link
          to="/register"
          className="rounded font-semibold text-white outline-none transition-colors hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          Create a workspace
        </Link>
      </p>
    </AuthShell>
  );
}
