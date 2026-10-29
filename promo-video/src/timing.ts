/**
 * The film's clock, derived from the voice-over — not chosen by eye.
 *
 * `voiceover/take.srt` is the subtitle file ElevenLabs returned with the Bangla
 * take committed at `public/voiceover/promo-full.mp3`. Its cues are machine
 * chunks that run across sentence boundaries, so they are not usable as scene
 * marks directly; the marks below are the moment each *claim* is spoken,
 * located inside its cue by where the words fall in it.
 *
 * Everything on screen is positioned against these numbers, which is the whole
 * point: a card appears while its line is being read, not a beat before or
 * after. The take is used at its recorded speed — no `atempo` fitting — so the
 * numbers here are the numbers in the file, and the film is as long as the read
 * (71.55s of audio, 2150 frames of picture, leaving the last word a third of a
 * second of air before the cut).
 *
 * If the take is re-recorded, re-derive `AT` from the new .srt and nothing else
 * has to be touched: every scene reads its cues from here.
 */

export const FPS = 30;

/** Cross-fade between scenes, in frames. */
export const TRANSITION = 15;

/** Seconds → frames on the film's timeline. */
export const f = (seconds: number) => Math.round(seconds * FPS);

/**
 * When each line is spoken, in seconds into the take.
 * Grouped by the scene that carries it.
 */
export const AT = {
  /** 1 — "দোকানের হিসাব এখনো খাতা কলমে?" / "Retailer Suites, এক platform…" */
  hook: 0.22,
  hookOut: 2.9,
  brand: 3.28,
  wordmark: 3.95,
  tagline: 4.53,

  /** 2 — "আপনার ব্যবসার ধরন অনুযায়ী POS, fashion, super shop, restaurant আর pharmacy, একটাই account।" */
  verticalsHeading: 6.87,
  clothing: 9.22,
  supershop: 9.95,
  restaurant: 10.7,
  pharmacy: 11.5,
  oneAccount: 12.3,

  /** 3 — "counter যা যা দরকার সবই আছে।" … through bulk import */
  coreHeading: 13.04,
  billing: 15.0,
  printing: 17.0,
  split: 19.72,
  ledger: 22.6,
  returns: 25.14,
  importing: 27.7,

  /** 4 — "ব্যবসা বড় হলে…" through "…report print বা export।" */
  growthHeading: 30.52,
  branches: 31.6,
  roles: 33.9,
  loyalty: 36.2,
  marketing: 38.8,
  analytics: 40.9,
  exporting: 42.3,

  /** 5 — "pricing একদম স্পষ্ট।" through "…দুই মাস একদম free।" */
  pricingHeading: 44.6,
  starter: 46.3,
  professional: 50.3,
  enterprise: 56.88,
  annual: 61.2,

  /** 6 — "শুরু করুন সাত দিনের free trial দিয়ে…" through the domain. */
  trial: 63.6,
  decide: 66.3,
  cta: 68.6,
  domain: 70.0,
  signature: 70.8,
} as const;

/** The six cuts, placed on the first mark of the scene that follows. */
const CUTS = [
  0,
  AT.verticalsHeading - 0.27,
  AT.coreHeading,
  AT.growthHeading,
  AT.pricingHeading,
  AT.trial,
];

/** Total picture length: the read plus a third of a second of air. */
export const TOTAL = 2150;

const cutFrames = CUTS.map(f);

/** Frame each scene becomes visible on. */
export const START = {
  opening: cutFrames[0],
  verticals: cutFrames[1],
  core: cutFrames[2],
  growth: cutFrames[3],
  pricing: cutFrames[4],
  cta: cutFrames[5],
} as const;

/**
 * Visible length of each scene. A `TransitionSeries.Sequence` must also cover
 * the cross-fade that follows it, so `durations` adds `TRANSITION` to every
 * scene but the last; the overlaps hand those frames back and the six add up to
 * `TOTAL` again.
 */
export const LENGTH = {
  opening: cutFrames[1] - cutFrames[0],
  verticals: cutFrames[2] - cutFrames[1],
  core: cutFrames[3] - cutFrames[2],
  growth: cutFrames[4] - cutFrames[3],
  pricing: cutFrames[5] - cutFrames[4],
  cta: TOTAL - cutFrames[5],
} as const;

export const durations = {
  opening: LENGTH.opening + TRANSITION,
  verticals: LENGTH.verticals + TRANSITION,
  core: LENGTH.core + TRANSITION,
  growth: LENGTH.growth + TRANSITION,
  pricing: LENGTH.pricing + TRANSITION,
  cta: LENGTH.cta,
} as const;

/** A mark as a frame offset inside the scene that owns it. */
const rel = (at: number, start: number) => f(at) - start;

export const cues = {
  opening: {
    hook: rel(AT.hook, START.opening),
    hookOut: rel(AT.hookOut, START.opening),
    brand: rel(AT.brand, START.opening),
    wordmark: rel(AT.wordmark, START.opening),
    tagline: rel(AT.tagline, START.opening),
  },
  verticals: {
    heading: rel(AT.verticalsHeading, START.verticals),
    cards: [AT.clothing, AT.supershop, AT.restaurant, AT.pharmacy].map((at) =>
      rel(at, START.verticals),
    ),
    oneAccount: rel(AT.oneAccount, START.verticals),
  },
  core: {
    heading: rel(AT.coreHeading, START.core),
    items: [AT.billing, AT.printing, AT.split, AT.ledger, AT.returns, AT.importing].map(
      (at) => rel(at, START.core),
    ),
  },
  growth: {
    heading: rel(AT.growthHeading, START.growth),
    items: [
      AT.branches,
      AT.roles,
      AT.loyalty,
      AT.marketing,
      AT.analytics,
      AT.exporting,
    ].map((at) => rel(at, START.growth)),
  },
  pricing: {
    heading: rel(AT.pricingHeading, START.pricing),
    plans: [AT.starter, AT.professional, AT.enterprise].map((at) =>
      rel(at, START.pricing),
    ),
    annual: rel(AT.annual, START.pricing),
  },
  cta: {
    trial: rel(AT.trial, START.cta),
    decide: rel(AT.decide, START.cta),
    button: rel(AT.cta, START.cta),
    domain: rel(AT.domain, START.cta),
    signature: rel(AT.signature, START.cta),
  },
} as const;

/** What the rail at the foot of the frame calls each scene. */
export const chapters = [
  { label: "Retailer Suites", start: START.opening },
  { label: "Four POS, one account", start: START.verticals },
  { label: "At the counter", start: START.core },
  { label: "Growing the business", start: START.growth },
  { label: "Pricing", start: START.pricing },
  { label: "7-day free trial", start: START.cta },
] as const;
