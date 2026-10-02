import React from 'react';
import {AbsoluteFill, Audio, Easing, interpolate, random, Sequence, spring, staticFile, useCurrentFrame} from 'remotion';
import {C, FPS, MONO, SANS, SERIF} from './theme';

export const EASE = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN = Easing.bezier(0.7, 0, 0.84, 0);
export const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

/** 0..1 progress between frames a and b. */
export const tw = (f: number, a: number, b: number, ease = EASE) =>
  interpolate(f, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});
export const mix = (a: number, b: number, p: number) => a + (b - a) * p;
export const pop = (f: number, at: number, damping = 13) =>
  spring({frame: f - at, fps: FPS, config: {damping, stiffness: 170, mass: 0.7}});
/** The part of s typed by frame f, typing from frame `at` at `cps` characters a second. */
export const typed = (s: string, f: number, at: number, cps = 40) =>
  s.slice(0, Math.max(0, Math.floor(((f - at) / FPS) * cps)));
export const typedEnd = (s: string, at: number, cps = 40) => at + Math.ceil((s.length / cps) * FPS);

export const Sfx: React.FC<{at: number; src: string; volume?: number}> = ({at, src, volume = 0.4}) => (
  <Sequence from={Math.round(at)} durationInFrames={90} layout="none">
    <Audio src={staticFile(`sfx/${src}`)} volume={volume} />
  </Sequence>
);

/**
 * Headline text. Words rise out of a mask one after another; words between *stars* are set in
 * the italic serif accent. "\n" breaks the line.
 */
export const Rich: React.FC<{
  text: string;
  at?: number;
  size: number;
  stagger?: number;
  color?: string;
  accent?: string;
  align?: 'left' | 'center';
  weight?: number;
  lineHeight?: number;
  style?: React.CSSProperties;
}> = ({text, at = 0, size, stagger = 3, color = C.text, accent, align = 'left', weight = 650, lineHeight = 1.04, style}) => {
  const f = useCurrentFrame();
  const words: {w: string; serif: boolean; br?: boolean}[] = [];
  text.split('*').forEach((seg, si) =>
    seg.split(/(\n| )/).forEach((tok) => {
      if (tok === '\n') words.push({w: '', serif: false, br: true});
      else if (tok.trim()) words.push({w: tok, serif: si % 2 === 1});
    }),
  );
  let i = 0;
  return (
    <div style={{fontFamily: SANS, fontSize: size, fontWeight: weight, lineHeight, letterSpacing: '-0.035em', textAlign: align, color, ...style}}>
      {words.map((w, k) => {
        if (w.br) return <br key={k} />;
        const p = tw(f, at + i * stagger, at + i * stagger + 20);
        i++;
        return (
          <span key={k} style={{display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', padding: '0 0.1em 0.14em 0.02em', margin: '0 0.14em -0.14em -0.02em'}}>
            <span
              style={{
                display: 'inline-block',
                transform: `translateY(${(1 - p) * 108}%) rotate(${(1 - p) * 4}deg)`,
                transformOrigin: 'left bottom',
                opacity: p,
                ...(w.serif
                  ? {
                      fontFamily: SERIF,
                      fontStyle: 'italic',
                      fontWeight: 400,
                      letterSpacing: '-0.01em',
                      fontSize: '1.1em',
                      lineHeight: 0.95,
                      ...(accent
                        ? {color: accent}
                        : {backgroundImage: 'linear-gradient(100deg, #b7c9ff 0%, #8fb0ff 45%, #d3a6ff 100%)', WebkitBackgroundClip: 'text', color: 'transparent'}),
                    }
                  : {}),
              }}
            >
              {w.w}
            </span>
          </span>
        );
      })}
    </div>
  );
};

/** A paragraph that fades up as one block. */
export const Body: React.FC<{at?: number; size?: number; style?: React.CSSProperties; children: React.ReactNode}> = ({at = 0, size = 30, style, children}) => {
  const f = useCurrentFrame();
  const p = tw(f, at, at + 22);
  return (
    <div style={{fontFamily: SANS, fontSize: size, lineHeight: 1.42, color: C.muted, letterSpacing: '-0.01em', opacity: p, transform: `translateY(${(1 - p) * 18}px)`, filter: `blur(${(1 - p) * 6}px)`, ...style}}>
      {children}
    </div>
  );
};

export const Kicker: React.FC<{at?: number; color?: string; children: string; style?: React.CSSProperties}> = ({at = 0, color = C.blue, children, style}) => {
  const f = useCurrentFrame();
  const p = tw(f, at, at + 16);
  return (
    <div style={{display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: MONO, fontSize: 19, letterSpacing: '0.2em', textTransform: 'uppercase', color: C.muted, opacity: p, transform: `translateX(${(1 - p) * -16}px)`, ...style}}>
      <span style={{width: 9, height: 9, borderRadius: 9, background: color, boxShadow: `0 0 18px ${color}`}} />
      {children}
    </div>
  );
};

export const Glass: React.FC<{style?: React.CSSProperties; children?: React.ReactNode}> = ({style, children}) => (
  <div
    style={{
      position: 'absolute',
      borderRadius: 22,
      background: C.glass,
      border: `1px solid ${C.line}`,
      boxShadow: '0 50px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
      overflow: 'hidden',
      ...style,
    }}
  >
    {children}
  </div>
);

const ICONS: Record<string, string> = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  eyeOff: '<path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7"/><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><line x1="2" x2="22" y1="2" y2="22"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" x2="22" y1="8" y2="13"/><line x1="22" x2="17" y1="8" y2="13"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  sparkle: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  tag: '<path d="M12 2H2v10l9.3 9.3a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4L12 2Z"/><path d="M7 7h.01"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pointer: '<path d="m4 4 7 17 2.5-7.4L21 11 4 4z"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

export const Icon: React.FC<{name: keyof typeof ICONS | string; size?: number; color?: string; stroke?: number; style?: React.CSSProperties}> = ({name, size = 24, color = 'currentColor', stroke = 2, style}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{flex: 'none', ...style}}
    dangerouslySetInnerHTML={{__html: ICONS[name]}}
  />
);

/** A check that draws itself as p goes 0..1. */
export const CheckMark: React.FC<{p: number; size?: number; color?: string}> = ({p, size = 40, color = C.ok}) => (
  <svg width={size} height={size} viewBox="0 0 40 40" style={{transform: `scale(${0.6 + 0.4 * Math.min(1, p * 1.6)})`, opacity: Math.min(1, p * 3)}}>
    <circle cx="20" cy="20" r="18" fill={`${color}22`} stroke={`${color}66`} strokeWidth="1.5" />
    <path d="M12 20.5l5.5 5.5L28.5 14" fill="none" stroke={color} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="26" strokeDashoffset={26 * (1 - p)} />
  </svg>
);

export const CrossMark: React.FC<{p: number; size?: number}> = ({p, size = 40}) => (
  <svg width={size} height={size} viewBox="0 0 40 40" style={{opacity: p, transform: `scale(${0.7 + 0.3 * p})`}}>
    <path d="M14 14l12 12M26 14L14 26" stroke="#5c5c66" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

type Pt = {f: number; x: number; y: number};
const posAt = (path: Pt[], f: number) => {
  let x = path[0].x;
  let y = path[0].y;
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k];
    const b = path[k + 1];
    if (f >= a.f) {
      const p = tw(f, a.f, b.f, IN_OUT);
      x = mix(a.x, b.x, p);
      y = mix(a.y, b.y, p);
    }
  }
  return {x, y};
};

