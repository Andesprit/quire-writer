import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {Body, CheckMark, Cursor, Glass, IN_OUT, Icon, Kicker, mix, pop, Rich, SceneProps, Sfx, tw, typed} from '../lib';
import {APP, C, MONO, SANS} from '../theme';
import {Editor, Pane} from '../ui';

// ---------------------------------------------------------------- Agents

// The agents in the ACP registry (agents.json in the app).
const AGENTS = [
  'Claude Agent', 'Codex', 'Gemini CLI', 'GitHub Copilot', 'Cursor', 'goose', 'OpenCode', 'Qwen Code', 'Mistral Vibe', 'Junie',
  'Kimi CLI', 'Amp', 'Cline', 'Devin', 'Factory Droid', 'Auggie CLI', 'Grok Build', 'Kilo', 'Google Antigravity', 'fast-agent',
  'GLM Agent', 'MiniMax Code', 'Poolside', 'Qoder CLI', 'DeepAgents', 'Codebuddy Code', 'Cortex Code', 'Stakpak', 'VT Code', 'crow-cli',
  'Autohand Code', 'Agoragentic', 'Corust Agent', 'DimCode', 'Dirac', 'Harn', 'Kimchi', 'Minion Code', 'Nova', 'pi ACP', 'siGit Code',
];
const HUES = [C.blue, C.green, C.pink, C.orange, '#a78bfa', '#22d3ee'];

