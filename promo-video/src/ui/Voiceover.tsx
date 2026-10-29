import React from "react";
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";

/**
 * The Bangla voice-over: one continuous take read in the **Ashwat — Calm,
 * Pleasant Storyteller** voice (ElevenLabs v4), committed at
 * `public/voiceover/promo-full.mp3`.
 *
 * It is used **at its recorded speed** — no `atempo` fitting — because the film
 * is cut to the voice rather than the other way round. The take runs 71.55s and
 * the picture is 2150 frames (71.67s), so the read is never clipped and the
 * last word has a third of a second of air before the cut.
 *
 * The subtitle file ElevenLabs returned with the take is committed next to it at
 * `voiceover/take.srt`, and `src/timing.ts` turns it into the film's frame
 * marks. Re-record the take → drop in the new mp3 and .srt, re-derive the
 * seconds in `timing.ts`, and every scene follows.
 */
export const Voiceover: React.FC = () => (
  <Audio src={staticFile("voiceover/promo-full.mp3")} />
);
