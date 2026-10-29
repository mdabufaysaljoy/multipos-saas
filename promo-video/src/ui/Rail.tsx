import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { colors, fonts } from "../theme";
import { chapters, START, TOTAL } from "../timing";
import { trial } from "../data";

/**
 * The furniture that never cuts: a corner lockup, the name of the section being
 * read, the address, and a progress line along the bottom edge.
 *
 * It sits outside the `TransitionSeries`, so it does not cross-fade with the
 * scenes — which is what makes six scenes feel like one broadcast rather than a
 * slideshow. It also gives the viewer the two things an infographic film
 * normally withholds: where they are, and how much is left.
 *
 * It fades out for the closing scene, where the logo and the domain are the
 * subject rather than the frame.
 */
export const Rail: React.FC = () => {
  const frame = useCurrentFrame();

  // In after the opening logo has had the screen to itself; out before the
  // closing lockup arrives, so the two never sit on top of each other.
  const presence = interpolate(
    frame,
    [START.verticals - 20, START.verticals + 10, START.cta - 26, START.cta],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    },
  );

  const chapter =
    [...chapters].reverse().find((entry) => frame >= entry.start) ?? chapters[0];

  return (
    <AbsoluteFill name="Rail" style={{ pointerEvents: "none" }}>
      <Interactive.Div
        name="CornerLockup"
        style={{
          position: "absolute",
          top: 62,
          right: 142,
          display: "flex",
          alignItems: "center",
          gap: 14,
          opacity: presence * 0.92,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 46,
            height: 46,
            borderRadius: 13,
            background: `linear-gradient(135deg, ${colors.indigo}, ${colors.violet})`,
            fontFamily: fonts.latin,
            fontSize: 22,
            fontWeight: 800,
            color: colors.text,
          }}
        >
          RS
        </span>
        <span
          style={{
            fontFamily: fonts.latin,
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: -0.2,
            color: colors.text,
          }}
        >
          Retailer Suites
        </span>
      </Interactive.Div>

      <Interactive.Div
        name="Chapter"
        style={{
          position: "absolute",
          left: 142,
          bottom: 30,
          display: "flex",
          alignItems: "center",
          gap: 14,
          opacity: presence,
          fontFamily: fonts.latin,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: 3,
          textTransform: "uppercase",
          color: colors.muted,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            backgroundColor: colors.cyan,
          }}
        />
        {chapter.label}
      </Interactive.Div>

      <Interactive.Div
        name="Address"
        style={{
          position: "absolute",
          right: 142,
          bottom: 30,
          fontFamily: fonts.latin,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: 2,
          color: colors.muted,
          opacity: presence,
        }}
      >
        {trial.domain}
      </Interactive.Div>

      <Interactive.Div
        name="ProgressTrack"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 5,
          backgroundColor: "rgba(148, 163, 184, 0.14)",
          opacity: presence,
        }}
      >
        <Interactive.Div
          name="ProgressFill"
          style={{
            height: 5,
            width: `${interpolate(frame, [0, TOTAL], [0, 100], {
              extrapolateRight: "clamp",
            })}%`,
            background: `linear-gradient(90deg, ${colors.indigo}, ${colors.cyan})`,
          }}
        />
      </Interactive.Div>
    </AbsoluteFill>
  );
};
