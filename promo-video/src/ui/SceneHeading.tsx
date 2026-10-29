import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, fonts, safe } from "../theme";

/**
 * The eyebrow + headline pair every mid-roll scene opens with. Keeping it in
 * one component is what makes the four feature scenes cut together: the text
 * lands in the same place at the same speed each time.
 */
export const SceneHeading: React.FC<{
  eyebrow: string;
  headline: string;
  accent?: string;
}> = ({ eyebrow, headline, accent = colors.cyan }) => {
  const frame = useCurrentFrame();

  return (
    <Interactive.Div
      name="SceneHeading"
      style={{
        position: "absolute",
        left: safe.x,
        top: safe.y - 68,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <Interactive.Div
        name="Eyebrow"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontFamily: fonts.latin,
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: 4,
          textTransform: "uppercase",
          color: accent,
          opacity: interpolate(frame, [0, 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <span
          style={{
            width: interpolate(frame, [2, 22], [0, 56], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            height: 3,
            borderRadius: 3,
            backgroundColor: accent,
          }}
        />
        {eyebrow}
      </Interactive.Div>
      <Interactive.Div
        name="Headline"
        style={{
          fontFamily: fonts.display,
          fontSize: 96,
          fontWeight: 700,
          lineHeight: 1.18,
          color: colors.text,
          opacity: interpolate(frame, [4, 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [4, 24], ["0px 26px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {headline}
      </Interactive.Div>
    </Interactive.Div>
  );
};
