import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts } from "../theme";

/**
 * Six and a half seconds to do two jobs: name the problem in one Bangla line,
 * then put the brand on screen. The hook leaves before the logo arrives so the
 * viewer only ever reads one thing at a time.
 */
export const OpeningScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="OpeningScene">
      <Backdrop />

      <Interactive.Div
        name="Hook"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: fonts.display,
          fontSize: 104,
          fontWeight: 700,
          color: colors.text,
          textAlign: "center",
          opacity: interpolate(frame, [4, 20, 44, 58], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [4, 58], ["0px 18px", "0px -22px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        দোকানের হিসাব এখনও খাতায়?
      </Interactive.Div>

      <Interactive.Div
        name="Brand"
        from={52}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 30,
        }}
      >
        <Interactive.Div
          name="Logomark"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 132,
            height: 132,
            borderRadius: 34,
            background: `linear-gradient(135deg, ${colors.indigo}, ${colors.violet})`,
            boxShadow: `0 40px 120px ${colors.indigo}59`,
            fontFamily: fonts.latin,
            fontSize: 66,
            fontWeight: 800,
            color: colors.text,
            scale: interpolate(frame, [52, 82], [0.4, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 14 }),
              output: "perceptual-scale",
            }),
            rotate: interpolate(frame, [52, 86], ["-14deg", "0deg"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 16 }),
            }),
          }}
        >
          RS
        </Interactive.Div>

        <Interactive.Div
          name="Wordmark"
          style={{
            fontFamily: fonts.latin,
            fontSize: 118,
            fontWeight: 800,
            letterSpacing: -3,
            color: colors.text,
            opacity: interpolate(frame, [70, 90], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [70, 94], ["0px 24px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Retailer Suites
        </Interactive.Div>

        <Interactive.Div
          name="Tagline"
          style={{
            fontFamily: fonts.body,
            fontSize: 52,
            fontWeight: 500,
            color: colors.muted,
            opacity: interpolate(frame, [92, 112], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          এক প্ল্যাটফর্মে আপনার পুরো ব্যবসা
        </Interactive.Div>

        <Interactive.Div
          name="Underline"
          style={{
            width: interpolate(frame, [100, 140], [0, 560], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            height: 4,
            borderRadius: 4,
            background: `linear-gradient(90deg, ${colors.cyan}, ${colors.violet})`,
          }}
        />
      </Interactive.Div>
    </AbsoluteFill>
  );
};
