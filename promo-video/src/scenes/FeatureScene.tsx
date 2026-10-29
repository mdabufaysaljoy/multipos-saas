import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { Icon } from "../ui/Icon";
import { coreFeatures, growthFeatures } from "../data";

export type FeatureItem = {
  bn: string;
  en: string;
  icon: string;
  accent: string;
};

/**
 * One 3x2 feature grid, used twice: once for the counter capabilities every
 * plan includes, once for the growth capabilities a paid tier unlocks. The two
 * scenes differ only in props, so the rhythm of the reveal stays identical.
 */
export const FeatureScene: React.FC<{
  eyebrow: string;
  headline: string;
  accent: string;
  items: FeatureItem[];
}> = ({ eyebrow, headline, accent, items }) => {
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
          bottom: safe.y - 30,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 28,
        }}
      >
        {items.map((item, index) => (
          <Interactive.Div
            key={item.en}
            name={item.en}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 26,
              padding: "32px 30px",
              borderRadius: 26,
              backgroundColor: colors.surface,
              border: `1px solid ${colors.border}`,
              opacity: interpolate(frame, [30 + index * 11, 52 + index * 11], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              translate: interpolate(
                frame,
                [30 + index * 11, 56 + index * 11],
                ["-34px 0px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.spring({ damping: 22 }),
                },
              ),
            }}
          >
            <Interactive.Div
              name="IconTile"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 86,
                height: 86,
                flexShrink: 0,
                borderRadius: 22,
                backgroundColor: `${item.accent}24`,
                color: item.accent,
                scale: interpolate(
                  frame,
                  [34 + index * 11, 60 + index * 11],
                  [0.6, 1],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: Easing.spring({ damping: 15 }),
                    output: "perceptual-scale",
                  },
                ),
              }}
            >
              <Icon name={item.icon} size={46} />
            </Interactive.Div>
            <Interactive.Div
              name="Label"
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <Interactive.Div
                name="Bangla"
                style={{
                  fontFamily: fonts.body,
                  fontSize: 40,
                  fontWeight: 600,
                  color: colors.text,
                  lineHeight: 1.3,
                }}
              >
                {item.bn}
              </Interactive.Div>
              <Interactive.Div
                name="English"
                style={{
                  fontFamily: fonts.latin,
                  fontSize: 26,
                  fontWeight: 500,
                  letterSpacing: 1.4,
                  color: colors.muted,
                }}
              >
                {item.en}
              </Interactive.Div>
            </Interactive.Div>
          </Interactive.Div>
        ))}
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
};

export const growthFeatureProps = {
  eyebrow: "Grow with Professional",
  headline: "ব্যবসা বড় করার টুলস",
  accent: colors.violet,
  items: growthFeatures as FeatureItem[],
};
