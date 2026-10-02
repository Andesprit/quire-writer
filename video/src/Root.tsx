import React from 'react';
import {AbsoluteFill, Composition, Sequence} from 'remotion';
import {Backdrop} from './lib';
import {Promo, propsOf, TL, TOTAL} from './Promo';
import {Reveal} from './scenes/Intro';
import {FPS} from './theme';

const REVEAL = TL.scenes.find((s) => s.key === 'reveal')!;
// The site's poster: the frame of the reveal where the name and the formats are all in, before
// the window rises, with a play button drawn on it.
const Poster: React.FC = () => (
  <AbsoluteFill>
    <Sequence from={-REVEAL.ends[1]}>
      <Backdrop />
      <Reveal {...propsOf(REVEAL)} />
    </Sequence>
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 110}}>
      <div style={{width: 150, height: 150, borderRadius: 150, background: 'rgba(255,255,255,0.12)', border: '1.5px solid rgba(255,255,255,0.35)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <svg width="56" height="64" viewBox="0 0 56 64" style={{marginLeft: 10}}>
          <path d="M4 4 L52 32 L4 60 Z" fill="#fff" stroke="#fff" strokeWidth="6" strokeLinejoin="round" />
        </svg>
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
    <Composition id="Poster" component={Poster} durationInFrames={1} fps={FPS} width={1920} height={1080} />
  </>
);
