import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { Icon } from "../ui/Icon";
import { coreFeatures, growthFeatures } from "../data";
import { cues } from "../timing";

const ease = Easing.bezier(0.16, 1, 0.3, 1);

export type FeatureItem = {
  bn: string;
  en: string;
  detail: string;
  icon: string;
  accent: string;
};

/**
 * One 3x2 feature grid, used twice: once for the counter capabilities every
 * plan includes, once for the growth capabilities a paid tier unlocks.
 *
 * Two things make it read as a film rather than a slide. Each card arrives on
 * the words that name it — `cues` carries one frame per feature, taken from the
 * voice-over's subtitle file — and the card being spoken about is lit: its
 * border takes the accent and the rest of the grid sits back at 55% while it
 * holds the floor. The viewer's eye is therefore always on the thing being
 * said, in a grid of six.
 *
 * The third line on each card is the rule the server enforces, which is what
 * keeps the film honest at the level a shopkeeper can check.
 */
export const FeatureScene: React.FC<{
  eyebrow: string;
  headline: string;
  accent: string;
  items: FeatureItem[];
  at: readonly number[];
}> = ({ eyebrow, headline, accent, items, at }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="FeatureScene">
      <Backdrop hueShift={80} />
      <SceneHeading eyebrow={eyebrow} headline={headline} accent={accent} />

      <Interactive.Div
        name="FeatureGrid"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          top: 342,
          bottom: 104,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gridTemplateRows: "repeat(2, 1fr)",
          gap: 26,
        }}
      >
        {items.map((item, index) => {
          const enter = at[index];
          const spokenUntil = at[index + 1] ?? enter + 90;
          // Lit while its line is being read, then handed over to the next one.
          const live = interpolate(
            frame,
            [enter, enter + 12, spokenUntil - 6, spokenUntil + 10],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          );
          const arrived = interpolate(frame, [enter, enter + 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          });

          return (
            <Interactive.Div
              key={item.en}
              name={item.en}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                padding: "30px 28px",
                borderRadius: 26,
                backgroundColor: `rgba(255, 255, 255, ${0.03 + live * 0.045})`,
                border: `1px solid ${live > 0.5 ? `${item.accent}99` : colors.border}`,
                boxShadow: live > 0.5 ? `0 28px 80px ${item.accent}26` : "none",
                opacity: arrived * (0.62 + live * 0.38),
                translate: interpolate(
                  frame,
                  [enter, enter + 26],
                  ["-34px 0px", "0px 0px"],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: Easing.spring({ damping: 22 }),
                  },
                ),
                scale: interpolate(live, [0, 1], [0.985, 1], {
                  output: "perceptual-scale",
                }),
              }}
            >
              <Interactive.Div
                name="IconTile"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 82,
                  height: 82,
                  flexShrink: 0,
                  borderRadius: 22,
                  backgroundColor: `${item.accent}${live > 0.5 ? "33" : "1F"}`,
                  color: item.accent,
                  scale: interpolate(frame, [enter + 4, enter + 30], [0.6, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: Easing.spring({ damping: 15 }),
                    output: "perceptual-scale",
                  }),
                }}
              >
                <Icon name={item.icon} size={44} />
              </Interactive.Div>

              <Interactive.Div
                name="Label"
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                <Interactive.Div
                  name="Bangla"
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 37,
                    fontWeight: 600,
                    color: colors.text,
                    lineHeight: 1.26,
                  }}
                >
                  {item.bn}
                </Interactive.Div>
                <Interactive.Div
                  name="English"
                  style={{
                    fontFamily: fonts.latin,
                    fontSize: 23,
                    fontWeight: 600,
                    letterSpacing: 1.6,
                    textTransform: "uppercase",
                    color: item.accent,
                  }}
                >
                  {item.en}
                </Interactive.Div>
                <Interactive.Div
                  name="Detail"
                  style={{
                    marginTop: 4,
                    fontFamily: fonts.body,
                    fontSize: 25,
                    fontWeight: 500,
                    lineHeight: 1.34,
                    color: colors.muted,
                    opacity: interpolate(frame, [enter + 10, enter + 28], [0, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                      easing: ease,
                    }),
                  }}
                >
                  {item.detail}
                </Interactive.Div>
              </Interactive.Div>
            </Interactive.Div>
          );
        })}
      </Interactive.Div>
    </AbsoluteFill>
  );
};

/** Props as used in the main video, shared with the standalone registrations. */
export const coreFeatureProps = {
  eyebrow: "Every plan includes",
  headline: "কাউন্টারে যা যা দরকার, সবই আছে",
  accent: colors.indigo,
  items: coreFeatures as FeatureItem[],
  at: cues.core.items,
};

export const growthFeatureProps = {
  eyebrow: "Grow with Professional",
  headline: "ব্যবসা বড় করার টুলস",
  accent: colors.violet,
  items: growthFeatures as FeatureItem[],
  at: cues.growth.items,
};
