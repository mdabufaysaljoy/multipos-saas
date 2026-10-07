import { cn } from '@/lib/utils';

/**
 * The authentication scene.
 *
 * An operator at the counter ringing up a sale on Retailer Suites while the
 * printer feeds the receipt. It takes ONE prop - which state to show - and
 * knows nothing about credentials, the auth API or what went wrong; the page
 * drives it from the real result, so the receipt only finishes and the tick is
 * only drawn after the server has actually said yes.
 *
 * Drawn as inline SVG animated by keyframes in `index.css` rather than played
 * from a Lottie file: the app ships no Lottie runtime, the scene is this
 * product's own counter rather than a stock illustration, and this way it
 * themes with the site, scales cleanly and costs no request.
 */
export type SceneState = 'idle' | 'scanning' | 'success' | 'error';

const TONE: Record<SceneState, { accent: string; glow: string; label: string }> = {
  idle: { accent: '#818cf8', glow: 'rgba(79,70,229,0.3)', label: 'Ready at the counter' },
  scanning: { accent: '#22d3ee', glow: 'rgba(34,211,238,0.45)', label: 'Checking your details' },
  success: { accent: '#34d399', glow: 'rgba(52,211,153,0.5)', label: 'Signed in — receipt printed' },
  error: { accent: '#f87171', glow: 'rgba(248,113,113,0.45)', label: 'Could not complete that' },
};

/** The lines that appear on the till screen, as a running sale. */
const ROWS = [
  { w: 30, price: 14 },
  { w: 22, price: 12 },
  { w: 26, price: 13 },
];

