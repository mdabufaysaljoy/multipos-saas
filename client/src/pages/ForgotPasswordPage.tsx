import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Lock, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import { authApi } from '@/api/endpoints';
import { AuthField, AuthHeading, AuthShell } from '@/features/public/AuthShell';
import type { SceneState } from '@/features/public/AuthScene';
import { cn } from '@/lib/utils';

/**
 * Forgotten password, for every POS at once.
 *
 * One screen, three steps, because the person has to be told the code was
 * wrong before being asked to invent a password:
 *
 *   email -> code -> new password -> done
 *
 * Nothing here decides anything. Each step is a real request, and the scene
 * follows it: `scanning` while a call is in flight, `success` only once the
 * server has answered, `error` only on an actual failure. No timers pretend
 * progress, and the page never learns whether the address exists - the first
 * step answers identically either way, which is why it always advances.
 */

const emailSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
});
const codeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your email'),
});
/** Mirrors the server's one password policy: 8-128 characters. */
const passwordSchema = z
  .object({
    newPassword: z.string().min(8, 'Use at least 8 characters').max(128, 'That password is too long'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type EmailValues = z.infer<typeof emailSchema>;
type CodeValues = z.infer<typeof codeSchema>;
type PasswordValues = z.infer<typeof passwordSchema>;

type Step = 'email' | 'code' | 'password' | 'done';

const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = React.useState<Step>('email');
  const [scene, setScene] = React.useState<SceneState>('idle');
  const [formError, setFormError] = React.useState<string | null>(null);

  // What the earlier steps established. The ticket is the only thing that lets
  // the last step through, and it came from the server.
  const [email, setEmail] = React.useState('');
  const [maskedEmail, setMaskedEmail] = React.useState('');
  const [resetTicket, setResetTicket] = React.useState('');
  const [expiresInMinutes, setExpiresInMinutes] = React.useState(15);
  const [resendIn, setResendIn] = React.useState(0);
  /** Outside production the API hands back the code, so a server with no SMTP is still testable. */
  const [devCode, setDevCode] = React.useState<string | null>(null);

  const [showPassword, setShowPassword] = React.useState(false);

  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema), defaultValues: { email: '' } });
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } });
  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  // The resend cooldown the server told us about, counted down for the button.
  React.useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  const busy = scene === 'scanning';

  /**
   * Step 1, and the resend.
   *
   * It only advances when the server confirms a code went out. An address with
   * no account is refused with a 404 and the screen stays here showing why -
   * being told plainly beats waiting for a code that was never coming.
   */
  const requestCode = async (address: string) => {
    setFormError(null);
    setScene('scanning');
    try {
      const result = await authApi.forgotPassword({ email: address });
      setEmail(address);
      setExpiresInMinutes(result.expiresInMinutes);
      setResendIn(result.resendAfterSeconds);
      setDevCode(result.devCode ?? null);
      setScene('success');
      setStep('code');
      codeForm.reset({ code: '' });
      window.setTimeout(() => setScene('idle'), 620);
      return true;
    } catch (error) {
      // An unknown address, a cooldown or an IP rate limit are all real
      // refusals and are shown as such.
      const message = errorText(error, 'Could not send a code. Check your connection and try again.');
      setScene('error');
      setFormError(message);
      // A refusal about the ADDRESS belongs on the address field, so it is
      // marked and focused rather than left for the person to hunt for.
      if (error instanceof ApiError && error.status === 404) {
        emailForm.setError('email', { message });
        emailForm.setFocus('email');
      }
      return false;
    }
  };

  const onEmail = async (values: EmailValues) => {
    await requestCode(values.email.trim());
  };

  const onCode = async (values: CodeValues) => {
    setFormError(null);
    setScene('scanning');
    try {
      const result = await authApi.verifyPasswordResetCode({ email, code: values.code.trim() });
      setResetTicket(result.resetTicket);
      setMaskedEmail(result.maskedEmail);
      setScene('success');
      setStep('password');
      window.setTimeout(() => setScene('idle'), 620);
    } catch (error) {
      setScene('error');
      setFormError(errorText(error, 'Could not check that code. Try again.'));
      codeForm.setFocus('code');
    }
  };

  const onPassword = async (values: PasswordValues) => {
    setFormError(null);
    setScene('scanning');
    try {
      await authApi.resetPassword({ resetTicket, newPassword: values.newPassword });
      // Only after the server has actually changed it.
      setScene('success');
      setStep('done');
      passwordForm.reset({ newPassword: '', confirmPassword: '' });
      toast.success('Password updated. Sign in with your new password.');
    } catch (error) {
      setScene('error');
      setFormError(errorText(error, 'Could not set your new password. Start again from the beginning.'));
    }
  };

  const banner = formError && (
    <div role="alert" className="rs-scan-pop flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
      <p className="text-[0.875rem] leading-6 text-rose-200">{formError}</p>
    </div>
  );

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Back behind the counter in a minute."
      copy="We email you a six-digit code. Type it in, choose a new password, and your shop is open again."
      sceneState={scene}
    >
      {step === 'email' && (
        <>
          <AuthHeading title="Forgot your password?" copy="Enter the email you sign in with and we will send a code." />
          <form onSubmit={emailForm.handleSubmit(onEmail)} className="space-y-5" noValidate>
            {banner}
            <AuthField
              id="reset-email"
              label="Email"
              icon={Mail}
              error={emailForm.formState.errors.email?.message}
              inputProps={{
                type: 'email',
                autoComplete: 'username',
                autoFocus: true,
                placeholder: 'you@business.com',
                ...emailForm.register('email'),
              }}
            />
            <Button
              type="submit"
              disabled={busy}
              loading={busy}
              className="h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
            >
              Send code
              <ArrowRight />
            </Button>
          </form>
        </>
      )}

      {step === 'code' && (
        <>
          {/* This step is only reached once the server has confirmed the
              account and sent the code, so it says so plainly and names the
              address it went to. */}
          <AuthHeading
            title="Enter your code"
            copy={`A 6-digit code is on its way to ${email}. It expires in ${expiresInMinutes} minutes.`}
          />
          <form onSubmit={codeForm.handleSubmit(onCode)} className="space-y-5" noValidate>
            {banner}
            {devCode && (
              // Development only: the API returns the code when there is no SMTP
              // to send it. A production build never receives this field.
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3">
                <p className="text-[0.8125rem] leading-6 text-amber-200">
                  Development server: your code is <span className="font-mono font-bold tracking-[0.2em]">{devCode}</span>
                </p>
              </div>
            )}
            <AuthField
              id="reset-code"
              label="6-digit code"
              icon={KeyRound}
              error={codeForm.formState.errors.code?.message}
              inputProps={{
                inputMode: 'numeric',
                autoComplete: 'one-time-code',
                autoFocus: true,
                maxLength: 6,
                placeholder: '123456',
                className: 'h-12 rounded-xl border-white/10 bg-white/[0.04] pl-10 text-center text-lg font-semibold tracking-[0.5em] text-white placeholder:tracking-normal placeholder:text-slate-600',
                ...codeForm.register('code'),
              }}
            />
            <Button
              type="submit"
              disabled={busy}
              loading={busy}
              className="h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
            >
              Verify code
              <ArrowRight />
            </Button>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                className="text-slate-400 hover:bg-white/5 hover:text-white"
                disabled={busy || resendIn > 0}
                onClick={() => void requestCode(email)}
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Send a new code'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="text-slate-400 hover:bg-white/5 hover:text-white"
                disabled={busy}
                onClick={() => {
                  setFormError(null);
                  setDevCode(null);
                  setStep('email');
                }}
              >
                <ArrowLeft />
                Use a different email
              </Button>
            </div>

            {/* The account is known to exist by now, so the remaining reasons
                a code has not arrived are the mailbox, not the address. */}
            <p className="pt-1 text-center text-[0.8125rem] leading-6 text-slate-500">
              No code after a minute? Check your spam folder, or send a new one.
            </p>
          </form>
        </>
      )}

      {step === 'password' && (
        <>
          <AuthHeading
            title="Choose a new password"
            copy={maskedEmail ? `For ${maskedEmail}. This signs you out everywhere else.` : 'This signs you out everywhere else.'}
          />
          <form onSubmit={passwordForm.handleSubmit(onPassword)} className="space-y-5" noValidate>
            {banner}
            <AuthField
              id="reset-password"
              label="New password"
              icon={Lock}
              hint="At least 8 characters"
              error={passwordForm.formState.errors.newPassword?.message}
              inputProps={{
                type: showPassword ? 'text' : 'password',
                autoComplete: 'new-password',
                autoFocus: true,
                placeholder: 'At least 8 characters',
                ...passwordForm.register('newPassword'),
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
            <AuthField
              id="reset-confirm"
              label="Confirm new password"
              icon={Lock}
              error={passwordForm.formState.errors.confirmPassword?.message}
              inputProps={{
                type: showPassword ? 'text' : 'password',
                autoComplete: 'new-password',
                placeholder: 'Type it again',
                ...passwordForm.register('confirmPassword'),
              }}
            />
            <Button
              type="submit"
              disabled={busy}
              loading={busy}
              className="h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
            >
              Set new password
              <ArrowRight />
            </Button>
          </form>
        </>
      )}

      {step === 'done' && (
        <div className={cn('rs-scan-pop text-center')}>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10">
            <CheckCircle2 className="h-7 w-7 text-emerald-300" aria-hidden />
          </div>
          <h1 className="rs-h2 mt-6 text-[1.875rem] font-bold text-white">Password reset</h1>
          <p className="mt-2.5 text-[0.9375rem] leading-7 text-slate-400">
            Your password has been changed. Every other device has been signed out.
          </p>
          <Button
            className="mt-8 h-12 w-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950 shadow-[0_14px_40px_-12px_rgba(79,70,229,0.8)] transition hover:brightness-110"
            onClick={() => navigate('/login', { replace: true })}
          >
            Back to sign in
            <ArrowRight />
          </Button>
        </div>
      )}

      {step !== 'done' && (
        <p className="mt-8 text-center text-[0.875rem] text-slate-400">
          Remembered it?{' '}
          <Link
            to="/login"
            className="rounded font-semibold text-white outline-none transition-colors hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            Back to sign in
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
