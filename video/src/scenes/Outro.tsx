import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {Body, CheckMark, CrossMark, EASE_IN, IN_OUT, Icon, Kicker, mix, pop, Rich, SceneProps, Sfx, tw} from '../lib';
import {C, MONO, SANS, SERIF} from '../theme';

// ---------------------------------------------------------------- Compare

const RIVALS = ['VS Code?', 'Cursor?', 'Claude Code?'];

// Only what each tool does out of the box. A string is a partial answer, shown as a grey note.
type Cell = boolean | string;
const ROWS: {label: string; cells: [Cell, Cell, Cell]}[] = [
  {label: 'Made for writing, not for code', cells: [false, false, false]},
  {label: 'Typst, LaTeX and Quarto preview, no setup', cells: ['extensions', 'extensions', false]},
  {label: 'Grammarly and macOS spellcheck', cells: [false, false, false]},
  {label: 'AI edits as tracked changes in your prose', cells: ['code diffs', 'code diffs', 'terminal diffs']},
  {label: 'Cite by DOI, export to Word and e-book', cells: ['extensions', 'extensions', false]},
];
const COLS = ['VS Code', 'Cursor', 'Claude Code'];
const LABEL_W = 640;
const COL_W = 245;
const ROW_H = 92;
const LEFT = 150;
const TOP = 270;

