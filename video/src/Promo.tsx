import React from 'react';
import {AbsoluteFill, Audio, interpolate, Sequence, staticFile} from 'remotion';
import {Backdrop, ExitKind, Scene, SceneProps, Sfx} from './lib';
import {Ask, Autocomplete, CmdK, Preview, Review} from './scenes/Features';
import {Hook, Reveal} from './scenes/Intro';
import {Agents, BuiltIn, Spelling, Themes} from './scenes/More';
import {Compare, Outro, Trust} from './scenes/Outro';
import script from './script.json';
import {buildTimeline, phraseAt, Placed, Script, Voice} from './timeline';
import voice from './voice.json';

export const TL = buildTimeline(script as Script, voice as Voice);
export const TOTAL = TL.total;
export const propsOf = (p: Placed): SceneProps => ({dur: p.dur, t: (i, phrase) => phraseAt(p, i, phrase), e: (i) => p.ends[i]});

const SCENES: Record<string, {C: React.FC<SceneProps>; exit?: ExitKind}> = {
  hook: {C: Hook, exit: 'zoom'},
  reveal: {C: Reveal, exit: 'zoom'},
  preview: {C: Preview, exit: 'left'},
  ask: {C: Ask, exit: 'up'},
  review: {C: Review, exit: 'blur'},
  cmdk: {C: CmdK, exit: 'down'},
  autocomplete: {C: Autocomplete, exit: 'zoom'},
  agents: {C: Agents, exit: 'up'},
  spelling: {C: Spelling, exit: 'left'},
  builtin: {C: BuiltIn, exit: 'blur'},
  themes: {C: Themes, exit: 'zoom'},
  compare: {C: Compare, exit: 'up'},
  trust: {C: Trust, exit: 'blur'},
  outro: {C: Outro},
};

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
// The music steps back while the voice speaks.
const SPEECH = TL.scenes.flatMap((s) => s.cues.map((c, i) => [s.from + c, s.from + s.ends[i]]));
const duck = (f: number) => SPEECH.reduce((m, [a, b]) => Math.max(m, interpolate(f, [a - 8, a, b, b + 14], [0, 1, 1, 0], clamp)), 0);

export const Promo: React.FC = () => (
  <AbsoluteFill style={{background: '#000'}}>
    <Backdrop />
    {TL.scenes.map((p, i) => {
      const {C, exit} = SCENES[p.key];
      return (
        <Sequence key={p.key} from={p.from} durationInFrames={p.dur}>
          {exit ? (
            <Scene dur={p.dur} exit={exit}>
              <C {...propsOf(p)} />
            </Scene>
          ) : (
            <C {...propsOf(p)} />
          )}
          {p.beats.map((b, k) => (
            <Sequence key={b.id} from={p.cues[k]} layout="none">
              <Audio src={staticFile(`voice/${b.id}.wav`)} />
            </Sequence>
          ))}
          {i > 1 ? <Sfx at={0} src="whoosh.mp3" volume={0.16} /> : null}
        </Sequence>
      );
    })}
    <Audio src={staticFile('music.mp3')} volume={(f) => 0.5 * interpolate(f, [0, 20, TOTAL - 70, TOTAL - 4], [0, 1, 1, 0], clamp) * (1 - 0.62 * duck(f))} />
  </AbsoluteFill>
);
