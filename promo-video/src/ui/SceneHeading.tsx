import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, fonts, safe } from "../theme";

const ease = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * The eyebrow + headline pair every mid-roll scene opens with. Keeping it in
 * one component is what makes the four feature scenes cut together: the text
 * lands in the same place at the same speed each time.
 *
 * `from` is the frame the headline is spoken on, which is usually the scene's
 * own first frame but not always — the verticals scene starts a beat before its
 * line, so the cards have somewhere to land.
 */
export const SceneHeading: React.FC<{
  eyebrow: string;
  headline: string;
  accent?: string;
  from?: number;
}> = ({ eyebrow, headline, accent = colors.cyan, from = 0 }) => {
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
          opacity: interpolate(frame, [from, from + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          }),
        }}
      >
        <span
          style={{
            width: interpolate(frame, [from + 2, from + 22], [0, 56], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
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
          fontSize: 92,
          fontWeight: 700,
          lineHeight: 1.18,
          color: colors.text,
          opacity: interpolate(frame, [from + 4, from + 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          }),
          translate: interpolate(
            frame,
            [from + 4, from + 24],
            ["0px 26px", "0px 0px"],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          ),
        }}
      >
        {headline}
      </Interactive.Div>
    </Interactive.Div>
  );
};
