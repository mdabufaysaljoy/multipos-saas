import React from "react";
import { AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../ui/Backdrop";
import { colors, fonts, safe } from "../theme";
import { SceneHeading } from "../ui/SceneHeading";
import { Icon } from "../ui/Icon";
import { plans } from "../data";

/**
 * Sixteen seconds — the longest scene, because it is the one the viewer is
 * actually deciding on. Each card holds price, the limits that define the tier,
 * and the annual equivalent, so nobody has to pause the video to compare.
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
          top: 330,
          display: "flex",
          alignItems: "flex-start",
          gap: 32,
        }}
      >
        {plans.map((plan, index) => (
          <Interactive.Div
            key={plan.name}
            name={plan.name}
            style={{
              flex: 1,
              padding: plan.featured ? "34px 34px 36px" : "30px 30px 32px",
              borderRadius: 32,
              backgroundColor: plan.featured ? `${plan.accent}1A` : colors.surface,
              border: `${plan.featured ? 2 : 1}px solid ${plan.accent}${plan.featured ? "99" : "40"}`,
              boxShadow: plan.featured ? `0 40px 120px ${plan.accent}33` : "none",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              opacity: interpolate(frame, [26 + index * 18, 50 + index * 18], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
              translate: interpolate(
                frame,
                [26 + index * 18, 58 + index * 18],
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
                fontSize: 44,
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
              style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 4 }}
            >
              <span
                style={{
                  fontFamily: fonts.display,
                  fontSize: 72,
                  fontWeight: 800,
                  color: plan.accent,
                  lineHeight: 1,
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
                    fontSize: 27,
                    fontWeight: 500,
                    color: colors.text,
                    lineHeight: 1.35,
                    opacity: interpolate(
                      frame,
                      [60 + index * 18 + rowIndex * 7, 80 + index * 18 + rowIndex * 7],
                      [0, 1],
                      {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                        easing: Easing.bezier(0.16, 1, 0.3, 1),
                      },
                    ),
                  }}
                >
                  <span style={{ color: plan.accent, flexShrink: 0, marginTop: 4 }}>
                    <Icon name="check" size={24} strokeWidth={2.6} />
                  </span>
                  {row}
                </Interactive.Div>
              ))}
            </Interactive.Div>
          </Interactive.Div>
        ))}
      </Interactive.Div>

      <Interactive.Div
        name="AnnualNote"
        style={{
          position: "absolute",
          left: safe.x,
          right: safe.x,
          bottom: 50,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: fonts.body,
          fontSize: 34,
          fontWeight: 600,
          color: colors.emerald,
          opacity: interpolate(frame, [200, 226], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <Icon name="spark" size={32} strokeWidth={2.2} />
        বার্ষিক প্ল্যান নিলে ২ মাস একদম ফ্রি
      </Interactive.Div>
    </AbsoluteFill>
  );
};
