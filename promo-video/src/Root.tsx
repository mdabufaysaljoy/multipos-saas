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

/**
 * Every scene is also registered on its own so it has an editable timeline in
 * Studio; the durations and props here mirror how `PromoVideo` uses them.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="RetailerSuitesPromo"
      component={PromoVideo}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1800}
    />
    <Folder name="Scenes">
      <Composition
        id="Opening"
        component={OpeningScene}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={195}
      />
      <Composition
        id="Verticals"
        component={VerticalsScene}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={255}
      />
      <Composition
        id="CoreFeatures"
        component={FeatureScene}
        defaultProps={coreFeatureProps}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={375}
      />
      <Composition
        id="GrowthFeatures"
        component={FeatureScene}
        defaultProps={growthFeatureProps}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={255}
      />
      <Composition
        id="Pricing"
        component={PricingScene}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={480}
      />
      <Composition
        id="FreeTrialCta"
        component={CtaScene}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={315}
      />
    </Folder>
  </>
);
