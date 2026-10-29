import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts } from "../theme";
import { trial } from "../data";
import { cues } from "../timing";

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const c = cues.cta;

/**
 * The close, landing one line at a time on the read: the trial, the promise
 * under it, the button, then the address.
 *
 * The trial is the only offer on screen — the number is set large and alone,
 * with the qualifier under it in smaller type so the claim stays accurate (the
 * seven days run on the Starter monthly plan; `trialDays` is 0 on every other
 * plan, which is the server's rule, not fine print) without competing with it
 * for attention.
 */
export const CtaScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="CtaScene">
      <Backdrop hueShift={-90} />

      <Interactive.Div
        name="TrialBlock"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
        }}
      >
        <Interactive.Div
          name="TrialBadge"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 22,
            opacity: interpolate(frame, [c.trial, c.trial + 18], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
            scale: interpolate(frame, [c.trial, c.trial + 28], [0.82, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 16 }),
              output: "perceptual-scale",
            }),
          }}
        >
          <span
            style={{
              fontFamily: fonts.display,
              fontSize: 200,
              fontWeight: 800,
              lineHeight: 1,
              color: colors.emerald,
            }}
          >
            {trial.days}
          </span>
          <span
            style={{
              fontFamily: fonts.display,
              fontSize: 92,
              fontWeight: 700,
              color: colors.text,
            }}
          >
            {trial.bn}
          </span>
        </Interactive.Div>

        <Interactive.Div
          name="TrialNote"
          style={{
            fontFamily: fonts.body,
            fontSize: 38,
            fontWeight: 500,
            color: colors.muted,
            opacity: interpolate(frame, [c.decide, c.decide + 18], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
          }}
        >
          {trial.note} — আগে ব্যবহার করুন, তারপর সিদ্ধান্ত নিন
        </Interactive.Div>

        <Interactive.Div
          name="CtaButton"
          style={{
            marginTop: 34,
            padding: "30px 64px",
            borderRadius: 999,
            background: `linear-gradient(135deg, ${colors.indigo}, ${colors.violet})`,
            boxShadow: `0 36px 110px ${colors.violet}4D`,
            fontFamily: fonts.body,
            fontSize: 46,
            fontWeight: 700,
            color: colors.text,
            opacity: interpolate(frame, [c.button, c.button + 16], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
            translate: interpolate(
              frame,
              [c.button, c.button + 24],
              ["0px 26px", "0px 0px"],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
            ),
          }}
        >
          আজই ফ্রি অ্যাকাউন্ট খুলুন
        </Interactive.Div>

        <Interactive.Div
          name="Domain"
          style={{
            marginTop: 20,
            fontFamily: fonts.latin,
            fontSize: 58,
            fontWeight: 700,
            letterSpacing: 1,
            color: colors.cyan,
            opacity: interpolate(frame, [c.domain, c.domain + 14], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: ease,
            }),
            scale: interpolate(frame, [c.domain, c.domain + 22], [0.92, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 16 }),
              output: "perceptual-scale",
            }),
          }}
        >
          {trial.domain}
        </Interactive.Div>
      </Interactive.Div>

      <Interactive.Div
        name="Signature"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 86,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          opacity: interpolate(frame, [c.signature, c.signature + 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          }),
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 58,
            height: 58,
            borderRadius: 16,
            background: `linear-gradient(135deg, ${colors.indigo}, ${colors.violet})`,
            fontFamily: fonts.latin,
            fontSize: 28,
            fontWeight: 800,
            color: colors.text,
          }}
        >
          RS
        </span>
        <span
          style={{
            fontFamily: fonts.latin,
            fontSize: 44,
            fontWeight: 700,
            letterSpacing: -0.5,
            color: colors.text,
          }}
        >
          Retailer Suites
        </span>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
