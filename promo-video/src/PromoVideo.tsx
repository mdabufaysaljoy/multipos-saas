import React from "react";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { OpeningScene } from "./scenes/OpeningScene";
import { VerticalsScene } from "./scenes/VerticalsScene";
import {
  FeatureScene,
  coreFeatureProps,
  growthFeatureProps,
} from "./scenes/FeatureScene";
import { PricingScene } from "./scenes/PricingScene";
import { CtaScene } from "./scenes/CtaScene";
import { Voiceover } from "./ui/Voiceover";
import { Rail } from "./ui/Rail";
import { durations, TRANSITION } from "./timing";

/**
 * 2150 frames at 30fps — 71.67s, which is the Bangla take (71.55s) plus a
 * third of a second of air after the last word.
 *
 * Nothing here is a chosen length. `timing.ts` derives every cut from the
 * voice-over's own subtitle file, and `durations` adds the cross-fade each
 * sequence has to cover; the five overlaps hand those frames back, so the six
 * sequences still add up to 2150.
 */
export type PromoVideoProps = {
  voiceover: boolean;
  rail: boolean;
};

export const PromoVideo: React.FC<PromoVideoProps> = ({ voiceover, rail }) => (
  <>
    {voiceover ? <Voiceover /> : null}
    <TransitionSeries>
      <TransitionSeries.Sequence name="Opening" durationInFrames={durations.opening}>
        <OpeningScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence
        name="Verticals"
        durationInFrames={durations.verticals}
      >
        <VerticalsScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence
        name="Core features"
        durationInFrames={durations.core}
      >
        <FeatureScene {...coreFeatureProps} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence
        name="Growth features"
        durationInFrames={durations.growth}
      >
        <FeatureScene {...growthFeatureProps} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Pricing" durationInFrames={durations.pricing}>
        <PricingScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence
        name="Free trial & CTA"
        durationInFrames={durations.cta}
      >
        <CtaScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    {rail ? <Rail /> : null}
  </>
);