const Avatar: React.FC<{name: string; size: number}> = ({name, size}) => {
  const c = HUES[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % HUES.length];
  return (
    <span style={{width: size, height: size, borderRadius: size, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${c}2a`, border: `1px solid ${c}88`, color: c, fontSize: size * 0.5, fontWeight: 700}}>
      {name[0].toUpperCase()}
    </span>
  );
};

const PICKS = ['Claude Agent', 'Codex', 'Gemini CLI', 'GitHub Copilot', 'goose'];

export const Agents: React.FC<SceneProps> = ({t}) => {
  const f = useCurrentFrame();
  const card = pop(f, t(0) + 14, 14);
  const switches = [t(1, 'Codex'), t(1, 'Gemini'), t(1, 'forty'), t(1, 'agents')];
  const chips = [t(1, 'your own login'), t(1, 'your own plan'), t(2)];
  const idx = switches.filter((s) => f >= s).length;
  const roll = idx > 0 ? tw(f, switches[idx - 1], switches[idx - 1] + 12, IN_OUT) : 1;
  return (
    <AbsoluteFill>
      {[0, 1, 2, 3].map((r) => {
        const dir = r % 2 ? 1 : -1;
        const names = [...AGENTS.slice(r * 10), ...AGENTS.slice(0, r * 10)];
        const p = tw(f, r * 4, 24 + r * 4);
        return (
          <div
            key={r}
            style={{
              position: 'absolute',
              top: 262 + r * 128,
              left: dir > 0 ? -2600 : 0,
              display: 'flex',
              gap: 18,
              transform: `translateX(${dir * (f * (1.6 + r * 0.35)) + (1 - p) * 200 * dir}px)`,
              opacity: p * (r === 1 || r === 2 ? 0.75 : 0.45),
              filter: r === 1 || r === 2 ? undefined : 'blur(1.5px)',
              maskImage: 'linear-gradient(90deg, transparent, black 15%, black 85%, transparent)',
            }}
          >
            {[...names, ...names].map((n, k) => (
              <div key={k} style={{display: 'flex', alignItems: 'center', gap: 14, padding: '14px 26px 14px 16px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.035)', fontFamily: SANS, fontSize: 28, color: C.muted, whiteSpace: 'nowrap'}}>
                <Avatar name={n} size={38} />
                {n}
              </div>
            ))}
          </div>
        );
      })}
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 40% 30% at 50% 52%, rgba(6,7,9,0.85), transparent 100%)'}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: 86}}>
        <Rich text="Bring the AI *you already pay for.*" size={96} align="center" at={t(0) - 4} stagger={3} />
      </div>
      <Glass style={{left: 560, top: 412, width: 800, height: 250, padding: '30px 40px', background: 'rgba(16,17,21,0.96)', transform: `scale(${card})`, opacity: Math.min(1, card * 2), boxShadow: `0 50px 140px rgba(0,0,0,0.75), 0 0 80px ${C.blue}33`}}>
        <div style={{fontFamily: MONO, fontSize: 18, letterSpacing: '0.18em', color: C.dim}}>AGENT</div>
        <div style={{position: 'relative', height: 84, marginTop: 10, overflow: 'hidden', borderBottom: `1px solid ${C.line}`}}>
          {[idx - 1, idx].map((k) =>
            k < 0 ? null : (
              <div
                key={k}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  fontFamily: SANS,
                  fontSize: 54,
                  fontWeight: 600,
                  letterSpacing: '-0.03em',
                  color: C.text,
                  transform: `translateY(${k === idx ? (1 - roll) * 90 : -roll * 90}px)`,
                  opacity: k === idx ? roll : 1 - roll,
                }}
              >
                <Avatar name={PICKS[k]} size={56} />
                {PICKS[k]}
                <Icon name="chevron" size={34} color={C.dim} style={{marginLeft: 'auto'}} />
              </div>
            ),
          )}
        </div>
        <div style={{display: 'flex', gap: 14, marginTop: 22}}>
          {['Your own login', 'Your own plan', 'Switch any time'].map((t, i) => {
            const s = pop(f, chips[i], 14);
            return (
              <span key={t} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 999, background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', fontFamily: SANS, fontSize: 22, color: C.text, transform: `scale(${s})`}}>
                <Icon name="check" size={18} color={C.ok} stroke={3} />
                {t}
              </span>
            );
          })}
        </div>
      </Glass>
      <div style={{position: 'absolute', left: 0, right: 0, top: 880}}>
        <Body at={t(2)} style={{textAlign: 'center'}}>
          Claude, Codex, Gemini and 40+ agents from the ACP registry.
          <br />
          Quire has no account and no AI plan of its own.
        </Body>
      </div>
      {switches.map((s) => (
        <Sfx key={s} at={s} src="tick.wav" volume={0.6} />
      ))}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Grammarly

const Squiggle: React.FC<{p: number; color: string; w: number}> = ({p, color, w}) => {
  const d = Array.from({length: Math.ceil(w / 8)}, (_, i) => `${i === 0 ? 'M' : 'L'}${i * 8} ${i % 2 ? 0 : 6}`).join(' ');
  return (
    <svg width={w} height={8} style={{position: 'absolute', left: 0, bottom: -4, overflow: 'visible'}}>
      <path d={d} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
    </svg>
  );
};

const Fix: React.FC<{from: string; to: string; color: string; drawAt: number; fixAt: number; kind: string; menuAt: number}> = ({from, to, color, drawAt, fixAt, kind, menuAt}) => {
  const f = useCurrentFrame();
  const fixed = tw(f, fixAt, fixAt + 8);
  const menu = pop(f, menuAt, 14) * (1 - tw(f, fixAt, fixAt + 6));
  const w = (fixed > 0.5 ? to : from).length * 20.4;
  return (
    <span style={{position: 'relative', display: 'inline-block'}}>
      <span style={{color: fixed > 0.5 ? APP.ok : undefined, transition: 'none'}}>{fixed > 0.5 ? to : from}</span>
      <span style={{opacity: 1 - fixed}}>
        <Squiggle p={tw(f, drawAt, drawAt + 12)} color={color} w={w} />
      </span>
      <div
        style={{
          position: 'absolute',
          left: -20,
          top: 62,
          zIndex: 5,
          width: 360,
          padding: '18px 20px',
          borderRadius: 14,
          background: '#f7f7f8',
          color: '#1c1c1f',
          boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          fontFamily: SANS,
          transform: `scale(${menu})`,
          transformOrigin: '30px 0',
          opacity: Math.min(1, menu * 2),
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{fontSize: 17, color: '#6b6b74', display: 'flex', alignItems: 'center', gap: 8}}>
          <span style={{width: 10, height: 10, borderRadius: 10, background: color}} />
          {kind}
        </div>
        <div style={{marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, fontSize: 26}}>
          <span style={{textDecoration: 'line-through', color: '#9a9aa2'}}>{from}</span>→
          <span style={{padding: '4px 14px', borderRadius: 8, background: '#1f6feb', color: '#fff', fontWeight: 600}}>{to}</span>
        </div>
      </div>
    </span>
  );
};

export const Spelling: React.FC<SceneProps> = ({t}) => {
  const f = useCurrentFrame();
  const card = tw(f, 0, 28);
  const menu1 = t(0, 'Grammarly') - 4;
  const fix1 = menu1 + 24;
  const menu2 = fix1 + 12;
  const fix2 = menu2 + 24;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 96, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
        <Kicker at={0} color={C.orange}>
          A real text field
        </Kicker>
        <div style={{marginTop: 24}}>
          <Rich text="Grammarly works here. *So does spellcheck.*" size={88} align="center" at={4} stagger={3} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 260, top: 330, width: 1400, height: 470, transform: `translateY(${(1 - card) * 140}px) scale(${0.95 + 0.05 * card})`, opacity: card}}>
        <Pane title="main.typ" size={18} style={{inset: 0, overflow: 'visible'}} bodyStyle={{padding: '40px 50px 0 0', overflow: 'visible'}}>
          <Editor
            size={34}
            lh={1.75}
            from={21}
            active={21}
            lines={[
              <>
                A baker who waits longer is rewarded with more{' '}
                <Fix from="flavuor" to="flavour" kind="Spelling" color="#f0524f" drawAt={t(0) + 16} menuAt={menu1} fixAt={fix1} />, because slow fermentation{' '}
                <Fix from="give" to="gives" kind="Grammar" color="#4f8ff0" drawAt={t(0) + 24} menuAt={menu2} fixAt={fix2} /> the bacteria time to make acids.
              </>,
            ]}
          />
        </Pane>
      </div>
      <Cursor
        path={[
          {f: menu1 - 14, x: 1500, y: 1000},
          {f: fix1 - 6, x: 1460, y: 535},
          {f: fix1 + 6, x: 1400, y: 640},
          {f: fix2 - 6, x: 1070, y: 650},
          {f: fix2 + 36, x: 1500, y: 1180},
        ]}
        clicks={[fix1 - 2, fix2 - 2]}
      />
      <div style={{position: 'absolute', left: 0, right: 0, top: 880}}>
        <Body at={fix2 + 4} style={{textAlign: 'center'}}>
          The editor is a real text field, so Grammarly and the macOS spellchecker work as you type.
        </Body>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Built in

const Tile: React.FC<{i: number; at: number; focus: number; dim: number; icon: string; title: string; text: string; color: string; children: React.ReactNode}> = ({i, at, focus, dim, icon, title, text, color, children}) => {
  const f = useCurrentFrame();
  const s = pop(f, at, 15);
  const col = i % 3;
  const row = Math.floor(i / 3);
  return (
    <Glass
      style={{
        left: 120 + col * 570,
        top: 250 + row * 372,
        width: 540,
        height: 344,
        padding: '30px 34px',
        transform: `translateY(${(1 - s) * 80}px) scale(${(0.9 + 0.1 * s) * (1 + 0.03 * focus)})`,
        opacity: Math.min(1, s * 1.6) * (1 - 0.5 * dim * (1 - focus)),
        border: `1px solid ${focus > 0.1 ? `${color}${Math.round(40 + focus * 100).toString(16)}` : C.line}`,
        boxShadow: `0 50px 120px rgba(0,0,0,0.6)${focus > 0.1 ? `, 0 0 ${50 * focus}px ${color}44` : ''}`,
        zIndex: focus > 0.1 ? 2 : 1,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
        <span style={{width: 46, height: 46, borderRadius: 13, background: `${color}22`, border: `1px solid ${color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <Icon name={icon} size={24} color={color} />
        </span>
        <span style={{fontFamily: SANS, fontSize: 31, fontWeight: 600, letterSpacing: '-0.02em', color: C.text}}>{title}</span>
      </div>
      <div style={{marginTop: 12, fontFamily: SANS, fontSize: 21, lineHeight: 1.4, color: C.muted}}>{text}</div>
      <div style={{position: 'absolute', left: 34, right: 34, bottom: 30, height: 120}}>{children}</div>
    </Glass>
  );
};

const chip = (on: number, color = C.accent): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 9,
  fontFamily: SANS,
  fontSize: 19,
  color: C.text,
  background: 'rgba(255,255,255,0.05)',
  border: `1px solid ${C.line}`,
  transform: `scale(${on})`,
  opacity: Math.min(1, on * 2),
  ...(color ? {} : {}),
});

const MARKUP = [
  {lang: 'Typst', c: C.blue, out: '*bold*'},
  {lang: 'LaTeX', c: C.green, out: '\\textbf{bold}'},
  {lang: 'Markdown', c: C.orange, out: '**bold**'},
];

export const BuiltIn: React.FC<SceneProps> = ({t, e}) => {
  const f = useCurrentFrame();
  const at = (i: number) => t(0) + 8 + i * 5;
  const say = [t(1, 'Cite'), t(1, 'export'), t(1, 'find unused'), t(1, 'and format')];
  const done = e(1) + 10;
  const focus = (i: number) => (i < 4 ? tw(f, say[i], say[i] + 8) * (1 - tw(f, say[i + 1] ?? done, (say[i + 1] ?? done) + 8)) : 0);
  const dim = tw(f, say[0], say[0] + 8) * (1 - tw(f, done, done + 8));
  const doi = typed('10.48550/arXiv.1706.03762', f, say[0] + 2, 40);
  const cited = pop(f, say[0] + 26, 12);
  const mk = Math.min(2, Math.floor(Math.max(0, f - say[3]) / 22));
  const jump = tw(f, at(4) + 50, at(4) + 66, IN_OUT);
  const upd = tw(f, at(5) + 20, at(5) + 120, IN_OUT);
  const tile = (i: number) => ({i, at: at(i), focus: focus(i), dim});
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 84}}>
        <Rich text="Everything a document needs. *Built in.*" size={88} align="center" at={t(0) - 4} stagger={3} />
      </div>
      <Tile {...tile(0)} icon="book" color={C.blue} title="Cite by DOI or arXiv" text="Adds the paper to your .bib and the citation at the cursor.">
        <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
          <div style={{fontFamily: MONO, fontSize: 21, padding: '10px 14px', borderRadius: 9, background: 'rgba(0,0,0,0.35)', border: `1px solid ${C.line}`, color: C.text, height: 48}}>{doi || ' '}</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, fontFamily: MONO, fontSize: 21, color: APP.label, opacity: Math.min(1, cited * 2), transform: `translateY(${(1 - cited) * 14}px)`}}>
            <CheckMark p={tw(f, say[0] + 28, say[0] + 44)} size={30} />
            @vaswani2017 <span style={{fontFamily: SANS, color: C.muted, fontSize: 19}}>added to refs.bib</span>
          </div>
        </div>
      </Tile>
      <Tile {...tile(1)} icon="download" color={C.green} title="Export anywhere" text="The whole document, with formatted references.">
        <div style={{display: 'flex', flexWrap: 'wrap', gap: 9}}>
          {['PDF', 'Word', 'Web page', 'E-book', 'OpenDocument', 'Markdown', 'LaTeX', 'Typst'].map((x, k) => (
            <span key={x} style={chip(pop(f, say[1] + k * 4, 12))}>
              {x}
            </span>
          ))}
        </div>
      </Tile>
      <Tile {...tile(2)} icon="tag" color={C.pink} title="Labels at a glance" text="Every label in the project, and the ones nothing refers to.">
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, fontFamily: SANS, fontSize: 21}}>
          {[
            ['timeline', '1 use', C.muted],
            ['eq-rate', 'unused', '#e5b52a'],
            ['fig-oven', '2 uses', C.muted],
          ].map(([n, u, c], k) => {
            const p = tw(f, say[2] + k * 6, say[2] + 14 + k * 6);
            const blink = k === 1 ? 0.5 + 0.5 * Math.sin(f / 5) : 0;
            return (
              <div key={n} style={{display: 'flex', padding: '4px 12px', borderRadius: 8, background: k === 1 ? `rgba(229,181,42,${0.08 + 0.08 * blink})` : undefined, opacity: p, transform: `translateX(${(1 - p) * 30}px)`, color: C.text}}>
                <span style={{fontFamily: MONO}}>{n}</span>
                <span style={{marginLeft: 'auto', color: c}}>{u}</span>
              </div>
            );
          })}
        </div>
      </Tile>
      <Tile {...tile(3)} icon="code" color={C.orange} title="Formatting in your markup" text="One bar for headings, math, tables and more, in each language.">
        <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
          <span style={{width: 58, height: 58, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SANS, fontWeight: 800, fontSize: 30, color: '#fff', background: APP.btn, boxShadow: `0 0 ${20 * (1 - tw(f, say[3] + mk * 22, say[3] + 12 + mk * 22))}px ${APP.btn}`}}>B</span>
          <span style={{fontSize: 30, color: C.dim}}>→</span>
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <span style={{fontFamily: SANS, fontSize: 18, color: MARKUP[mk].c}}>{MARKUP[mk].lang}</span>
            <span style={{fontFamily: MONO, fontSize: 30, color: C.text}}>{MARKUP[mk].out}</span>
          </div>
        </div>
      </Tile>
      <Tile {...tile(4)} icon="pointer" color="#a78bfa" title="Click the page, find the line" text="In Typst, the preview takes you to the text you click.">
        <div style={{display: 'flex', gap: 16, height: 120}}>
          <div style={{flex: 1, borderRadius: 8, background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 9, position: 'relative'}}>
            {[90, 70, 84, 60].map((w, k) => (
              <span key={k} style={{height: 10, width: `${w}%`, borderRadius: 4, background: k === 2 ? `rgba(91,140,255,${0.3 + 0.7 * jump})` : '#d5d5da'}} />
            ))}
            <span style={{position: 'absolute', left: mix(170, 120, tw(f, at(4) + 30, at(4) + 48, IN_OUT)), top: mix(110, 64, tw(f, at(4) + 30, at(4) + 48, IN_OUT))}}>
              <Icon name="pointer" size={28} color="#111" stroke={2.2} />
            </span>
          </div>
          <div style={{flex: 1, borderRadius: 8, background: APP.editor, padding: 14, display: 'flex', flexDirection: 'column', gap: 9}}>
            {[80, 64, 88, 52].map((w, k) => (
              <span key={k} style={{height: 10, width: `${w}%`, borderRadius: 4, background: k === 2 ? `rgba(91,140,255,${0.25 + 0.75 * jump})` : '#3a3a3f', boxShadow: k === 2 ? `0 0 ${16 * jump}px ${C.blue}` : undefined}} />
            ))}
          </div>
        </div>
      </Tile>
      <Tile {...tile(5)} icon="refresh" color="#22d3ee" title="Saves itself. Updates itself." text="Auto save by default, and new versions install in the background.">
        <div style={{display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SANS, fontSize: 21, color: C.text}}>
          <span style={{display: 'flex', alignItems: 'center', gap: 10}}>
            <span style={{width: 10, height: 10, borderRadius: 10, background: C.ok, boxShadow: `0 0 ${8 + 8 * Math.sin(f / 6)}px ${C.ok}`}} />
            Auto save
          </span>
          <div style={{height: 10, borderRadius: 10, background: 'rgba(255,255,255,0.08)', overflow: 'hidden'}}>
            <div style={{height: '100%', width: `${upd * 100}%`, background: 'linear-gradient(90deg, #22d3ee, #5b8cff)'}} />
          </div>
          <span style={{color: upd >= 1 ? C.ok : C.muted}}>{upd >= 1 ? '✓ Update ready. Opens at next start.' : 'Downloading update…'}</span>
        </div>
      </Tile>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Sfx key={i} at={at(i)} src="pop.mp3" volume={0.18} />
      ))}
      <Sfx at={at(4) + 50} src="click.wav" volume={0.4} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Themes