/** The macOS pointer moving along keyframes, with a ripple and a click sound on each click. */
export const Cursor: React.FC<{path: Pt[]; clicks?: number[]; scale?: number}> = ({path, clicks = [], scale = 1.25}) => {
  const f = useCurrentFrame();
  const {x, y} = posAt(path, f);
  const shown = tw(f, path[0].f, path[0].f + 8);
  const press = clicks.reduce((m, c) => Math.max(m, tw(f, c, c + 3) * (1 - tw(f, c + 4, c + 10))), 0);
  return (
    <>
      {clicks.map((c) => {
        const q = tw(f, c, c + 22);
        const at = posAt(path, c);
        return f >= c && q < 1 ? (
          <div key={c} style={{position: 'absolute', left: at.x - 40, top: at.y - 40, width: 80, height: 80, borderRadius: 80, border: `3px solid ${C.accent}`, opacity: 1 - q, transform: `scale(${0.2 + q})`}} />
        ) : null;
      })}
      <svg width={34 * scale} height={40 * scale} viewBox="0 0 34 40" style={{position: 'absolute', left: x - 4, top: y - 3, opacity: shown, transform: `scale(${1 - press * 0.15})`, transformOrigin: '4px 3px', filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.5))'}}>
        <path d="M4 3 L4 30 L10.5 24 L15 34 L19.5 32 L15 22.5 L24 22.5 Z" fill="#0b0b0d" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
      </svg>
      {clicks.map((c) => (
        <Sfx key={`s${c}`} at={c} src="click.wav" volume={0.55} />
      ))}
    </>
  );
};

