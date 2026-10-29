import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { verticals } from "../data";

/**
 * The four POS verticals, staggered in one at a time. Each card carries its own
 * accent so the rest of the video can reuse those colours as a quiet index of
 * which trade a feature belongs to.
 */
export const VerticalsScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="VerticalsScene">
      <Backdrop hueShift={40} />
      <SceneHeading
        eyebrow="Four POS, one account"
        headline="আপনার ব্যবসার ধরন অনুযায়ী POS"
        accent={colors.cyan}
      />

      <Interactive.Div
        name="VerticalCards"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          bottom: safe.y + 10,
          display: "flex",
          gap: 30,
        }}
      >
        {verticals.map((vertical, index) => (
          <Interactive.Div
            key={vertical.en}
            name={vertical.en}
            style={{
              flex: 1,
              padding: "44px 36px",
              borderRadius: 30,
              backgroundColor: colors.surface,
              border: `1px solid ${vertical.accent}4D`,
              boxShadow: `0 30px 90px ${vertical.accent}1F`,
              display: "flex",
              flexDirection: "column",
              gap: 20,
              opacity: interpolate(frame, [34 + index * 13, 56 + index * 13], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              translate: interpolate(
                frame,
                [34 + index * 13, 60 + index * 13],
                ["0px 56px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.spring({ damping: 20 }),
                },
              ),
            }}
          >
            <Interactive.Div
              name="Index"
              style={{
                fontFamily: fonts.latin,
                fontSize: 30,
                fontWeight: 700,
                color: vertical.accent,
                letterSpacing: 2,
              }}
            >
              {`0${index + 1}`}
            </Interactive.Div>
            <Interactive.Div
              name="Name"
              style={{
                fontFamily: fonts.latin,
                fontSize: 46,
                fontWeight: 700,
                color: colors.text,
                lineHeight: 1.15,
                // Two of the four names wrap; a fixed box keeps the Bangla
                // line under them on one baseline across all four cards.
                minHeight: 106,
              }}
            >
              {vertical.en}
            </Interactive.Div>
            <Interactive.Div
              name="Bangla"
              style={{
                fontFamily: fonts.body,
                fontSize: 38,
                fontWeight: 500,
                color: colors.muted,
                lineHeight: 1.35,
              }}
            >
              {vertical.bn}
            </Interactive.Div>
          </Interactive.Div>
        ))}
      </Interactive.Div>
    </AbsoluteFill>
  );
};
