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

/**
 * 1800 frames at 30fps — exactly 60 seconds.
 *
 * The six sequence durations add up to 1875, and five 15-frame cross-fades
 * overlap 75 of them back out, which is what lands the total on 1800. Change a
 * scene length and the main composition's `durationInFrames` in Root.tsx has to
 * move with it.
 */
export const TRANSITION = 15;

/**
 * The voice-over is committed with the project, so this is on by default;
 * pass `voiceover: false` to render a clean track for dubbing or for a
 * sound-off cut.
 */
export type PromoVideoProps = {
  voiceover: boolean;
};

export const PromoVideo: React.FC<PromoVideoProps> = ({ voiceover }) => (
  <>
    {voiceover ? <Voiceover /> : null}
    <TransitionSeries>
      <TransitionSeries.Sequence name="Opening" durationInFrames={195}>
        <OpeningScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Verticals" durationInFrames={255}>
        <VerticalsScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Core features" durationInFrames={375}>
        <FeatureScene {...coreFeatureProps} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Growth features" durationInFrames={255}>
        <FeatureScene {...growthFeatureProps} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Pricing" durationInFrames={480}>
        <PricingScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: TRANSITION })}
      />
      <TransitionSeries.Sequence name="Free trial & CTA" durationInFrames={315}>
        <CtaScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </>
);
