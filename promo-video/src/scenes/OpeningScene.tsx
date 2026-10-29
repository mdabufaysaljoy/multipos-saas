import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts } from "../theme";
import { cues } from "../timing";

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const c = cues.opening;

/**
 * Six and a half seconds to do two jobs: name the problem in one Bangla line,
 * then put the brand on screen. The question is struck through as it is asked —
 * the pen line is the only skeuomorphic thing in the film, and it earns its
 * place because the line being read is about paper — and the hook leaves before
 * the logo arrives, so the viewer only ever reads one thing at a time.
 *
 * Every number below is a frame from `timing.ts`, which is derived from the
 * voice-over's own subtitle file: the strike lands on the question mark, the
 * logomark springs in on the word "Retailer".
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
          opacity: interpolate(
            frame,
            [c.hook, c.hook + 16, c.hookOut, c.hookOut + 14],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          ),
          translate: interpolate(
            frame,
            [c.hook, c.hookOut + 14],
            ["0px 18px", "0px -22px"],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          ),
        }}
      >
        <Interactive.Div name="HookLine" style={{ position: "relative" }}>
          <Interactive.Div
            name="Question"
            style={{
              fontFamily: fonts.display,
              fontSize: 104,
              fontWeight: 700,
              color: colors.text,
              textAlign: "center",
            }}
          >
            দোকানের হিসাব এখনো খাতা-কলমে?
          </Interactive.Div>
          <Interactive.Div
            name="Strike"
            style={{
              position: "absolute",
              left: -18,
              right: -18,
              top: "54%",
              height: 7,
              borderRadius: 7,
              transformOrigin: "left center",
              background: `linear-gradient(90deg, ${colors.amber}, ${colors.violet})`,
              scale: `${interpolate(frame, [c.hookOut - 34, c.hookOut], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: ease,
              })} 1`,
              rotate: "-1.4deg",
            }}
          />
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Brand"
        from={c.brand}
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
            scale: interpolate(frame, [c.brand, c.brand + 30], [0.4, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 14 }),
              output: "perceptual-scale",
            }),
            rotate: interpolate(frame, [c.brand, c.brand + 34], ["-14deg", "0deg"], {
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
            opacity: interpolate(frame, [c.wordmark, c.wordmark + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
            translate: interpolate(
              frame,
              [c.wordmark, c.wordmark + 24],
              ["0px 24px", "0px 0px"],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
            ),
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
            opacity: interpolate(frame, [c.tagline, c.tagline + 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
          }}
        >
          এক প্ল্যাটফর্মেই আপনার পুরো ব্যবসা
        </Interactive.Div>

        <Interactive.Div
          name="Underline"
          style={{
            width: interpolate(frame, [c.tagline + 8, c.tagline + 48], [0, 560], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
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