export function AuthScene({ state = 'idle', className }: { state?: SceneState; className?: string }) {
  const tone = TONE[state];
  const working = state === 'scanning';
  const settled = state === 'success' || state === 'error';

  return (
    <div className={cn('relative select-none', className)}>
      {/* the light the counter throws */}
      <div
        aria-hidden
        // Tighter on a phone: at 375px a 2.5rem bleed pushes the page sideways.
        className="absolute -inset-5 rounded-[4rem] blur-3xl transition-all duration-700 sm:-inset-10"
        style={{ background: `radial-gradient(55% 55% at 50% 48%, ${tone.glow}, transparent 70%)` }}
      />

      <div className={cn('relative transition-transform duration-500', state === 'error' && 'rs-pos-shake')}>
        <svg viewBox="0 0 340 250" className="w-full" role="img" aria-label="A shop counter printing a receipt">
          <defs>
            <linearGradient id="rs-screen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={tone.accent} stopOpacity="0.22" />
              <stop offset="1" stopColor={tone.accent} stopOpacity="0.06" />
            </linearGradient>
            <linearGradient id="rs-paper" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f8fafc" />
              <stop offset="1" stopColor="#e2e8f0" />
            </linearGradient>
            <clipPath id="rs-screen-clip">
              <rect x="150" y="62" width="128" height="78" rx="6" />
            </clipPath>
          </defs>

          {/* ------------------------------------------------- the operator */}
          <g className="rs-pos-bob">
            {/* torso */}
            <path d="M36 196c0-26 15-42 34-42s34 16 34 42z" fill="#1e293b" />
            <path d="M44 196c0-21 11-34 26-34s26 13 26 34z" fill="#334155" />
            {/* head */}
            <circle cx="70" cy="132" r="21" fill="#475569" />
            <path d="M51 126a19 19 0 0 1 38 0 34 34 0 0 0-38 0z" fill="#1e293b" />
            {/* arm reaching for the keyboard */}
            <g className="rs-pos-type">
              <path d="M98 172c14 4 26 10 34 18" stroke="#334155" strokeWidth="11" strokeLinecap="round" fill="none" />
              <circle cx="134" cy="191" r="6" fill="#475569" />
            </g>
          </g>

          {/* ----------------------------------------------------- monitor */}
          <g>
            <rect x="144" y="56" width="140" height="90" rx="10" fill="#0f172a" stroke="rgba(255,255,255,.12)" />
            <rect x="150" y="62" width="128" height="78" rx="6" fill="url(#rs-screen)" />

            <g clipPath="url(#rs-screen-clip)">
              {/* header bar */}
              <rect x="150" y="62" width="128" height="13" fill={tone.accent} opacity=".22" />
              <circle cx="158" cy="68.5" r="2" fill={tone.accent} />
              <rect x="165" y="66" width="30" height="5" rx="2.5" fill={tone.accent} opacity=".5" />

              {/* the sale, line by line */}
              {ROWS.map((row, index) => (
                <g key={index} className={working ? 'rs-pos-row' : undefined} style={{ animationDelay: `${index * 320}ms` }}>
                  <rect x="158" y={84 + index * 13} width={row.w} height="5" rx="2.5" fill="#cbd5e1" opacity=".75" />
                  <rect x={270 - row.price} y={84 + index * 13} width={row.price} height="5" rx="2.5" fill={tone.accent} opacity=".85" />
                </g>
              ))}

              {/* total */}
              <rect x="158" y="126" width="112" height="1" fill="rgba(255,255,255,.14)" />
              <rect x="158" y="131" width="20" height="6" rx="3" fill="#94a3b8" opacity=".8" />
              <rect x="238" y="130" width="32" height="8" rx="3" fill={tone.accent} />
              {state === 'idle' && <rect className="rs-pos-caret" x="272" y="84" width="1.5" height="6" fill={tone.accent} />}
            </g>

            {/* stand */}
            <path d="M206 146h16v10h-16z" fill="#1e293b" />
            <rect x="192" y="156" width="44" height="5" rx="2.5" fill="#334155" />
          </g>

          {/* ----------------------------------------------------- printer */}
          <g>
            {/* paper, feeding down out of the slot */}
            <g className={working ? 'rs-paper-feed' : settled ? 'rs-paper-done' : undefined} opacity={state === 'idle' ? 0.35 : 1}>
              <path d="M292 104h40v62l-5 5-5-5-5 5-5-5-5 5-5-5-5 5-5-5z" fill="url(#rs-paper)" />
              <rect x="298" y="112" width="28" height="3" rx="1.5" fill="#94a3b8" />
              <rect x="298" y="120" width="20" height="2.5" rx="1.25" fill="#cbd5e1" />
              <rect x="298" y="127" width="24" height="2.5" rx="1.25" fill="#cbd5e1" />
              <rect x="298" y="134" width="16" height="2.5" rx="1.25" fill="#cbd5e1" />
              <rect x="298" y="144" width="28" height="4" rx="2" fill={settled ? tone.accent : '#64748b'} />
            </g>

            {/* body */}
            <rect x="286" y="80" width="52" height="30" rx="7" fill="#1e293b" stroke="rgba(255,255,255,.1)" />
            <rect x="292" y="100" width="40" height="4" rx="2" fill="#0f172a" />
            <circle cx="296" cy="88" r="2.5" fill={tone.accent}>
              {working && <animate attributeName="opacity" values="1;.25;1" dur="0.9s" repeatCount="indefinite" />}
            </circle>
          </g>

          {/* ------------------------------------------------------ counter */}
          <rect x="16" y="196" width="310" height="8" rx="4" fill="#1e293b" />
          <rect x="120" y="186" width="56" height="10" rx="3" fill="#334155" />
          <rect x="16" y="204" width="310" height="3" rx="1.5" fill="rgba(255,255,255,.06)" />
        </svg>

        {/* the verdict, once the server has answered */}
        {settled && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span aria-hidden className="rs-pos-burst absolute h-20 w-20 rounded-full" style={{ background: tone.glow }} />
            <span
              className="rs-pos-pop relative flex h-16 w-16 items-center justify-center rounded-full backdrop-blur-sm"
              style={{ background: state === 'success' ? 'rgba(52,211,153,0.18)' : 'rgba(248,113,113,0.18)' }}
            >
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" aria-hidden>
                {state === 'success' ? (
                  <path d="m6 12.4 4 4 8-8.8" stroke={tone.accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="rs-check-draw" />
                ) : (
                  <path d="M7 7l10 10M17 7 7 17" stroke={tone.accent} strokeWidth="2.4" strokeLinecap="round" className="rs-check-draw" />
                )}
              </svg>
            </span>
          </div>
        )}
      </div>

      {/*
        One live region for the whole visual. Screen readers hear the state
        change; the form owns the real error text, so this stays generic.
      */}
      <p role="status" aria-live="polite" className="mt-5 text-center text-[0.8125rem] font-medium text-slate-400">
        {tone.label}
      </p>
    </div>
  );
}
