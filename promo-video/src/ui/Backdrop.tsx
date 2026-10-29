import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { colors } from "../theme";

/**
 * One backdrop for every scene, so the six scenes read as a single film rather
 * than six slides: a dark slate base, a slow-drifting pair of brand glows, and
 * a faint grid that gives the motion something to move against.
 */
export const Backdrop: React.FC<{ hueShift?: number }> = ({ hueShift = 0 }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="Backdrop" style={{ backgroundColor: colors.bg }}>
      <AbsoluteFill
        name="Grid"
        style={{
          backgroundImage: `linear-gradient(${colors.border} 1px, transparent 1px), linear-gradient(90deg, ${colors.border} 1px, transparent 1px)`,
          backgroundSize: "96px 96px",
          opacity: 0.1,
          translate: interpolate(frame, [0, 600], ["0px 0px", "-96px -48px"], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        name="GlowIndigo"
        style={{
          background: `radial-gradient(42% 42% at 22% 24%, ${colors.indigo}66 0%, transparent 70%)`,
          translate: interpolate(frame, [0, 480], ["0px 0px", `${120 + hueShift}px 60px`], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        name="GlowCyan"
        style={{
          background: `radial-gradient(46% 46% at 80% 78%, ${colors.cyan}4D 0%, transparent 72%)`,
          translate: interpolate(frame, [0, 480], ["0px 0px", "-100px -70px"], {
            extrapolateRight: "clamp",
          }),
        }}
      />
      <AbsoluteFill
        name="Vignette"
        style={{
          background: `radial-gradient(120% 90% at 50% 50%, transparent 40%, ${colors.bg} 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
