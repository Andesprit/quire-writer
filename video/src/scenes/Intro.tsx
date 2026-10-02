import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {EASE_IN, Glass, IN_OUT, Icon, mix, pop, Rich, SceneProps, Sfx, tw} from '../lib';
import {C, SANS} from '../theme';
import {AppWindow} from '../ui';

const PAINS = [
  {icon: 'copy', text: 'Copy and paste between a chat and your draft.'},
  {icon: 'code', text: "A code editor where Grammarly can't follow."},
  {icon: 'eyeOff', text: 'An agent changing files you never see.'},
];

export const Hook: React.FC<SceneProps> = ({dur, t, e}) => {
  const f = useCurrentFrame();
  const up = tw(f, e(0) + 2, e(0) + 24, IN_OUT);
  const out = tw(f, t(4) - 18, t(4) - 2, EASE_IN);
  const inAt = (i: number) => t(i + 1) - 2;
  const strikeAt = (i: number) => e(i + 1) - 2;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: mix(390, 120, up), transform: `scale(${mix(1, 0.62, up) * (1 - out * 0.1)})`, opacity: 1 - out, filter: `blur(${out * 10}px)`}}>
        <Rich text="Writing a document *with AI?*" size={136} align="center" at={t(0) - 4} stagger={4} />
      </div>
      {PAINS.map((p, i) => {
        const s = pop(f, inAt(i), 15);
        const strike = tw(f, strikeAt(i), strikeAt(i) + 12, IN_OUT);
        return (
          <Glass
            key={i}
            style={{
              left: 330,
              width: 1260,
              top: 350 + i * 150,
              height: 118,
              display: 'flex',
              alignItems: 'center',
              gap: 30,
              padding: '0 40px',
              opacity: s * (1 - 0.6 * strike) * (1 - out),
              transform: `translateX(${(1 - s) * 140 + out * -60 * (i - 1)}px) translateY(${out * (1 - i) * 60}px) scale(${1 - out * 0.1})`,
              filter: `blur(${out * 10}px) saturate(${1 - strike * 0.7})`,
            }}
          >
            <div style={{width: 66, height: 66, borderRadius: 18, background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
              <Icon name={p.icon} size={32} color={C.bad} />
            </div>
            <div style={{position: 'relative', fontFamily: SANS, fontSize: 43, fontWeight: 500, letterSpacing: '-0.02em', color: C.text}}>
              {p.text}
              <div style={{position: 'absolute', left: -8, top: '53%', height: 5, borderRadius: 5, width: `calc(${strike * 100}% + ${strike * 16}px)`, background: C.bad, boxShadow: `0 0 16px ${C.bad}`}} />
            </div>
          </Glass>
        );
      })}
      {PAINS.map((_, i) => (
        <React.Fragment key={i}>
          <Sfx at={inAt(i)} src="pop.mp3" volume={0.3} />
          <Sfx at={strikeAt(i) + 1} src="tick.wav" volume={0.6} />
        </React.Fragment>
      ))}
      <div style={{position: 'absolute', left: 0, right: 0, top: 420}}>
        <Rich text="There's a better way *to write.*" size={124} align="center" at={t(4) - 4} stagger={3} />
      </div>
      <Sfx at={dur - 40} src="riser.mp3" volume={0.5} />
    </AbsoluteFill>
  );
};

const FORMATS = [
  {name: 'Typst', c: C.blue},
  {name: 'LaTeX', c: C.green},
  {name: 'Quarto', c: C.pink},
  {name: 'Markdown', c: C.orange},
];

export const Formats: React.FC<{at: number | number[]; size?: number}> = ({at, size = 26}) => {
  const f = useCurrentFrame();
  return (
    <div style={{display: 'flex', gap: 14}}>
      {FORMATS.map((x, i) => {
        const s = pop(f, Array.isArray(at) ? at[i] : at + i * 5, 12);
        return (
          <div
            key={x.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: `${size * 0.45}px ${size * 0.85}px`,
              borderRadius: 999,
              border: `1px solid ${x.c}55`,
              background: `${x.c}14`,
              fontFamily: SANS,
              fontSize: size,
              fontWeight: 500,
              color: C.text,
              transform: `scale(${s})`,
              opacity: Math.min(1, s * 2),
            }}
          >
            <span style={{width: size * 0.4, height: size * 0.4, borderRadius: 99, background: x.c, boxShadow: `0 0 12px ${x.c}`}} />
            {x.name}
          </div>
        );
      })}
    </div>
  );
};

