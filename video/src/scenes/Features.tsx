import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {Body, Caret, Cursor, EASE_IN, IN_OUT, Icon, Keycap, Kicker, mix, pop, Rich, SceneProps, Sfx, tw, typed, typedEnd} from '../lib';
import {APP, C, MONO, PAPER, SANS} from '../theme';
import {Btn, Editor, hl, PaperPage, Pane, RateEq} from '../ui';
import {Formats} from './Intro';

// ---------------------------------------------------------------- Live preview

const P1 = '== Fermentation';
const P2 = 'The rate of fermentation roughly doubles for every ten degrees of warmth: $r(T) = r_0 dot 2^((T - T_0) / 10)$.';

const CPS = 44;

export const Preview: React.FC<SceneProps> = ({dur, t}) => {
  const f = useCurrentFrame();
  const at1 = t(0) + 10;
  const headAt = typedEnd(P1, at1, 26);
  const at2 = headAt + 6;
  const t1 = typed(P1, f, at1, 26);
  const t2 = typed(P2, f, at2, CPS);
  const headDone = t1.length === P1.length;
  const mathStart = P2.indexOf('$');
  const mathClosed = t2.length > P2.lastIndexOf('$');
  const mathAt = at2 + Math.ceil(((P2.lastIndexOf('$') + 1) / CPS) * 30);
  const click = t(1, 'Click') + 10;
  const flash = f >= click ? 1 - tw(f, click + 2, click + 60) : 0;
  const card = tw(f, 0, 32);
  const drift = tw(f, 30, dur, (x) => x);
  const glow = (at: number) => 1 - tw(f, at, at + 30);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 130, top: 270, width: 660}}>
        <Kicker at={0}>Live preview</Kicker>
        <div style={{marginTop: 28}}>
          <Rich text={'Write markup.\n*See the page.*'} size={104} at={4} />
        </div>
        <Body at={22} style={{marginTop: 34, width: 600}}>
          Typst, LaTeX, Quarto and Markdown, rendered next to your text as you write. Click the page to jump to the line.
        </Body>
        <div style={{marginTop: 44}}>
          <Formats at={34} size={23} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 820, top: 150, width: 1000, height: 780, perspective: 2200}}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translateX(${(1 - card) * 260}px) rotateY(${mix(-30, -12, card) + 6 * drift}deg) rotateX(${4 - 2 * drift}deg)`,
            opacity: card,
            transformOrigin: '0% 50%',
          }}
        >
          <Pane title="main.typ" style={{left: 0, top: 0, width: 500, height: 780, borderRadius: '16px 0 0 16px'}} bodyStyle={{padding: '22px 22px 0 0'}}>
            <Editor
              size={19}
              from={5}
              active={f > at2 && f < click ? 11 : 9}
              lines={[
                hl('= The Quiet Science of Bread'),
                '',
                'Bread is one of the oldest foods humans have made. Every loaf starts with the same four ingredients.',
                '',
                <>
                  <span style={{background: `rgba(91,140,255,${0.4 * flash})`, borderRadius: 3}}>{hl(t1)}</span>
                  {f < at2 && f >= at1 - 10 ? <Caret h={22} solid={f < headAt} /> : null}
                </>,
                '',
                <>
                  {hl(t2)}
                  {f >= at2 && f < click ? <Caret h={22} solid={t2.length < P2.length} /> : null}
                </>,
              ]}
            />
          </Pane>
          <Pane title="Preview main.typ" icon="book" iconColor={APP.muted} style={{left: 500, top: 0, width: 500, height: 780, borderRadius: '0 16px 16px 0', borderLeft: `1px solid ${APP.border}`}} bodyStyle={{background: '#2a2a2a', padding: 22}}>
            <PaperPage style={{padding: '40px 38px', height: 900, fontSize: 19, lineHeight: 1.5}}>
              <div style={{fontSize: 30, fontWeight: 700, marginBottom: 14, lineHeight: 1.15}}>The Quiet Science of Bread</div>
              <p style={{margin: 0, textAlign: 'justify'}}>Bread is one of the oldest foods humans have made. Every loaf starts with the same four ingredients.</p>
              {headDone ? (
                <div style={{fontSize: 23, fontWeight: 700, margin: '18px -6px 8px', padding: '0 6px', borderRadius: 4, background: `rgba(91,140,255,${0.3 * Math.max(glow(headAt), flash)})`}}>Fermentation</div>
              ) : null}
              <p style={{margin: 0, textAlign: 'justify'}}>
                {t2.slice(0, mathStart >= 0 && t2.length > mathStart ? mathStart : t2.length)}
                {mathClosed ? (
                  <span style={{display: 'inline-block', padding: '0 4px', borderRadius: 4, background: `rgba(91,140,255,${0.3 * glow(mathAt)})`, transform: `scale(${pop(f, mathAt, 10) * 0.2 + 0.8})`}}>
                    <RateEq />
                  </span>
                ) : null}
                {t2.length === P2.length ? '.' : ''}
              </p>
            </PaperPage>
          </Pane>
          <Cursor path={[{f: click - 30, x: 980, y: 720}, {f: click - 2, x: 650, y: 312}, {f: click + 40, x: 720, y: 430}]} clicks={[click]} />
        </div>
      </div>
      <Sfx at={headAt} src="pop.mp3" volume={0.25} />
      <Sfx at={mathAt} src="pop.mp3" volume={0.35} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Chat

const ASK = 'Fix the grammar in the Baking section. Keep my wording.';
const REPLY = 'Three verbs did not agree with their subject: turn, brown and matter. I changed only those words.';
const STEPS = ['Read the Baking section', 'Fix subject and verb agreement', 'Wait for your review'];

const Spinner: React.FC = () => {
  const f = useCurrentFrame();
  return <div style={{width: 22, height: 22, borderRadius: 22, border: `3px solid ${APP.widget}`, borderTopColor: C.accent, transform: `rotate(${f * 14}deg)`}} />;
};

export const Ask: React.FC<SceneProps> = ({dur, t}) => {
  const f = useCurrentFrame();
  const typeAt = t(0) + 8;
  const sendAt = typedEnd(ASK, typeAt, 42) + 6;
  const card = tw(f, 0, 30);
  const drift = tw(f, 30, dur, (x) => x);
  const bubble = pop(f, sendAt + 2, 14);
  const stepAt = (i: number) => sendAt + 10 + i * 12;
  const doneAt = (i: number) => sendAt + 30 + i * 16;
  const replyAt = sendAt + 50;
  const reply = typed(REPLY, f, replyAt, 60);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 140, top: 120, width: 820, height: 840, perspective: 2200}}>
        <div style={{position: 'absolute', inset: 0, transform: `translateX(${(1 - card) * -240}px) rotateY(${mix(26, 9, card) - 4 * drift}deg)`, transformOrigin: '100% 50%', opacity: card}}>
          <Pane title="Chat" icon="chat" iconColor={APP.muted} size={19} style={{inset: 0}} bodyStyle={{padding: 30, display: 'flex', flexDirection: 'column', fontFamily: SANS, fontSize: 25, lineHeight: 1.45, color: APP.fg}}>
            {f > sendAt ? (
              <div style={{background: '#2b2b2b', borderRadius: 10, padding: '18px 22px', color: APP.strong, transform: `translateY(${(1 - bubble) * 400}px) scale(${0.9 + 0.1 * bubble})`, opacity: Math.min(1, bubble * 2)}}>{ASK}</div>
            ) : null}
            <div style={{marginTop: 26, display: 'flex', flexDirection: 'column', gap: 14}}>
              {STEPS.map((s, i) => {
                const done = i < 2 && f > doneAt(i);
                const p = tw(f, stepAt(i), stepAt(i) + 12);
                return (
                  <div key={s} style={{display: 'flex', alignItems: 'center', gap: 14, opacity: p, transform: `translateX(${(1 - p) * 30}px)`, color: done ? APP.muted : APP.strong, textDecoration: done ? 'line-through' : undefined}}>
                    {done ? <Icon name="check" size={22} color={APP.ok} stroke={3} /> : i === 2 ? <span style={{width: 14, height: 14, margin: 4, borderRadius: 14, background: APP.strong, opacity: 0.5 + 0.5 * Math.sin(f / 4)}} /> : <Spinner />}
                    {s}
                  </div>
                );
              })}
            </div>
            <div style={{marginTop: 22, display: 'flex', alignItems: 'center', gap: 12, color: APP.muted, opacity: tw(f, doneAt(1) - 6, doneAt(1) + 4)}}>
              ✎ Edit main.typ
              <span style={{marginLeft: 'auto', fontSize: 20, padding: '3px 12px', borderRadius: 20, background: 'rgba(137,209,133,0.14)', color: APP.ok}}>3 changes</span>
            </div>
            <div style={{marginTop: 18, minHeight: 110}}>
              {reply}
              {f > replyAt - 2 && reply.length < REPLY.length ? <Caret h={26} solid /> : null}
            </div>
            <div style={{flex: 1}} />
            <div style={{border: `1px solid ${f < sendAt && f > typeAt - 2 ? APP.btn : APP.widget}`, borderRadius: 10, padding: '16px 18px', background: '#252526'}}>
              <span style={{fontSize: 17, border: `1px solid ${APP.widget}`, borderRadius: 4, padding: '2px 8px', color: APP.muted}}>main.typ</span>
              <div style={{margin: '14px 0 18px', minHeight: 72, color: f < sendAt ? APP.strong : '#8b8b8b'}}>
                {f < typeAt || f >= sendAt ? 'Ask the agent to write or change something' : typed(ASK, f, typeAt, 42)}
                {f >= typeAt && f < sendAt ? <Caret h={26} solid={f < sendAt - 6} /> : null}
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 22, color: APP.muted, fontSize: 19}}>
                <span>Claude Agent ⌄</span>
                <span>Mode: Auto</span>
                <span>Effort: High</span>
                <span style={{marginLeft: 'auto', width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: f > sendAt - 8 && f < sendAt + 6 ? APP.btn : APP.btn2, boxShadow: f > sendAt - 8 && f < sendAt + 6 ? `0 0 26px ${APP.btn}` : undefined}}>
                  <Icon name="up" size={22} color="#fff" />
                </span>
              </div>
            </div>
          </Pane>
        </div>
      </div>
      <div style={{position: 'absolute', left: 1080, top: 300, width: 720}}>
        <Kicker at={6} color={C.pink}>
          Chat
        </Kicker>
        <div style={{marginTop: 28}}>
          <Rich text={'Ask in\n*plain words.*'} size={110} at={10} />
        </div>
        <Body at={t(1)} style={{marginTop: 34, width: 640}}>
          Draft a section, fix the grammar, tighten the abstract. The agent reads your folder and shows its plan as it works.
        </Body>
      </div>
      <Sfx at={sendAt} src="click.wav" volume={0.5} />
      <Sfx at={sendAt + 2} src="whoosh.mp3" volume={0.2} />
      <Sfx at={doneAt(0)} src="tick.wav" volume={0.5} />
      <Sfx at={doneAt(1)} src="tick.wav" volume={0.5} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Review

const Ins: React.FC<{p: number; children: string}> = ({p, children}) => <span style={{background: `rgba(156,204,44,${0.34 * (1 - p)})`, borderRadius: 3}}>{children}</span>;
const Del: React.FC<{p: number; children: string}> = ({p, children}) => (
  <span style={{display: 'inline-block', maxWidth: `${(1 - p) * 4}em`, overflow: 'hidden', verticalAlign: 'bottom', opacity: 1 - p, background: APP.del, textDecoration: 'line-through', borderRadius: 3, whiteSpace: 'nowrap'}}>{children}</span>
);

const ChangeHead: React.FC<{n: string; p: number; glow: number}> = ({n, p, glow}) => (
  <div style={{height: 56 * (1 - p), opacity: 1 - p, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 60, paddingRight: 30, fontFamily: SANS, fontSize: 20, color: APP.muted}}>
    {n}
    <span style={{flex: 1}} />
    <Btn size={19}>↶ Reject</Btn>
    <Btn size={19} primary glow={glow}>
      ✓ Accept
    </Btn>
  </div>
);

export const Review: React.FC<SceneProps> = ({dur, t, e}) => {
  const f = useCurrentFrame();
  const up = tw(f, e(1) + 2, e(1) + 30, IN_OUT);
  const card = tw(f, e(1) + 6, e(1) + 40);
  const click1 = t(2, 'Accept') + 4;
  const click2 = e(2) + 8;
  const a1 = tw(f, click1 + 3, click1 + 19, IN_OUT);
  const a2 = tw(f, click2 + 3, click2 + 19, IN_OUT);
  const done = tw(f, click2 + 16, click2 + 26);
  const drift = tw(f, e(1) + 40, dur, (x) => x);
  const fs = 25;
  const bar = (p: number) => ({borderLeft: `4px solid rgba(0,120,212,${1 - p})`, paddingLeft: 0, marginLeft: 0});
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: mix(330, 54, up), transform: `scale(${mix(1, 0.56, up)})`, transformOrigin: '50% 0%'}}>
        <Rich text={'Every change waits\n*for your say.*'} size={140} align="center" at={t(0) - 2} stagger={4} lineHeight={1.0} />
      </div>
      <div style={{position: 'absolute', left: 250, top: 236, width: 1420, height: 706, perspective: 2400}}>
        <div style={{position: 'absolute', inset: 0, transform: `translateY(${(1 - card) * 500}px) rotateX(${mix(30, 0, card) + 2 * drift}deg) scale(${1 - 0.02 * drift})`, opacity: card, transformOrigin: '50% 0%'}}>
          <Pane title="main.typ" size={18} style={{inset: 0}} bodyStyle={{padding: '20px 0 0'}}>
            <div style={{fontFamily: MONO, fontSize: fs, lineHeight: 1.62, color: APP.fg}}>
              <Editor size={fs} from={9} lines={[hl('== Fermentation'), '']} />
              <ChangeHead n="Change 1 of 2" p={a1} glow={tw(f, click1 - 8, click1 - 2) * (1 - a1)} />
              <div style={{display: 'flex', ...bar(a1)}}>
                <div style={{width: fs * 2.4 - 4, flex: 'none', textAlign: 'right', paddingRight: fs * 1.1, color: APP.lineNo}}>11</div>
                <div style={{flex: 1, paddingRight: 40}}>
                  When yeast eat<Ins p={a1}>s</Ins> the sugars in flour, it release<Ins p={a1}>s</Ins> carbon dioxide and alcohol. The gas get<Ins p={a1}>s</Ins> trapped in a web of gluten, and the dough rise<Ins p={a1}>s</Ins>. A baker who wait<Ins p={a1}>s</Ins> longer <Del p={a1}>are</Del>
                  <Ins p={a1}>is</Ins> rewarded with more flavour.
                </div>
              </div>
              <Editor size={fs} from={12} lines={['', hl('== Baking'), '']} />
              <ChangeHead n="Change 2 of 2" p={a2} glow={0} />
              <div style={{display: 'flex', ...bar(a2)}}>
                <div style={{width: fs * 2.4 - 4, flex: 'none', textAlign: 'right', paddingRight: fs * 1.1, color: APP.lineNo}}>15</div>
                <div style={{flex: 1, paddingRight: 40}}>
                  In the oven, the water inside the loaf turn<Ins p={a2}>s</Ins> to steam and the crust brown<Ins p={a2}>s</Ins> through the Maillard reaction. <b>*Timing matter<Ins p={a2}>s</Ins> more than temperature*</b>.
                </div>
              </div>
            </div>
            <div
              style={{
                position: 'absolute',
                left: '50%',
                bottom: 26,
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                padding: '10px 14px 10px 22px',
                borderRadius: 10,
                background: '#252526',
                border: `1px solid ${done > 0.5 ? 'rgba(137,209,133,0.5)' : APP.widget}`,
                boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
                fontFamily: SANS,
                fontSize: 20,
                color: APP.fg,
                whiteSpace: 'nowrap',
              }}
            >
              {done > 0.5 ? (
                <span style={{display: 'flex', alignItems: 'center', gap: 10, color: APP.ok, padding: '8px 10px', transform: `scale(${pop(f, click2 + 18, 10)})`}}>
                  <Icon name="check" size={22} color={APP.ok} stroke={3} /> All changes reviewed
                </span>
              ) : (
                <>
                  <span style={{color: APP.muted}}>⌃</span>
                  <span>{a1 > 0.5 ? '1 of 1' : '1 of 2'}</span>
                  <span style={{color: APP.muted}}>⌄</span>
                  <span style={{width: 1, height: 24, background: APP.widget}} />
                  <span>✎ Edit text</span>
                  <span>↶ Reject all</span>
                  <Btn size={20} primary glow={tw(f, click2 - 8, click2 - 2)}>
                    ✓ Accept all
                  </Btn>
                </>
              )}
            </div>
          </Pane>
        </div>
      </div>
      <Cursor
        path={[
          {f: click1 - 30, x: 1760, y: 1100},
          {f: click1 - 4, x: 1586, y: 416},
          {f: click2 - 26, x: 1586, y: 416},
          {f: click2 - 3, x: 1165, y: 888},
          {f: click2 + 40, x: 1560, y: 1180},
        ]}
        clicks={[click1, click2]}
      />
      {[
        {icon: 'sparkle', text: 'Edit a change before you accept it', x: 250, at: t(2, 'edit it first')},
        {icon: 'undo', text: 'Undo a whole turn in one click', x: 990, at: t(3, 'undo')},
      ].map((c) => {
        const s = pop(f, c.at, 14);
        return (
          <div key={c.text} style={{position: 'absolute', left: c.x, top: 968, width: 680, display: 'flex', alignItems: 'center', gap: 16, fontFamily: SANS, fontSize: 30, color: C.text, opacity: Math.min(1, s * 2), transform: `translateY(${(1 - s) * 30}px)`}}>
            <span style={{width: 52, height: 52, borderRadius: 14, background: 'rgba(91,140,255,0.15)', border: '1px solid rgba(91,140,255,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
              <Icon name={c.icon} size={26} color={C.accent} />
            </span>
            {c.text}
          </div>
        );
      })}
      <Sfx at={click1 + 3} src="pop.mp3" volume={0.3} />
      <Sfx at={click2 + 18} src="pop.mp3" volume={0.35} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Cmd+K

const KEEP = 'Bread is one of the oldest foods humans have made. ';
const SEL = 'Every single loaf of bread that anyone has ever baked starts out with the very same four basic ingredients.';
const NEW = 'Every loaf starts with the same four ingredients.';
const PROMPT = 'Shorter, keep the meaning';

export const CmdK: React.FC<SceneProps> = ({t, e}) => {
  const f = useCurrentFrame();
  const card = tw(f, 0, 28);
  const selAt = t(0, 'select it');
  const sel = Math.floor(SEL.length * tw(f, selAt, selAt + 20, IN_OUT));
  const keysAt = t(0, 'press') - 8;
  const pressCmd = t(0, 'Command') + 4;
  const pressK = e(0) - 8;
  const keysOut = tw(f, e(0) + 6, e(0) + 18, EASE_IN);
  const boxAt = e(0) + 8;
  const enterAt = Math.max(typedEnd(PROMPT, t(1) + 2, 36) + 6, t(1, 'The agent') - 2);
  const box = pop(f, boxAt, 14) * (1 - tw(f, enterAt + 6, enterAt + 14, EASE_IN));
  const strike = tw(f, enterAt + 10, enterAt + 22, IN_OUT);
  const neu = typed(NEW, f, enterAt + 22, 80);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 96, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
        <Kicker at={0} color={C.blue}>
          ⌘K on a selection
        </Kicker>
        <div style={{marginTop: 24}}>
          <Rich text="Edit just *the part you select.*" size={88} align="center" at={4} stagger={3} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 260, top: 320, width: 1400, height: 500, perspective: 2000}}>
        <div style={{position: 'absolute', inset: 0, transform: `translateY(${(1 - card) * 360}px) rotateX(${(1 - card) * 24}deg)`, opacity: card}}>
          <Pane title="main.typ" size={18} style={{inset: 0}} bodyStyle={{padding: '30px 40px 0 0'}}>
            <Editor
              size={30}
              from={7}
              active={7}
              lines={[
                <>
                  {KEEP}
                  {strike > 0 ? (
                    <span style={{background: `rgba(255,40,40,${0.32 * strike})`, color: strike > 0.5 ? '#bdbdbd' : undefined, textDecoration: strike > 0.4 ? 'line-through' : undefined}}>{SEL}</span>
                  ) : (
                    <>
                      <span style={{background: APP.selection}}>{SEL.slice(0, sel)}</span>
                      {SEL.slice(sel)}
                    </>
                  )}
                  {neu ? <span style={{background: APP.ins, marginLeft: 12}}>{neu}</span> : null}
                </>,
              ]}
            />
            <div
              style={{
                position: 'absolute',
                left: 100,
                top: 250,
                width: 820,
                transform: `scale(${box})`,
                transformOrigin: '10% 0%',
                opacity: Math.min(1, box * 2),
                background: '#252526',
                border: `1px solid ${APP.btn}`,
                borderRadius: 10,
                boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
                padding: '16px 20px',
                fontFamily: SANS,
              }}
            >
              <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 28, color: APP.strong}}>
                <Icon name="sparkle" size={26} color={C.accent} />
                {typed(PROMPT, f, t(1) + 2, 36)}
                <Caret h={30} solid={f < enterAt - 4} />
              </div>
              <div style={{marginTop: 10, fontSize: 18, color: APP.muted, textAlign: 'right'}}>Enter to send · Esc to close</div>
            </div>
          </Pane>
        </div>
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 380, display: 'flex', justifyContent: 'center', gap: 34, opacity: 1 - keysOut, transform: `scale(${1 - keysOut * 0.3})`}}>
        <div style={{position: 'absolute', left: 560, right: 560, top: -80, bottom: -100, background: 'radial-gradient(ellipse at center, rgba(6,7,9,0.8), transparent 70%)'}} />
        <Keycap label="⌘" at={keysAt} press={[pressCmd]} size={210} />
        <Keycap label="K" at={keysAt + 5} press={[pressK]} size={210} />
      </div>
      <div style={{position: 'absolute', left: 960 + 300, top: 660, transform: `scale(${1 - tw(f, enterAt + 6, enterAt + 14)})`}}>
        <Keycap label="↵ Enter" at={boxAt + 12} press={[enterAt]} size={86} w={220} font={30} />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 880}}>
        <Body at={enterAt + 24} style={{textAlign: 'center', fontSize: 30}}>
          The agent changes only that part. You review it like any other change.
        </Body>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- Autocomplete

const TYPED = 'A baker who waits longer is rewarded with more flavour,';
const GHOST = ' because slow fermentation gives the bacteria time to make acids.';

export const Autocomplete: React.FC<SceneProps> = ({t}) => {
  const f = useCurrentFrame();
  const t0 = typed(TYPED, f, 6, 40);
  const doneAt = typedEnd(TYPED, 6, 40);
  const ghostAt = Math.max(doneAt + 14, t(0, 'grey') - 2);
  const ghost = tw(f, ghostAt, ghostAt + 14);
  const tabAt = t(1, 'Tab') + 2;
  const accepted = Math.floor(GHOST.length * tw(f, tabAt + 2, tabAt + 16, IN_OUT));
  const strip = tw(f, 0, 26);
  const thinking = f > doneAt && f < ghostAt;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 0, right: 0, top: 110, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
        <Kicker at={0} color={C.green}>
          Autocomplete
        </Kicker>
        <div style={{marginTop: 26}}>
          <Rich text="Pause. *Press Tab.*" size={120} align="center" at={4} stagger={4} />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 200,
          top: 400,
          width: 1520,
          height: 270,
          borderRadius: 22,
          background: APP.editor,
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 50px 120px rgba(0,0,0,0.6)',
          transform: `translateY(${(1 - strip) * 120}px) scale(${0.94 + 0.06 * strip})`,
          opacity: strip,
          padding: '36px 46px 0 0',
        }}
      >
        <Editor
          size={40}
          lh={1.55}
          from={12}
          active={12}
          lines={[
            <>
              {t0}
              {accepted > 0 ? <span style={{color: APP.strong}}>{GHOST.slice(0, accepted)}</span> : null}
              {f < tabAt ? <Caret h={46} solid={f < doneAt} /> : null}
              {thinking ? <span style={{color: APP.muted, marginLeft: 10}}>{'.'.repeat(1 + (Math.floor(f / 4) % 3))}</span> : null}
              <span style={{color: '#7b7b7b', opacity: ghost, fontStyle: 'italic'}}>{GHOST.slice(accepted)}</span>
              {f >= tabAt ? <Caret h={46} /> : null}
            </>,
          ]}
        />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 740, display: 'flex', justifyContent: 'center'}}>
        <Keycap label="Tab ⇥" at={t(1) - 4} press={[tabAt]} size={110} w={260} font={38} />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 920}}>
        <Body at={ghostAt + 10} style={{textAlign: 'center'}}>
          Grey text suggests how the sentence goes on. Turn it off when you want quiet.
        </Body>
      </div>
    </AbsoluteFill>
  );
};
