import { loadFont as loadBangla } from "@remotion/google-fonts/HindSiliguri";
import { loadFont as loadDisplay } from "@remotion/google-fonts/AnekBangla";
import { loadFont as loadLatin } from "@remotion/google-fonts/Inter";

/**
 * Bangla is the primary language of the video, so the Bangla faces are loaded
 * with both the `bengali` and `latin` subsets: a single text run mixes Bangla
 * words with English product names ("Super Shop POS") and digits, and a
 * Bangla-only subset would fall back to a system face mid-sentence.
 */
const bangla = loadBangla("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["bengali", "latin"],
});

const display = loadDisplay("normal", {
  weights: ["500", "600", "700", "800"],
  subsets: ["bengali", "latin"],
});

const latin = loadLatin("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});

export const fonts = {
  /** Headlines and numbers — tighter, more editorial. */
  display: `${display.fontFamily}, ${latin.fontFamily}, sans-serif`,
  /** Body copy and labels — high legibility at small sizes. */
  body: `${bangla.fontFamily}, ${latin.fontFamily}, sans-serif`,
  /** Latin-only runs: prices, plan names, the domain. */
  latin: `${latin.fontFamily}, sans-serif`,
};

export const colors = {
  bg: "#070B18",
  bgSoft: "#0D1328",
  surface: "rgba(255, 255, 255, 0.045)",
  border: "rgba(148, 163, 184, 0.22)",
  text: "#F8FAFC",
  muted: "#94A3B8",
  indigo: "#6366F1",
  violet: "#A855F7",
  cyan: "#22D3EE",
  emerald: "#34D399",
  amber: "#FBBF24",
};

/** Safe area for a 1920x1080 frame (scaled from the 1080-wide guidance). */
export const safe = { x: 142, y: 178 };
