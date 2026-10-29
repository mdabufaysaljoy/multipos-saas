import React from "react";
import { Composition, Folder } from "remotion";
import { PromoVideo } from "./PromoVideo";
import { OpeningScene } from "./scenes/OpeningScene";
import { VerticalsScene } from "./scenes/VerticalsScene";
import {
  FeatureScene,
  coreFeatureProps,
  growthFeatureProps,
} from "./scenes/FeatureScene";
import { PricingScene } from "./scenes/PricingScene";
import { CtaScene } from "./scenes/CtaScene";
import { durations, FPS, TOTAL } from "./timing";

/**
 * Every scene is also registered on its own so it has an editable timeline in
 * Studio; the durations here come from `timing.ts`, the same place the main
 * composition takes them from, so a scene previewed alone runs exactly as long
 * as it does in the film.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="RetailerSuitesPromo"
      component={PromoVideo}
      defaultProps={{ voiceover: true, rail: true }}
      width={1920}
      height={1080}
      fps={FPS}
      durationInFrames={TOTAL}
    />
    <Folder name="Scenes">
      <Composition
        id="Opening"
        component={OpeningScene}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.opening}
      />
      <Composition
        id="Verticals"
        component={VerticalsScene}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.verticals}
      />
      <Composition
        id="CoreFeatures"
        component={FeatureScene}
        defaultProps={coreFeatureProps}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.core}
      />
      <Composition
        id="GrowthFeatures"
        component={FeatureScene}
        defaultProps={growthFeatureProps}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.growth}
      />
      <Composition
        id="Pricing"
        component={PricingScene}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.pricing}
      />
      <Composition
        id="FreeTrialCta"
        component={CtaScene}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={durations.cta}
      />
    </Folder>
  </>
);
