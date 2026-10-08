import { cn } from '@/lib/utils';

/**
 * The authentication scene.
 *
 * A security officer at a verification desk: she raises a handheld scanner at a
 * holographic identity panel, the beam sweeps it, and the panel answers. It
 * takes ONE prop - which state to show - and knows nothing about credentials,
 * the auth API, or what went wrong. The page drives it from the REAL request,
 * so the beam only completes and the tick is only drawn after the server has
 * actually said yes. Nothing here is on a timer that could decide an outcome.
 *
 * Built as layers - character, scanner, beam, holographic panel, particles -
 * so a state change restyles the composition instead of replacing it, and the
 * SAME officer is on screen throughout.
 *
 * Drawn as inline SVG animated by keyframes in `index.css` rather than played
 * from a Lottie file: the app ships no animation runtime at all, the scene is
 * this product's own rather than a stock illustration, and this way it themes
 * with the site, scales cleanly and costs no request.
 */
export type SceneState = 'idle' | 'scanning' | 'success' | 'error' | 'recovery';

interface Tone {
  /** Drives every glow, border and indicator in the composition. */
  accent: string;
  glow: string;
  /** The heading on the holographic panel. */
  title: string;
  /** What a screen reader hears, and the caption under the scene. */
  label: string;
}

const TONE: Record<SceneState, Tone> = {
  idle: { accent: '#60a5fa', glow: 'rgba(59,130,246,0.30)', title: 'SECURE ACCESS', label: 'Ready to verify your identity' },
  scanning: { accent: '#22d3ee', glow: 'rgba(34,211,238,0.45)', title: 'VERIFYING IDENTITY', label: 'Checking your details' },
  success: { accent: '#34d399', glow: 'rgba(52,211,153,0.50)', title: 'ACCESS APPROVED', label: 'Verified — signing you in' },
  error: { accent: '#fb7185', glow: 'rgba(251,113,133,0.45)', title: 'VERIFICATION FAILED', label: 'Could not verify those details' },
  recovery: { accent: '#818cf8', glow: 'rgba(129,140,248,0.38)', title: 'PASSWORD RECOVERY', label: 'Helping you back into your account' },
};

/**
 * The officer's expression, as the two features that carry it.
 *
 * Everything else about her - face, hair, uniform, proportions, scanner - is
 * drawn once and never swapped, so she stays one person across every state.
 */
const FACE: Record<SceneState, { brow: string; mouth: string }> = {
  idle: { brow: 'M112 106.5h14M130 106.5h14', mouth: 'M121 129q7 4 14 0' },
  scanning: { brow: 'M112 105h14M130 105h14', mouth: 'M122 130h12' },
  success: { brow: 'M112 107q7-3 14 0M130 107q7-3 14 0', mouth: 'M119 128q9 7 18 0' },
  // Inner ends lifted and a small downturn: concerned, never cross.
  error: { brow: 'M112 108l14-4M144 108l-14-4', mouth: 'M121 131.5q7-4 14 0' },
  recovery: { brow: 'M112 107l14-2M144 107l-14-2', mouth: 'M121 129.5q7 3 14 0' },
};

/** How far the scanner arm is raised. Resting low, level when it is working. */
const ARM_ANGLE: Record<SceneState, number> = { idle: 9, scanning: -5, success: 3, error: 15, recovery: 19 };

/** The checklist the panel works through while the real request is in flight. */
const STEPS = ['Identity detected', 'Checking credentials', 'Verifying access'];