const THEMES = [
  {file: 'shots/dark.png', name: 'Dark Modern'},
  {file: 'shots/series.png', name: 'Series'},
  {file: 'shots/galley.png', name: 'Galley'},
  {file: 'shots/coupon.png', name: 'Coupon'},
  {file: 'shots/slate.png', name: 'Slate'},
];

export const Themes: React.FC<SceneProps> = ({t, e}) => {
  const f = useCurrentFrame();
  const steps = [t(1, 'book covers') - 8, t(1, 'book covers') + 14, t(1, 'and a') - 4, t(1, 'chalkboard') + 4];
  const a = steps.reduce((s, at) => s + tw(f, at, at + 18, IN_OUT), 0);
  const enter = tw(f, 0, 30);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 120, top: 84}}>
        <Kicker at={0} color="#a78bfa">
          Themes
        </Kicker>
        <div style={{marginTop: 22}}>
          <Rich text="Make it *yours.*" size={104} at={t(0) - 4} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 300, height: 640, perspective: 2400}}>
        {THEMES.map((t, k) => {
          const d = k - a;
          const ad = Math.abs(d);
          return (
            <div
              key={t.name}
              style={{
                position: 'absolute',
                left: 960 - 500 + d * 560,
                top: 0,
                width: 1000,
                height: 625,
                zIndex: 10 - Math.round(ad * 2),
                transform: `translateY(${(1 - enter) * 300}px) translateZ(${-ad * 260}px) rotateY(${Math.max(-50, Math.min(50, -d * 40))}deg)`,
                opacity: enter * Math.max(0, 1 - ad * 0.38),
                borderRadius: 14,
                overflow: 'hidden',
                boxShadow: `0 40px 100px rgba(0,0,0,0.7)${ad < 0.5 ? `, 0 0 0 2px rgba(255,255,255,0.25)` : ''}`,
              }}
            >
              <Img src={staticFile(t.file)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
            </div>
          );
        })}
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 968, textAlign: 'center', fontFamily: SANS, fontSize: 30, color: C.muted, opacity: tw(f, 20, 40)}}>
        <span style={{color: C.text, fontWeight: 600}}>{THEMES[Math.round(a)].name}</span>
        <span style={{opacity: tw(f, e(1) - 10, e(1) + 6)}}>
          <span style={{margin: '0 18px', color: C.dim}}>·</span>
          The layout stays. Only the look changes.
        </span>
      </div>
      {steps.map((s) => (
        <Sfx key={s} at={s} src="whoosh.mp3" volume={0.18} />
      ))}
    </AbsoluteFill>
  );
};