export const Compare: React.FC<SceneProps> = ({t, e}) => {
  const f = useCurrentFrame();
  const rollAt = [t(0, 'VS Code'), t(0, 'Cursor'), t(0, 'Claude Code')].map((x) => x - 2);
  const word = Math.max(0, rollAt.filter((x) => f >= x).length - 1);
  const wordIn = tw(f, rollAt[word], rollAt[word] + 12);
  const wordOut = word < 2 ? tw(f, rollAt[word + 1] - 6, rollAt[word + 1], EASE_IN) : 0;
  const aOut = tw(f, e(0) + 10, e(0) + 28, EASE_IN);
  const titleAt = e(0) + 20;
  const hl = tw(f, t(1) + 4, t(1) + 30);
  const rows = [t(1, 'built for code'), t(2, 'Previews'), t(2, 'Grammarly'), t(2, 'every AI edit'), e(2) - 4];
  const rowAt = (i: number) => rows[i];
  const end = tw(f, t(3), t(3) + 24);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center', opacity: 1 - aOut, transform: `translateY(${-aOut * 120}px) scale(${1 - aOut * 0.1})`, filter: `blur(${aOut * 10}px)`}}>
        <Rich text="Why not just use" size={110} align="center" at={t(0) - 4} stagger={3} />
        <div style={{height: 190, marginTop: 10, overflow: 'hidden'}}>
          <div
            style={{
              fontFamily: SERIF,
              fontStyle: 'italic',
              fontSize: 170,
              lineHeight: 1.1,
              color: C.accent,
              transform: `translateY(${(1 - wordIn) * 100 - wordOut * 100}%)`,
              opacity: wordIn * (1 - wordOut),
              filter: `blur(${(1 - wordIn + wordOut) * 8}px)`,
            }}
          >
            {RIVALS[word]}
          </div>
        </div>
      </div>
      {rollAt.map((s) => (
        <Sfx key={s} at={s} src="tick.wav" volume={0.6} />
      ))}

      <div style={{position: 'absolute', left: LEFT, top: 92, opacity: tw(f, titleAt, titleAt + 18)}}>
        <Kicker at={titleAt} color={C.blue}>
          Out of the box
        </Kicker>
        <div style={{marginTop: 18}}>
          <Rich text="Built for documents. *Not for code.*" size={76} at={titleAt + 4} />
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: LEFT + LABEL_W - 10,
          top: TOP - 20,
          width: COL_W + 20,
          height: ROW_H * (ROWS.length + 1) + 30,
          borderRadius: 22,
          background: 'linear-gradient(180deg, rgba(91,140,255,0.2), rgba(91,140,255,0.06))',
          border: '1px solid rgba(91,140,255,0.45)',
          boxShadow: `0 0 ${60 + 40 * end}px rgba(91,140,255,${0.25 + 0.2 * end})`,
          transform: `scaleY(${hl})`,
          transformOrigin: '50% 0%',
          opacity: hl,
        }}
      />
      <div style={{position: 'absolute', left: LEFT, top: TOP, display: 'flex', alignItems: 'center', height: ROW_H, fontFamily: SANS}}>
        <div style={{width: LABEL_W}} />
        <div style={{width: COL_W, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 34, fontWeight: 700, color: C.text, opacity: hl}}>
          <Img src={staticFile('icon.png')} style={{width: 48, height: 48}} />
          Quire
        </div>
        {COLS.map((c, k) => {
          const p = tw(f, t(1) + 10 + k * 4, t(1) + 26 + k * 4);
          return (
            <div key={c} style={{width: COL_W, textAlign: 'center', fontSize: 28, fontWeight: 500, color: C.muted, opacity: p, transform: `translateY(${(1 - p) * 16}px)`}}>
              {c}
              {k === 2 ? <div style={{fontSize: 18, color: C.dim, marginTop: 2}}>in a terminal</div> : null}
            </div>
          );
        })}
      </div>
      {ROWS.map((r, i) => {
        const at = rowAt(i);
        const p = tw(f, at, at + 16);
        return (
          <div key={r.label} style={{position: 'absolute', left: LEFT, top: TOP + ROW_H * (i + 1), height: ROW_H, display: 'flex', alignItems: 'center', fontFamily: SANS, borderTop: `1px solid rgba(255,255,255,${0.08 * p})`}}>
            <div style={{width: LABEL_W, paddingRight: 30, fontSize: 31, fontWeight: 500, letterSpacing: '-0.015em', color: C.text, opacity: p, transform: `translateX(${(1 - p) * -40}px)`}}>{r.label}</div>
            <div style={{width: COL_W, display: 'flex', justifyContent: 'center'}}>
              <CheckMark p={tw(f, at + 6, at + 20)} size={50} />
            </div>
            {r.cells.map((c, k) => {
              const q = tw(f, at + 10 + k * 4, at + 22 + k * 4);
              return (
                <div key={k} style={{width: COL_W, display: 'flex', justifyContent: 'center'}}>
                  {typeof c === 'string' ? (
                    <span style={{fontSize: 22, color: C.muted, padding: '6px 14px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.03)', opacity: q, transform: `scale(${0.8 + 0.2 * q})`}}>{c}</span>
                  ) : (
                    <CrossMark p={q} size={44} />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {ROWS.map((_, i) => (
        <Sfx key={i} at={rowAt(i) + 8} src="pop.mp3" volume={0.22} />
      ))}
      <div style={{position: 'absolute', left: LEFT, right: LEFT, top: 860, display: 'flex', alignItems: 'center', gap: 22, opacity: end, transform: `translateY(${(1 - end) * 24}px)`}}>
        <span style={{width: 58, height: 58, borderRadius: 16, flex: 'none', background: 'rgba(226,85,156,0.14)', border: '1px solid rgba(226,85,156,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Icon name="sparkle" size={28} color={C.pink} />
        </span>
        <div style={{fontFamily: SANS, fontSize: 33, lineHeight: 1.3, color: C.text, letterSpacing: '-0.015em'}}>
          Already use Claude Code? Keep it. Quire runs the same Claude agent with your login,
          <span style={{color: C.muted}}> and adds the page, the preview and the review.</span>
        </div>
      </div>
      <div style={{position: 'absolute', left: LEFT, top: 1010, fontFamily: SANS, fontSize: 18, color: C.dim, opacity: tw(f, t(3) + 30, t(3) + 50)}}>What each tool does out of the box, without extensions. October 2026.</div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Privacy

const PROMISES = [
  {icon: 'lock', text: 'Your files stay on your Mac.', c: C.green},
  {icon: 'userX', text: 'No account. No telemetry.', c: C.blue},
  {icon: 'heart', text: 'Free and open source.', c: C.pink},
];

export const Trust: React.FC<SceneProps> = ({t, e}) => {
  const f = useCurrentFrame();
  const ats = [t(0), t(0, 'No account'), t(1, 'free')].map((x) => x - 4);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 400, top: 230}}>
        {PROMISES.map((p, i) => {
          const at = ats[i];
          const s = pop(f, at, 13);
          return (
            <div key={p.text} style={{display: 'flex', alignItems: 'center', gap: 40, height: 170}}>
              <span
                style={{
                  width: 116,
                  height: 116,
                  borderRadius: 32,
                  flex: 'none',
                  background: `${p.c}1f`,
                  border: `1px solid ${p.c}66`,
                  boxShadow: `0 0 50px ${p.c}33`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: `scale(${s}) rotate(${(1 - s) * -20}deg)`,
                }}
              >
                <Icon name={p.icon} size={56} color={p.c} stroke={1.8} />
              </span>
              <Rich text={p.text} size={92} at={at + 2} stagger={3} />
            </div>
          );
        })}
      </div>
      <div style={{position: 'absolute', left: 400, top: 790}}>
        <Body at={e(1) - 6} style={{width: 1100}}>
          Quire has no server of its own. Your agent runs on your Mac, with your own login.
        </Body>
      </div>
      {ats.map((at) => (
        <Sfx key={at} at={at} src="pop.mp3" volume={0.28} />
      ))}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Download

export const Outro: React.FC<SceneProps> = ({t}) => {
  const f = useCurrentFrame();
  const icon = pop(f, 0, 12);
  const btnAt = t(1) - 2;
  const btn = pop(f, btnAt, 12);
  const shine = (tw(f, btnAt + 24, btnAt + 54, IN_OUT) + tw(f, btnAt + 90, btnAt + 120, IN_OUT)) % 1;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{background: `radial-gradient(ellipse 50% 45% at 50% 55%, rgba(91,140,255,${0.18 * tw(f, 20, 80)}), transparent 70%)`}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: 96, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, transform: `scale(${icon})`, opacity: Math.min(1, icon * 2)}}>
        <Img src={staticFile('icon.png')} style={{width: 112, height: 112}} />
        <span style={{fontFamily: SANS, fontSize: 70, fontWeight: 700, letterSpacing: '-0.05em', color: C.text}}>Quire</span>
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 290}}>
        <Rich text={'Write with AI.\n*Keep the final say.*'} size={138} align="center" at={t(0, 'Write') - 6} stagger={4} lineHeight={1.02} />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 700, display: 'flex', justifyContent: 'center'}}>
        <div
          style={{
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '26px 52px',
            borderRadius: 999,
            background: 'linear-gradient(180deg, #6f9bff 0%, #3d6dfa 100%)',
            boxShadow: `0 20px 60px rgba(61,109,250,0.55), inset 0 1px 0 rgba(255,255,255,0.35)`,
            fontFamily: SANS,
            fontSize: 40,
            fontWeight: 600,
            color: '#fff',
            transform: `scale(${btn})`,
          }}
        >
          <Icon name="download" size={38} color="#fff" stroke={2.4} />
          Download for Mac
          <div style={{position: 'absolute', top: 0, bottom: 0, left: `${mix(-30, 130, shine)}%`, width: '22%', background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.45), transparent)', transform: 'skewX(-20deg)'}} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 860, textAlign: 'center', fontFamily: MONO, fontSize: 34, color: C.text, opacity: tw(f, btnAt + 12, btnAt + 32)}}>andesprit.com/quire-writer</div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 920, textAlign: 'center', fontFamily: SANS, fontSize: 24, color: C.dim, opacity: tw(f, btnAt + 22, btnAt + 42)}}>Free · Open source · macOS on Apple Silicon</div>
      <Sfx at={0} src="boom.wav" volume={0.45} />
      <Sfx at={btnAt} src="pop.mp3" volume={0.35} />
    </AbsoluteFill>
  );
};