export const Reveal: React.FC<SceneProps> = ({dur, t, e}) => {
  const f = useCurrentFrame();
  const flash = 1 - tw(f, 0, 36);
  const icon = pop(f, 2, 12);
  const sweep = tw(f, 12, 44, IN_OUT);
  const rise = e(1) + 6;
  const out = tw(f, rise, rise + 32, IN_OUT);
  const win = tw(f, rise + 6, rise + 68);
  const drift = tw(f, rise + 28, dur, (x) => x);
  const formats = ['Typst', 'LaTeX', 'Quarto', 'Markdown'].map((w) => t(1, w) - 3);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{background: `radial-gradient(circle at 50% 42%, rgba(160,190,255,${0.55 * flash}) 0%, rgba(91,140,255,${0.25 * flash}) 25%, transparent ${30 + 40 * (1 - flash)}%)`}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: 210, display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${-out * 300}px) scale(${1 - out * 0.3})`, opacity: 1 - out, filter: `blur(${out * 8}px)`}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 44}}>
          <div style={{position: 'relative', width: 210, height: 210, transform: `scale(${icon}) rotate(${(1 - icon) * -14}deg)`}}>
            <div style={{position: 'absolute', inset: -60, borderRadius: '50%', background: `radial-gradient(circle, ${C.blue}66, transparent 65%)`, opacity: 0.7 + 0.3 * Math.sin(f / 9)}} />
            <Img src={staticFile('icon.png')} style={{position: 'absolute', inset: 0, width: 210, height: 210}} />
            <div
              style={{
                position: 'absolute',
                inset: 18,
                borderRadius: 40,
                overflow: 'hidden',
                background: `linear-gradient(115deg, transparent ${sweep * 160 - 40}%, rgba(255,255,255,0.45) ${sweep * 160 - 25}%, transparent ${sweep * 160 - 10}%)`,
                mixBlendMode: 'overlay',
              }}
            />
          </div>
          <div style={{display: 'flex', fontFamily: SANS, fontSize: 200, fontWeight: 700, letterSpacing: '-0.055em', color: C.text, lineHeight: 1}}>
            {'Quire'.split('').map((ch, i) => {
              const p = tw(f, 10 + i * 3, 34 + i * 3);
              return (
                <span key={i} style={{display: 'inline-block', transform: `translateY(${(1 - p) * 70}px)`, opacity: p, filter: `blur(${(1 - p) * 10}px)`}}>
                  {ch}
                </span>
              );
            })}
          </div>
        </div>
        <div style={{marginTop: 34}}>
          <Rich text="The writing app with *your AI agent* built in." size={50} weight={500} align="center" at={t(1) - 4} stagger={2} color={C.muted} />
        </div>
        <div style={{marginTop: 40}}>
          <Formats at={formats} />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 160,
          top: 110,
          width: 1600,
          height: 960,
          transform: `perspective(2600px) translateY(${mix(980, 0, win)}px) rotateX(${mix(42, 9, win) - 7 * drift}deg) scale(${mix(0.72, 0.9, win) + 0.04 * drift})`,
          transformOrigin: '50% 20%',
          opacity: Math.min(1, win * 3),
        }}
      >
        <div style={{position: 'absolute', left: 100, right: 100, top: 120, height: 700, background: `radial-gradient(ellipse at center, ${C.blue}55, transparent 70%)`, filter: 'blur(40px)'}} />
        <div style={{position: 'relative', boxShadow: '0 80px 160px rgba(0,0,0,0.7)', borderRadius: 14}}>
          <AppWindow />
        </div>
      </div>
      <Sfx at={0} src="boom.wav" volume={0.7} />
      {formats.map((at) => (
        <Sfx key={at} at={at} src="pop.mp3" volume={0.22} />
      ))}
      <Sfx at={rise + 6} src="whoosh.mp3" volume={0.35} />
    </AbsoluteFill>
  );
};
