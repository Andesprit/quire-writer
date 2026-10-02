import React from 'react';
import {Icon} from './lib';
import {APP, MONO, PAPER, SANS} from './theme';

// Pieces of the Quire window in VS Code Dark Modern, drawn the way the app draws them.

const TOKEN = /(#[a-z]+|"[^"]*"?|\$[^$]*\$?|<[a-z-]+>|@[a-z0-9-]+|\*[^*]+\*?)/g;

/** Typst syntax colours, as the app's highlighter gives them. */
export const hl = (line: string): React.ReactNode => {
  if (/^=+ /.test(line)) return <span style={{color: APP.heading, fontWeight: 600}}>{line}</span>;
  return line.split(TOKEN).map((t, i) => {
    if (!t) return null;
    const color = t[0] === '#' ? APP.keyword : t[0] === '"' ? APP.string : t[0] === '$' ? APP.math : t[0] === '<' || t[0] === '@' ? APP.label : undefined;
    return (
      <span key={i} style={{color, fontWeight: t[0] === '*' ? 700 : undefined}}>
        {t}
      </span>
    );
  });
};

export type Line = React.ReactNode | {raw: React.ReactNode};
const isRaw = (l: Line): l is {raw: React.ReactNode} => typeof l === 'object' && l !== null && 'raw' in (l as object);

/** Editor text with line numbers. `{raw}` entries take the full width and no number. */
export const Editor: React.FC<{lines: Line[]; from?: number; size?: number; lh?: number; active?: number; style?: React.CSSProperties}> = ({lines, from = 1, size = 22, lh = 1.62, active, style}) => {
  let n = from - 1;
  return (
    <div style={{fontFamily: MONO, fontSize: size, lineHeight: lh, color: APP.fg, ...style}}>
      {lines.map((l, i) => {
        if (isRaw(l)) return <div key={i}>{l.raw}</div>;
        n++;
        return (
          <div key={i} style={{display: 'flex', background: n === active ? 'rgba(255,255,255,0.035)' : undefined}}>
            <div style={{width: size * 2.4, flex: 'none', textAlign: 'right', paddingRight: size * 1.1, color: n === active ? APP.strong : APP.lineNo}}>{n}</div>
            <div style={{flex: 1, whiteSpace: 'pre-wrap', minHeight: size * lh}}>{l}</div>
          </div>
        );
      })}
    </div>
  );
};

/** A pane of the app: a tab strip on top, then the body. */
export const Pane: React.FC<{
  title: string;
  icon?: string;
  iconColor?: string;
  right?: React.ReactNode;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
  size?: number;
  children?: React.ReactNode;
}> = ({title, icon = 'file', iconColor = APP.typ, right, style, bodyStyle, size = 17, children}) => (
  <div style={{position: 'absolute', display: 'flex', flexDirection: 'column', background: APP.editor, borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 50px 120px rgba(0,0,0,0.6)', ...style}}>
    <div style={{height: size * 2.6, flex: 'none', display: 'flex', alignItems: 'stretch', background: APP.chrome, borderBottom: `1px solid ${APP.border}`, fontFamily: SANS, fontSize: size, color: APP.fg}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 9, padding: `0 ${size * 1.1}px`, background: APP.editor, borderTop: `2px solid ${APP.btn}`, color: APP.strong}}>
        <Icon name={icon} size={size * 1.05} color={iconColor} />
        {title}
      </div>
      <div style={{flex: 1}} />
      {right}
    </div>
    <div style={{flex: 1, position: 'relative', overflow: 'hidden', ...bodyStyle}}>{children}</div>
  </div>
);

export const Btn: React.FC<{primary?: boolean; size?: number; glow?: number; children: React.ReactNode; style?: React.CSSProperties}> = ({primary, size = 16, glow = 0, children, style}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: SANS,
      fontSize: size,
      padding: `${size * 0.32}px ${size * 0.7}px`,
      borderRadius: 4,
      background: primary ? APP.btn : APP.btn2,
      color: '#fff',
      boxShadow: glow ? `0 0 ${24 * glow}px ${APP.btn}` : undefined,
      ...style,
    }}
  >
    {children}
  </span>
);

export const RateEq: React.FC = () => (
  <span>
    <i>r</i>(<i>T</i>) = <i>r</i>
    <sub>0</sub> · 2
    <sup>
      (<i>T</i> − <i>T</i>
      <sub>0</sub>)/10
    </sup>
  </span>
);

/** The finished page, as the preview shows it. */
export const PaperPage: React.FC<{style?: React.CSSProperties; children: React.ReactNode}> = ({style, children}) => (
  <div style={{background: '#fff', color: '#111', fontFamily: PAPER, boxShadow: '0 10px 40px rgba(0,0,0,0.45)', ...style}}>{children}</div>
);

