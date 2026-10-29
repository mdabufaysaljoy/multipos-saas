import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { Icon } from "../ui/Icon";
import { plans } from "../data";
import { cues } from "../timing";

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const c = cues.pricing;

/**
 * Nineteen seconds — the longest scene, because it is the one the viewer is
 * actually deciding on. Each card holds the price, the limits that define the
 * tier and the annual equivalent, so nobody has to pause the video to compare.
 *
 * The three cards arrive on their own names in the read, and the card being
 * priced is lit while its line runs; the limits inside it then tick in one by
 * one underneath the voice rather than all at once. The closing banner is the
 * arithmetic of the annual plans, not a promotion: an annual plan is ten months
 * of the monthly price, which is where "two months free" comes from.
 */
export const PricingScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill name="PricingScene">
      <Backdrop hueShift={-40} />
      <SceneHeading
        eyebrow="Monthly · BDT"
        headline="স্পষ্ট প্রাইসিং, আপনার মাপে"
        accent={colors.amber}
      />

      <Interactive.Div
        name="PlanCards"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          top: 300,
          display: "flex",
          alignItems: "flex-start",
          gap: 32,
        }}
      >
        {plans.map((plan, index) => {
          const enter = c.plans[index];
          const spokenUntil = c.plans[index + 1] ?? c.annual;
          const live = interpolate(
            frame,
            [enter, enter + 14, spokenUntil - 8, spokenUntil + 12],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          );
          const arrived = interpolate(frame, [enter, enter + 22], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          });

          return (
            <Interactive.Div
              key={plan.name}
              name={plan.name}
              style={{
                flex: 1,
                padding: "28px 30px 30px",
                borderRadius: 32,
                backgroundColor: plan.featured
                  ? `${plan.accent}1A`
                  : `rgba(255, 255, 255, ${0.035 + live * 0.04})`,
                border: `${live > 0.5 || plan.featured ? 2 : 1}px solid ${plan.accent}${
                  live > 0.5 ? "B3" : plan.featured ? "99" : "40"
                }`,
                boxShadow:
                  live > 0.5 || plan.featured
                    ? `0 40px 120px ${plan.accent}33`
                    : "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                opacity: arrived * (0.62 + live * 0.38),
                translate: interpolate(
                  frame,
                  [enter, enter + 32],
                  ["0px 60px", plan.featured ? "0px -22px" : "0px 0px"],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                    easing: Easing.spring({ damping: 20 }),
                  },
                ),
              }}
            >
              <Interactive.Div
                name="Ribbon"
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 16px",
                  borderRadius: 999,
                  backgroundColor: `${plan.accent}2E`,
                  color: plan.accent,
                  fontFamily: fonts.body,
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                }}
              >
                {plan.ribbon}
              </Interactive.Div>

              <Interactive.Div
                name="PlanName"
                style={{
                  fontFamily: fonts.latin,
                  fontSize: 42,
                  fontWeight: 700,
                  color: colors.text,
                }}
              >
                {plan.name}
              </Interactive.Div>

              <Interactive.Div
                name="PlanAudience"
                style={{
                  fontFamily: fonts.body,
                  fontSize: 26,
                  fontWeight: 500,
                  color: colors.muted,
                  marginTop: -8,
                }}
              >
                {plan.bn}
              </Interactive.Div>

              <Interactive.Div
                name="Price"
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  marginTop: 4,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 66,
                    fontWeight: 800,
                    color: plan.accent,
                    lineHeight: 1,
                    scale: interpolate(frame, [enter + 6, enter + 28], [0.86, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                      easing: Easing.spring({ damping: 15 }),
                      output: "perceptual-scale",
                    }),
                  }}
                >
                  {plan.price}
                </span>
                <span
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 28,
                    fontWeight: 500,
                    color: colors.muted,
                  }}
                >
                  {plan.perMonth}
                </span>
              </Interactive.Div>

              <Interactive.Div
                name="AnnualPrice"
                style={{
                  fontFamily: fonts.body,
                  fontSize: 24,
                  fontWeight: 500,
                  color: colors.muted,
                }}
              >
                {plan.annual}
              </Interactive.Div>

              <Interactive.Div
                name="PlanRows"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginTop: 6,
                  paddingTop: 16,
                  borderTop: `1px solid ${colors.border}`,
                }}
              >
                {plan.rows.map((row, rowIndex) => (
                  <Interactive.Div
                    key={row}
                    name={`Row ${rowIndex + 1}`}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      fontFamily: fonts.body,
                      fontSize: 26,
                      fontWeight: 500,
                      color: colors.text,
                      lineHeight: 1.35,
                      opacity: interpolate(
                        frame,
                        [enter + 24 + rowIndex * 8, enter + 44 + rowIndex * 8],
                        [0, 1],
                        {
                          extrapolateLeft: "clamp",
                          extrapolateRight: "clamp",
                          easing: ease,
                        },
                      ),
                      translate: interpolate(
                        frame,
                        [enter + 24 + rowIndex * 8, enter + 46 + rowIndex * 8],
                        ["-14px 0px", "0px 0px"],
                        {
                          extrapolateLeft: "clamp",
                          extrapolateRight: "clamp",
                          easing: ease,
                        },
                      ),
                    }}
                  >
                    <span
                      style={{ color: plan.accent, flexShrink: 0, marginTop: 4 }}
                    >
                      <Icon name="check" size={24} strokeWidth={2.6} />
                    </span>
                    {row}
                  </Interactive.Div>
                ))}
              </Interactive.Div>
            </Interactive.Div>
          );
        })}
      </Interactive.Div>

      <Interactive.Div
        name="AnnualNote"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 72,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          opacity: interpolate(frame, [c.annual, c.annual + 18], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ease,
          }),
          translate: interpolate(
            frame,
            [c.annual, c.annual + 24],
            ["0px 20px", "0px 0px"],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease },
          ),
        }}
      >
        <Interactive.Div
          name="AnnualPill"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "14px 32px",
            borderRadius: 999,
            backgroundColor: `${colors.emerald}1F`,
            border: `1px solid ${colors.emerald}66`,
            fontFamily: fonts.body,
            fontSize: 32,
            fontWeight: 600,
            color: colors.emerald,
          }}
        >
          <Icon name="spark" size={32} strokeWidth={2.2} />
          বার্ষিক প্ল্যান নিলে ২ মাস একদম ফ্রি
        </Interactive.Div>
      </Interactive.Div>
    </AbsoluteFill>
  );
};
