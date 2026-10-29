import React from "react";
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";

/**
 * The Bangla voice-over, one continuous take read in the Ashwat voice.
 *
 * The take runs 71.5s against a 60s film, so it is fitted with ffmpeg's
 * `atempo` (1.207x), which changes speed without shifting pitch — the voice
 * still sounds like itself, just less unhurried, which suits an ad better than
 * the original storytelling pace. The fitted file is 59.35s, leaving the last
 * word a little room before the cut.
 *
 * Refit after any edit to the take:
 *
 *   remotion ffmpeg -i <take>.mp3 -af "atempo=<take length / 59.35>" \
 *     -b:a 160k public/voiceover/promo-full.mp3
 *
 * Because it is one take rather than six, the words are not pinned to the
 * scene cuts; the lines fall where the read puts them.
 */
export const Voiceover: React.FC = () => (
  <Audio src={staticFile("voiceover/promo-full.mp3")} />
);