const BREAD = [
  '#set page(paper: "a4", margin: 2.5cm)',
  '#set text(font: "New Computer Modern", size: 11pt)',
  '#set par(justify: true)',
  '',
  '= The Quiet Science of Bread',
  '',
  'Bread is one of the oldest foods humans have made. Every loaf starts with the same four ingredients: flour, water, salt, and yeast.',
  '',
  '== Fermentation',
  '',
  'When yeast eats the sugars in flour, it releases carbon dioxide and alcohol. The gas gets trapped in a web of gluten, and the dough rises.',
  '',
  'The rate of fermentation roughly doubles for every ten degrees of warmth: $r(T) = r_0 dot 2^((T - T_0) / 10)$.',
  '',
  '== Baking',
];

const ins = (s: string) => <span style={{background: APP.ins}}>{s}</span>;

/** The whole window, at 1600 x 960. */
export const AppWindow: React.FC = () => {
  const fs = 14;
  const side = {fontFamily: SANS, fontSize: 12.5, color: APP.fg} as const;
  return (
    <div style={{width: 1600, height: 960, background: APP.chrome, borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.12)', fontFamily: SANS}}>
      <div style={{height: 40, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: `1px solid ${APP.border}`, color: APP.muted, fontSize: 13}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <span key={c} style={{width: 12, height: 12, borderRadius: 12, background: c, marginRight: 8}} />
        ))}
        <span style={{marginLeft: 14, color: APP.strong, fontWeight: 600}}>Quire</span>
        <span style={{flex: 1, textAlign: 'center'}}>main.typ — bread-paper</span>
        <span style={{width: 120}} />
      </div>
      <div style={{flex: 1, display: 'flex', minHeight: 0}}>
        <div style={{width: 50, borderRight: `1px solid ${APP.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, paddingTop: 14, color: APP.muted}}>
          <Icon name="copy" size={22} color={APP.strong} />
          <Icon name="chat" size={22} />
        </div>
        <div style={{width: 230, borderRight: `1px solid ${APP.border}`, padding: '12px 0', ...side}}>
          <div style={{padding: '0 18px 10px', fontSize: 11, letterSpacing: '0.08em', color: APP.muted}}>EXPLORER</div>
          <div style={{padding: '3px 12px', fontWeight: 700, fontSize: 11, letterSpacing: '0.05em'}}>⌄ BREAD-PAPER</div>
          <div style={{padding: '3px 26px'}}>› chapters</div>
          <div style={{padding: '3px 26px', background: '#37373d', display: 'flex', gap: 6, alignItems: 'center'}}>
            <Icon name="file" size={13} color={APP.typ} /> main.typ
          </div>
          <div style={{padding: '3px 26px', display: 'flex', gap: 6, alignItems: 'center'}}>
            <Icon name="book" size={13} color={APP.bib} /> refs.bib
          </div>
          <div style={{marginTop: 600, padding: '3px 12px', fontWeight: 700, fontSize: 11, letterSpacing: '0.05em', display: 'flex'}}>
            ⌄ LABELS<span style={{marginLeft: 'auto', fontWeight: 400, color: APP.muted}}>1 unused</span>
          </div>
          <div style={{padding: '3px 26px', display: 'flex'}}>
            timeline<span style={{marginLeft: 'auto', color: APP.muted}}>1 use</span>
          </div>
          <div style={{padding: '3px 26px', display: 'flex'}}>
            eq-rate<span style={{marginLeft: 'auto', color: '#cca700'}}>unused</span>
          </div>
        </div>
        <div style={{flex: 1, display: 'flex', flexDirection: 'column', background: APP.editor, minWidth: 0}}>
          <div style={{height: 36, display: 'flex', background: APP.chrome, borderBottom: `1px solid ${APP.border}`, fontSize: 13}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', background: APP.editor, borderTop: `2px solid ${APP.btn}`, color: APP.strong}}>
              <Icon name="file" size={14} color={APP.typ} /> main.typ
            </div>
          </div>
          <div style={{height: 32, display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px', color: APP.muted, fontSize: 13, borderBottom: `1px solid ${APP.border}`}}>
            <span>Text ⌄</span>
            <b>B</b>
            <i>I</i>
            <span>{'</>'}</span>
            <span>∑</span>
            <span>≡</span>
            <span>⊞</span>
            <span>@</span>
          </div>
          <div style={{padding: '6px 16px', color: APP.muted, fontSize: 12.5}}>bread-paper › main.typ</div>
          <Editor size={fs} lh={1.7} lines={[...BREAD.map(hl)]} active={13} style={{paddingTop: 4, paddingRight: 18}} />
          <div style={{margin: '8px 16px 0 54px', fontFamily: SANS, fontSize: 12, color: APP.muted, display: 'flex', alignItems: 'center', gap: 8}}>
            Change 1 of 1<span style={{flex: 1}} />
            <Btn size={12}>↶ Reject</Btn>
            <Btn size={12} primary>
              ✓ Accept
            </Btn>
          </div>
          <div style={{fontFamily: MONO, fontSize: fs, lineHeight: 1.7, color: APP.fg, padding: '4px 18px 0 54px', borderLeft: `3px solid ${APP.btn}`, marginLeft: 40}}>
            In the oven, the water inside the loaf turn{ins('s')} to steam and the crust brown{ins('s')} through the Maillard reaction.
          </div>
        </div>
        <div style={{width: 430, borderLeft: `1px solid ${APP.border}`, display: 'flex', flexDirection: 'column', background: '#2a2a2a'}}>
          <div style={{height: 36, display: 'flex', background: APP.chrome, borderBottom: `1px solid ${APP.border}`, fontSize: 13}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', background: APP.editor, color: APP.strong}}>
              <Icon name="book" size={14} color={APP.muted} /> Preview main.typ
            </div>
          </div>
          <PaperPage style={{margin: 18, padding: '34px 34px', height: 620, fontSize: 10.5, lineHeight: 1.45}}>
            <div style={{fontSize: 17, fontWeight: 700, marginBottom: 8}}>The Quiet Science of Bread</div>
            <p style={{margin: '0 0 8px', textAlign: 'justify'}}>Bread is one of the oldest foods humans have made. Every loaf starts with the same four ingredients: flour, water, salt, and yeast.</p>
            <div style={{fontSize: 12.5, fontWeight: 700, margin: '10px 0 5px'}}>Fermentation</div>
            <p style={{margin: '0 0 8px', textAlign: 'justify'}}>When yeast eats the sugars in flour, it releases carbon dioxide and alcohol. The gas gets trapped in a web of gluten, and the dough rises.</p>
            <p style={{margin: '0 0 8px', textAlign: 'justify'}}>
              The rate of fermentation roughly doubles for every ten degrees of warmth: <RateEq />.
            </p>
            <div style={{fontSize: 12.5, fontWeight: 700, margin: '10px 0 5px'}}>Baking</div>
            <p style={{margin: '0 0 12px', textAlign: 'justify'}}>In the oven, the water inside the loaf turns to steam and the crust browns through the Maillard reaction.</p>
            <table style={{margin: '0 auto', borderCollapse: 'collapse', fontSize: 10}}>
              <tbody>
                {[
                  ['Stage', 'Time'],
                  ['Mixing', '10 min'],
                  ['Rising', '2 hours'],
                  ['Baking', '40 min'],
                ].map((r) => (
                  <tr key={r[0]}>
                    {r.map((c) => (
                      <td key={c} style={{border: '0.8px solid #333', padding: '2px 10px'}}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{textAlign: 'center', marginTop: 6, fontSize: 9.5}}>Table 1: A simple timeline for a country loaf.</div>
          </PaperPage>
        </div>
        <div style={{width: 360, borderLeft: `1px solid ${APP.border}`, display: 'flex', flexDirection: 'column', padding: '12px 16px', fontSize: 13.5, color: APP.fg, lineHeight: 1.5}}>
          <div style={{fontSize: 11, letterSpacing: '0.08em', color: APP.muted, marginBottom: 12}}>CHAT</div>
          <div style={{background: '#2b2b2b', borderRadius: 6, padding: '10px 12px', color: APP.strong}}>Fix the grammar in the Baking section. Keep my wording.</div>
          <div style={{marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6, color: APP.muted}}>
            <span>✓ Read the Baking section</span>
            <span>✓ Fix subject and verb agreement</span>
            <span style={{color: APP.strong}}>● Wait for your review</span>
          </div>
          <div style={{marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', color: APP.muted}}>
            ✎ Edit main.typ<span style={{marginLeft: 'auto', color: APP.ok}}>✓</span>
          </div>
          <div style={{marginTop: 10}}>
            Three verbs did not agree with their subject: <i>turn</i>, <i>brown</i> and <i>matter</i>. I changed only those words.
          </div>
          <div style={{flex: 1}} />
          <div style={{border: `1px solid ${APP.widget}`, borderRadius: 6, padding: 10, background: '#252526'}}>
            <span style={{fontSize: 11.5, border: `1px solid ${APP.widget}`, borderRadius: 3, padding: '1px 6px', color: APP.muted}}>main.typ</span>
            <div style={{color: '#8b8b8b', margin: '10px 0 28px'}}>Ask the agent to write or change something</div>
            <div style={{display: 'flex', gap: 14, color: APP.muted, fontSize: 12.5}}>
              <span>Claude Agent ⌄</span>
              <span>Mode: Auto</span>
              <span>Effort: High</span>
            </div>
          </div>
        </div>
      </div>
      <div style={{height: 26, display: 'flex', alignItems: 'center', gap: 22, padding: '0 14px', borderTop: `1px solid ${APP.border}`, fontSize: 12, color: APP.muted}}>
        <span>✦ Claude Agent</span>
        <span>1 change to review</span>
        <span style={{flex: 1}} />
        <span>Ln 15, Col 11</span>
        <span>189 words</span>
        <span>Typst</span>
        <span>Auto save</span>
        <span>Autocomplete</span>
      </div>
    </div>
  );
};