/** A 3D keyboard key that pops in at `at` and goes down on each frame in `press`. */
export const Keycap: React.FC<{label: React.ReactNode; at: number; press?: number[]; size?: number; w?: number; font?: number}> = ({label, at, press = [], size = 180, w, font}) => {
  const f = useCurrentFrame();
  const s = pop(f, at, 11);
  const d = press.reduce((m, c) => Math.max(m, tw(f, c, c + 3) * (1 - tw(f, c + 6, c + 14))), 0);
  const lift = 14 * (1 - d) + 3;
  return (
    <div style={{display: 'inline-block', transform: `scale(${s})`, opacity: Math.min(1, s * 2)}}>
      <div
        style={{
          width: w ?? size,
          height: size,
          borderRadius: size * 0.16,
          background: 'linear-gradient(180deg, #34363e 0%, #22242a 100%)',
          boxShadow: `0 ${lift}px 0 #101115, 0 ${lift + 18}px 50px rgba(0,0,0,0.55), inset 0 1.5px 0 rgba(255,255,255,0.16), inset 0 -2px 0 rgba(0,0,0,0.3)${d > 0.3 ? `, 0 0 60px ${C.blue}66` : ''}`,
          transform: `translateY(${d * 11}px)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: SANS,
          fontWeight: 500,
          fontSize: font ?? size * 0.42,
          color: d > 0.3 ? '#fff' : '#e4e4ea',
        }}
      >
        {label}
      </div>
      {press.map((c) => (
        <Sfx key={c} at={c} src="key.wav" volume={0.7} />
      ))}
    </div>
  );
};

export const Caret: React.FC<{h?: number; color?: string; solid?: boolean}> = ({h = 30, color = '#aeafad', solid}) => {
  const f = useCurrentFrame();
  const on = solid || Math.floor(f / 15) % 2 === 0;
  return <span style={{display: 'inline-block', width: 2.5, height: h, background: color, opacity: on ? 1 : 0, verticalAlign: 'text-bottom', marginLeft: 1, marginBottom: -2}} />;
};

/** The dark stage behind every scene: four slow colour lights, a fading grid and film grain. */
export const Backdrop: React.FC<{glow?: number}> = ({glow = 1}) => {
  const f = useCurrentFrame();
  const orbs = [
    {c: C.blue, x: 0.22, y: 0.28, r: 1100, s: 0.011, ph: 0},
    {c: C.pink, x: 0.82, y: 0.22, r: 900, s: 0.009, ph: 2},
    {c: C.green, x: 0.74, y: 0.88, r: 1000, s: 0.008, ph: 4},
    {c: C.orange, x: 0.14, y: 0.86, r: 800, s: 0.012, ph: 1},
  ];
  return (
    <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
      {orbs.map((o, k) => {
        const x = (o.x + 0.07 * Math.sin(f * o.s + o.ph)) * 1920;
        const y = (o.y + 0.06 * Math.cos(f * o.s * 1.3 + o.ph)) * 1080;
        return (
          <div
            key={k}
            style={{position: 'absolute', left: x - o.r / 2, top: y - o.r / 2, width: o.r, height: o.r, borderRadius: '50%', background: `radial-gradient(circle, ${o.c}40 0%, ${o.c}14 35%, ${o.c}00 68%)`, opacity: 0.85 * glow}}
          />
        );
      })}
      <AbsoluteFill
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '96px 96px',
          backgroundPosition: `${(f * 0.25) % 96}px ${(f * 0.4) % 96}px`,
          maskImage: 'radial-gradient(ellipse 62% 58% at 50% 50%, black 10%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse 62% 58% at 50% 50%, black 10%, transparent 78%)',
        }}
      />
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.07, mixBlendMode: 'overlay'}}>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.floor(random(Math.floor(f / 2)) * 100)} stitchTiles="stitch" />
        </filter>
        <rect width="1920" height="1080" filter="url(#grain)" />
      </svg>
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 80% 75% at 50% 50%, transparent 55%, rgba(0,0,0,0.65) 100%)'}} />
    </AbsoluteFill>
  );
};

export type ExitKind = 'zoom' | 'left' | 'up' | 'down' | 'blur';

/** Wraps a scene and plays its exit over the last 14 frames, while the next scene comes in. */
export const Scene: React.FC<{dur: number; exit?: ExitKind; children: React.ReactNode}> = ({dur, exit = 'blur', children}) => {
  const f = useCurrentFrame();
  const p = tw(f, dur - 14, dur, EASE_IN);
  const t = {
    zoom: `scale(${1 + 0.4 * p})`,
    left: `translateX(${-300 * p}px)`,
    up: `translateY(${-180 * p}px)`,
    down: `translateY(${140 * p}px) scale(${1 - 0.06 * p})`,
    blur: `scale(${1 - 0.07 * p})`,
  }[exit];
  return <AbsoluteFill style={{transform: t, opacity: 1 - p, filter: p > 0 ? `blur(${p * 16}px)` : undefined}}>{children}</AbsoluteFill>;
};

/** What every scene gets: its length, the frame at which line i (or a phrase in it) is said, and where line i ends. */
export type SceneProps = {dur: number; t: (i: number, phrase?: string) => number; e: (i: number) => number};