export function AuthScene({ state = 'idle', className }: { state?: SceneState; className?: string }) {
  const tone = TONE[state];
  const face = FACE[state];
  const working = state === 'scanning';
  const settled = state === 'success' || state === 'error';

  return (
    <div className={cn('relative select-none', className)}>
      {/* the light the desk throws */}
      <div
        aria-hidden
        // Tighter on a phone: at 375px a 2.5rem bleed pushes the page sideways.
        className="absolute -inset-5 rounded-[4rem] blur-3xl transition-all duration-700 sm:-inset-10"
        style={{ background: `radial-gradient(55% 55% at 50% 48%, ${tone.glow}, transparent 70%)` }}
      />

      <div className={cn('relative transition-transform duration-500', state === 'error' && 'rs-auth-shake')}>
        <svg viewBox="0 0 420 300" className="w-full" role="img" aria-label={tone.label}>
          <defs>
            <linearGradient id="rs-skin" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f6d5bd" />
              <stop offset="1" stopColor="#e3b593" />
            </linearGradient>
            <linearGradient id="rs-hair" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3b3550" />
              <stop offset="1" stopColor="#1b1830" />
            </linearGradient>
            <linearGradient id="rs-suit" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#1e2642" />
              <stop offset="1" stopColor="#0d1326" />
            </linearGradient>
            <linearGradient id="rs-panel" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={tone.accent} stopOpacity="0.16" />
              <stop offset="1" stopColor={tone.accent} stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id="rs-beam" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={tone.accent} stopOpacity="0.85" />
              <stop offset="1" stopColor={tone.accent} stopOpacity="0" />
            </linearGradient>
            {/* The rim light along her near edge, which gives the 2.5D depth. */}
            <linearGradient id="rs-rim" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={tone.accent} stopOpacity="0" />
              <stop offset="1" stopColor={tone.accent} stopOpacity="0.55" />
            </linearGradient>
            <clipPath id="rs-panel-clip">
              <rect x="240" y="50" width="150" height="172" rx="12" />
            </clipPath>
          </defs>

          {/* ---------------------------------------------- floor and depth */}
          <g aria-hidden opacity="0.55">
            <ellipse cx="206" cy="270" rx="152" ry="15" fill={tone.accent} opacity="0.12" />
            {[0, 1, 2].map((i) => (
              <line key={i} x1={66 + i * 22} y1="270" x2={14 + i * 54} y2="298" stroke={tone.accent} strokeWidth="0.6" opacity="0.16" />
            ))}
          </g>

          {/* ------------------------------------------ holographic identity */}
          <g className="rs-auth-hud">
            <rect x="240" y="50" width="150" height="172" rx="12" fill="url(#rs-panel)" stroke={tone.accent} strokeOpacity="0.45" />
            {/* corner brackets */}
            {[
              'M246 68v-8a6 6 0 0 1 6-6h8',
              'M384 68v-8a6 6 0 0 0-6-6h-8',
              'M246 204v8a6 6 0 0 0 6 6h8',
              'M384 204v8a6 6 0 0 1-6 6h-8',
            ].map((d, i) => (
              <path key={i} d={d} fill="none" stroke={tone.accent} strokeWidth="1.4" strokeOpacity="0.8" />
            ))}

            <g clipPath="url(#rs-panel-clip)">
              {/* the identity being checked: a silhouette, never a real person */}
              <g opacity={settled ? 0.22 : 0.62} className="transition-opacity duration-500">
                <circle cx="315" cy="110" r="22" fill="none" stroke={tone.accent} strokeWidth="1.6" />
                <circle cx="315" cy="103" r="8" fill={tone.accent} opacity="0.55" />
                <path d="M302 124a13 13 0 0 1 26 0z" fill={tone.accent} opacity="0.55" />
              </g>

              {/* the beam's own sweep across the identity */}
              {working && <rect className="rs-auth-sweep" x="240" y="50" width="150" height="26" fill={tone.accent} opacity="0.18" />}

              {/* state heading */}
              <text x="315" y="158" textAnchor="middle" fill={tone.accent} fontSize="10" fontWeight="700" letterSpacing="1.5">
                {tone.title}
              </text>

              {/* what it is working through, while the REAL request is pending */}
              {working &&
                STEPS.map((step, index) => (
                  <g key={step} className="rs-auth-step" style={{ animationDelay: `${index * 420}ms` }}>
                    <circle cx="256" cy={174 + index * 15} r="2.6" fill={tone.accent} />
                    <text x="265" y={177 + index * 15} fill="#cbd5e1" fontSize="8">
                      {step}
                    </text>
                  </g>
                ))}

              {/* idle and recovery read as a calm status panel, not a progress bar */}
              {!working && !settled && (
                <g opacity="0.75">
                  {(state === 'recovery'
                    ? ['Recovery code by email', 'Link expires shortly', 'Your account stays safe']
                    : ['Identity', 'Security status', 'Encrypted session']
                  ).map((row, index) => (
                    <g key={row}>
                      <circle cx="256" cy={174 + index * 15} r="2.6" fill={tone.accent} opacity="0.7" />
                      <text x="265" y={177 + index * 15} fill="#94a3b8" fontSize="8">
                        {row}
                      </text>
                    </g>
                  ))}
                </g>
              )}

              {/* the verdict, only once the server has answered */}
              {settled && (
                <g className="rs-auth-pop">
                  <circle cx="315" cy="110" r="27" fill={tone.accent} opacity="0.14" />
                  <circle cx="315" cy="110" r="27" fill="none" stroke={tone.accent} strokeWidth="1.8" />
                  <path
                    d={state === 'success' ? 'M304 110.5l8 8 15-16' : 'M306 101l18 18M324 101l-18 18'}
                    fill="none"
                    stroke={tone.accent}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="rs-auth-draw"
                  />
                </g>
              )}

              {/* a quiet scan line, so the panel always feels alive */}
              <rect className="rs-auth-scanline" x="240" y="50" width="150" height="1.5" fill={tone.accent} opacity="0.3" />
            </g>
          </g>

          {/* ------------------------------------------------- the scan beam */}
          {working && (
            <g className="rs-auth-beam" aria-hidden>
              <path d="M224 199 L292 96 L298 134 Z" fill="url(#rs-beam)" />
              <line x1="224" y1="199" x2="294" y2="106" stroke={tone.accent} strokeWidth="1.3" strokeOpacity="0.9" />
            </g>
          )}

          {/* --------------------------------------------------- the officer */}
          <g className="rs-auth-breathe">
            {/* far arm, and the gesture it makes once there is news */}
            <g>
              <path d="M103 186c-9 11-13 27-11 42" stroke="#1a2139" strokeWidth="13" strokeLinecap="round" fill="none" />
              {state === 'success' && (
                <g className="rs-auth-gesture">
                  <circle cx="89" cy="232" r="7.5" fill="url(#rs-skin)" />
                  <rect x="86" y="218" width="5" height="11" rx="2.5" fill="url(#rs-skin)" />
                </g>
              )}
              {state === 'recovery' && (
                <g className="rs-auth-gesture">
                  <ellipse cx="91" cy="234" rx="9.5" ry="6.5" fill="url(#rs-skin)" transform="rotate(-20 91 234)" />
                </g>
              )}
            </g>

            {/* neck, drawn behind the head so the chin overlaps it */}
            <path d="M122 134h12v38h-12z" fill="#b07f60" />

            {/* torso: a real shoulder line, rather than a cone from the collar */}
            <path d="M94 268l5-66q3-30 20-36h18q17 6 20 36l5 66z" fill="url(#rs-suit)" />
            {/* uniform collar, seam and shoulder flashes */}
            {/* collar, opening over the neck */}
            <path d="M116 170l12 16 12-16" fill="none" stroke={tone.accent} strokeWidth="1.8" strokeOpacity="0.8" strokeLinecap="round" />
            <path d="M128 188v74" stroke={tone.accent} strokeWidth="0.9" strokeOpacity="0.26" />
            <path d="M152 200l5 6-2 9" fill="none" stroke={tone.accent} strokeWidth="1.3" strokeOpacity="0.5" />
            <path d="M104 200l-5 6 2 9" fill="none" stroke={tone.accent} strokeWidth="1.3" strokeOpacity="0.5" />
            {/* shoulder badge */}
            <path d="M147 204l8 3v6c0 4-3.5 6.5-8 8-4.5-1.5-8-4-8-8v-6z" fill={tone.accent} opacity="0.22" stroke={tone.accent} strokeOpacity="0.6" strokeWidth="1" />
            {/* near-edge rim light, which gives the 2.5D depth */}
            <path d="M162 268l-5-66q-3-30-20-36" fill="none" stroke="url(#rs-rim)" strokeWidth="2.6" />

            {/* hair behind the head, and the ponytail */}
            <path d="M103 114a25 25 0 0 1 50 0v24c0 5-4 6-6 3V110h-38v31c-2 3-6 2-6-3z" fill="url(#rs-hair)" />
            <path className="rs-auth-tail" d="M148 104c14 6 18 24 14 38-2 8-8 12-12 10 6-14 6-34-2-48z" fill="url(#rs-hair)" />

            {/* face */}
            <path d="M105 112a23 23 0 0 1 46 0v10a23 23 0 0 1-46 0z" fill="url(#rs-skin)" />
            {/* hair over the crown only: the hairline sits well above the brows */}
            <path d="M105 112a23 23 0 0 1 46 0v-5q-23-17-46 0z" fill="url(#rs-hair)" />
            {/* locks framing the face */}
            <path d="M105 107v29q4 6 7 0v-29z" fill="url(#rs-hair)" />
            <path d="M151 107v29q-4 6-7 0v-29z" fill="url(#rs-hair)" />

            {/* eyes, which blink */}
            <g className="rs-auth-blink">
              <ellipse cx="119" cy="114" rx="3.4" ry="4" fill="#20283f" />
              <ellipse cx="137" cy="114" rx="3.4" ry="4" fill="#20283f" />
              <circle cx="120.2" cy="112.8" r="1.1" fill="#fff" opacity="0.9" />
              <circle cx="138.2" cy="112.8" r="1.1" fill="#fff" opacity="0.9" />
            </g>
            <path d="M126 120q-2 6 2 6" fill="none" stroke="#c79274" strokeWidth="1.4" strokeLinecap="round" />
            {/* brows and mouth: the only parts an expression changes */}
            <path d={face.brow} stroke="#2a2340" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            <path d={face.mouth} stroke="#9c5f52" strokeWidth="2" strokeLinecap="round" fill="none" />

            {/* earpiece, lit in the state colour */}
            <circle cx="108" cy="121" r="3.6" fill="#1a2139" />
            <circle cx="108" cy="121" r="1.5" fill={tone.accent}>
              {working && <animate attributeName="opacity" values="1;.2;1" dur="0.9s" repeatCount="indefinite" />}
            </circle>

            {/* ------------------------------- near arm, holding the scanner */}
            <g style={{ transform: `rotate(${ARM_ANGLE[state]}deg)`, transformOrigin: '150px 196px' }} className="rs-auth-arm">
              <path d="M150 196c13 3 22 9 28 17" stroke="#1a2139" strokeWidth="12.5" strokeLinecap="round" fill="none" />

              {/* the scanner: a handheld unit, grip below, emitter forward */}
              <g>
                <path d="M182 208h11v13a5.5 5.5 0 0 1-11 0z" fill="#121a2e" stroke={tone.accent} strokeOpacity="0.35" />
                <path d="M176 192h38a5 5 0 0 1 5 5v11h-43z" fill="#1a2139" stroke={tone.accent} strokeOpacity="0.5" />
                <rect x="180" y="196" width="13" height="4" rx="2" fill={tone.accent} opacity="0.35" />
                {/* the hand, over the grip */}
                <circle cx="188" cy="211" r="6.6" fill="url(#rs-skin)" />
                {/* emitter window */}
                <rect x="214" y="196" width="10" height="7" rx="2" fill={tone.accent} opacity={state === 'recovery' ? 0.25 : 0.9} />
                {/* muzzle lamp: bright while working, a soft indicator otherwise */}
                <circle cx="226" cy="199.5" r={working ? 4 : 2.6} fill={tone.accent} opacity={state === 'recovery' ? 0.3 : 1}>
                  {working && <animate attributeName="r" values="3;4.6;3" dur="0.85s" repeatCount="indefinite" />}
                </circle>
                {(state === 'success' || state === 'error') && (
                  <circle cx="226" cy="199.5" r="9" fill={tone.accent} opacity="0.25" className="rs-auth-pop" />
                )}
              </g>
            </g>
          </g>

          {/* ----------------------------------------------------- particles */}
          <g aria-hidden>
            {[
              { x: 232, y: 78, d: 0 },
              { x: 400, y: 128, d: 900 },
              { x: 226, y: 232, d: 1800 },
              { x: 378, y: 246, d: 2600 },
            ].map((p) => (
              <circle key={`${p.x}-${p.y}`} className="rs-auth-mote" style={{ animationDelay: `${p.d}ms` }} cx={p.x} cy={p.y} r="1.6" fill={tone.accent} />
            ))}
          </g>
        </svg>
      </div>

      {/*
        One live region for the whole visual. Screen readers hear the state
        change; the form owns the real error text, so this stays generic and
        never repeats what went wrong.
      */}
      <p role="status" aria-live="polite" className="mt-5 text-center text-[0.8125rem] font-medium text-slate-400">
        {tone.label}
      </p>
    </div>
  );
}
