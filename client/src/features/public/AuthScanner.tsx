import { cn } from '@/lib/utils';

/**
 * The authentication scanner.
 *
 * A handheld reader scanning a Retailer Suites card. It takes ONE prop - which
 * state to show - and knows nothing about credentials, the auth API or what
 * went wrong; the page drives it from the real result, so the tick can only be
 * drawn after the server has actually said yes.
 *
 * Built as inline SVG animated by keyframes rather than a Lottie player: the
 * app ships no Lottie runtime, the visual is specific to this product (a stock
 * animation of a generic padlock would say less), and this way it themes with
 * the rest of the site and costs nothing to load.
 */
export type ScannerState = 'idle' | 'scanning' | 'success' | 'error';

/** A fixed pattern - decorative only, and deliberately not derived from anything real. */
const BARS = [3, 1, 2, 1, 1, 4, 1, 2, 3, 1, 1, 2, 4, 1, 2, 1, 3, 1, 1, 2];

const TONE: Record<ScannerState, { stroke: string; glow: string; label: string }> = {
  idle: { stroke: '#64748b', glow: 'rgba(79,70,229,0.28)', label: 'Ready to scan' },
  scanning: { stroke: '#22d3ee', glow: 'rgba(34,211,238,0.45)', label: 'Scanning your credentials' },
  success: { stroke: '#34d399', glow: 'rgba(52,211,153,0.5)', label: 'Verified' },
  error: { stroke: '#f87171', glow: 'rgba(248,113,113,0.45)', label: 'Not recognised' },
};

export function AuthScanner({ state = 'idle', className }: { state?: ScannerState; className?: string }) {
  const tone = TONE[state];
  const scanning = state === 'scanning';
  const settled = state === 'success' || state === 'error';

  return (
    <div className={cn('relative select-none', className)}>
      {/* the light the reader throws */}
      <div
        aria-hidden
        className="absolute -inset-12 rounded-[4rem] blur-3xl transition-all duration-700"
        style={{ background: `radial-gradient(55% 55% at 50% 45%, ${tone.glow}, transparent 70%)` }}
      />

      <div
        className={cn(
          'relative mx-auto w-full max-w-[22rem] transition-transform duration-500',
          state === 'error' && 'rs-scan-shake',
        )}
      >
        {/* ---------------------------------------------------------- card */}
        <div
          className={cn(
            'rs-ring relative overflow-hidden rounded-[1.25rem] border p-6 backdrop-blur-xl transition-colors duration-500',
            settled ? 'border-white/20' : 'border-white/10',
            'bg-white/[0.055]',
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Retailer Suites</p>
            <span
              className="h-1.5 w-1.5 rounded-full transition-colors duration-500"
              style={{ background: tone.stroke }}
            />
          </div>

          {/* the barcode */}
          <div className="relative mt-5 h-28 overflow-hidden rounded-lg bg-slate-950/50 px-4 py-4">
            <div className="flex h-full items-stretch gap-[3px]">
              {BARS.map((weight, index) => (
                <span
                  key={index}
                  className={cn('rounded-[1px] transition-colors duration-500', state === 'idle' && 'rs-bar-idle')}
                  style={{
                    width: `${weight * 2}px`,
                    background: settled ? tone.stroke : '#e2e8f0',
                    opacity: settled ? 0.85 : undefined,
                    animationDelay: `${index * 90}ms`,
                  }}
                />
              ))}
            </div>

            {/* the beam, only while the request is actually in flight */}
            {scanning && (
              <>
                <span
                  aria-hidden
                  className="rs-scan-beam absolute inset-x-0 top-0 h-10"
                  style={{
                    background: 'linear-gradient(to bottom, transparent, rgba(34,211,238,0.28), transparent)',
                    boxShadow: '0 0 24px 6px rgba(34,211,238,0.32)',
                  }}
                />
                {[12, 34, 56, 78].map((left, index) => (
                  <span
                    key={left}
                    aria-hidden
                    className="rs-scan-mote absolute bottom-3 h-1 w-1 rounded-full bg-cyan-300"
                    style={{ left: `${left}%`, animationDelay: `${index * 180}ms` }}
                  />
                ))}
              </>
            )}

            {/* the verdict, drawn over the code once the server has answered */}
            {settled && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  aria-hidden
                  className="rs-scan-burst absolute h-16 w-16 rounded-full"
                  style={{ background: tone.glow }}
                />
                <span
                  className="rs-scan-pop relative flex h-14 w-14 items-center justify-center rounded-full"
                  style={{ background: state === 'success' ? 'rgba(52,211,153,0.16)' : 'rgba(248,113,113,0.16)' }}
                >
                  <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" aria-hidden>
                    {state === 'success' ? (
                      <path
                        d="m6 12.4 4 4 8-8.8"
                        stroke={tone.stroke}
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="rs-check-draw"
                      />
                    ) : (
                      <>
                        <path d="M7 7l10 10M17 7 7 17" stroke={tone.stroke} strokeWidth="2.4" strokeLinecap="round" className="rs-check-draw" />
                      </>
                    )}
                  </svg>
                </span>
              </div>
            )}
          </div>

          <p className="mt-4 text-center font-mono text-[10px] tracking-[0.3em] text-slate-500">· · · · · · · ·</p>
        </div>

        {/* -------------------------------------------------------- reader */}
        <div className="relative mx-auto -mt-3 w-40">
          <div
            className={cn(
              'rs-ring rounded-[1rem] border border-white/10 bg-white/[0.07] px-4 py-3 backdrop-blur-xl transition-transform duration-500',
              scanning ? 'translate-y-1' : 'translate-y-0',
            )}
          >
            <div className="flex items-center justify-center gap-1.5">
              <span className="h-1 w-10 rounded-full bg-slate-600" />
              <span
                className="h-2 w-2 rounded-full transition-colors duration-300"
                style={{ background: tone.stroke, boxShadow: `0 0 10px ${tone.stroke}` }}
              />
              <span className="h-1 w-10 rounded-full bg-slate-600" />
            </div>
          </div>
          <div aria-hidden className="mx-auto h-5 w-7 rounded-b-md bg-white/[0.07]" />
        </div>
      </div>

      {/*
        One live region for the whole visual. Screen readers hear the state
        change; the form owns the real error text, so this stays generic.
      */}
      <p role="status" aria-live="polite" className="mt-7 text-center text-[0.8125rem] font-medium text-slate-400">
        {tone.label}
      </p>
    </div>
  );
}
