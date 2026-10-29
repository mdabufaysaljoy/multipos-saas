import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { Icon } from "../ui/Icon";
import { verticals } from "../data";
import { cues } from "../timing";

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const c = cues.verticals;

/**
 * The four POS verticals, each arriving on the word that names it — "fashion,
 * super shop, restaurant আর pharmacy" — and each carrying its own accent, so
 * the rest of the film can reuse those colours as a quiet index of which trade
 * a feature belongs to.
 *
 * The chip underneath is the actual architecture, not a slogan: one account
 * holds the workspaces, and a workspace is what has a POS type.
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
        from={c.heading}
      />

      <Interactive.Div
        name="VerticalCards"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          top: 352,
          display: "flex",
          gap: 30,
        }}
      >
        {verticals.map((vertical, index) => {
          const at = c.cards[index];

          return (
            <Interactive.Div
              key={vertical.en}
              name={vertical.en}
              style={{
                flex: 1,
                padding: "40px 34px 36px",
                borderRadius: 30,
                backgroundColor: colors.surface,
                border: `1px solid ${vertical.accent}4D`,
                boxShadow: `0 30px 90px ${vertical.accent}1F`,
                display: "flex",
                flexDirection: "column",
                gap: 18,
                opacity: interpolate(frame, [at, at + 18], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: ease,
                }),
                translate: interpolate(frame, [at, at + 26], ["0px 56px", "0px 0px"], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.spring({ damping: 20 }),
                }),
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
                  fontSize: 36,
                  fontWeight: 500,
                  color: colors.text,
                  lineHeight: 1.35,
                }}
              >
                {vertical.bn}
              </Interactive.Div>
              <Interactive.Div
                name="Detail"
                style={{
                  marginTop: 2,
                  paddingTop: 16,
                  borderTop: `1px solid ${colors.border}`,
                  fontFamily: fonts.body,
                  fontSize: 26,
                  fontWeight: 500,
                  lineHeight: 1.35,
                  color: colors.muted,
                  opacity: interpolate(frame, [at + 14, at + 32], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: ease,
                  }),
                }}
              >
                {vertical.detail}
              </Interactive.Div>
            </Interactive.Div>
          );
        })}
      </Interactive.Div>

      <Interactive.Div
        name="OneAccount"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          bottom: 96,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: "16px 0",
          fontFamily: fonts.body,
          fontSize: 34,
          fontWeight: 600,
          color: colors.text,
          opacity: interpolate(frame, [c.oneAccount, c.oneAccount + 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          }),
          scale: interpolate(frame, [c.oneAccount, c.oneAccount + 22], [0.9, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.spring({ damping: 16 }),
            output: "perceptual-scale",
          }),
        }}
      >
        <span style={{ color: colors.cyan, display: "flex" }}>
          <Icon name="branch" size={34} strokeWidth={2} />
        </span>
        একটাই account — প্রতিটি ব্যবসার জন্য আলাদা workspace
      </Interactive.Div>
    </AbsoluteFill>
  );
};
