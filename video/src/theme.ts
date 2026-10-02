import {loadFont as loadGeist} from '@remotion/google-fonts/Geist';
import {loadFont as loadMono} from '@remotion/google-fonts/GeistMono';
import {loadFont as loadSerif} from '@remotion/google-fonts/InstrumentSerif';
import {loadFont as loadPaper} from '@remotion/google-fonts/SourceSerif4';

export const SANS = loadGeist('normal', {weights: ['400', '500', '600', '700', '800'], subsets: ['latin']}).fontFamily;
export const MONO = loadMono('normal', {weights: ['400', '500'], subsets: ['latin']}).fontFamily;
export const SERIF = loadSerif('italic', {weights: ['400'], subsets: ['latin']}).fontFamily;
export const PAPER = loadPaper('normal', {weights: ['400', '600', '700'], subsets: ['latin']}).fontFamily;
loadPaper('italic', {weights: ['400'], subsets: ['latin']});

export {FPS} from './timeline';

// The video's own palette. The four series colours are the app's colours for Typst, LaTeX,
// Quarto and Markdown, lifted so they glow on black.
export const C = {
  bg: '#060709',
  text: '#f4f4f6',
  muted: '#a3a3ad',
  dim: '#62626c',
  line: 'rgba(255,255,255,0.09)',
  glass: 'rgba(19,20,25,0.82)',
  blue: '#5b8cff',
  green: '#3fbf74',
  pink: '#e2559c',
  orange: '#f27a3d',
  accent: '#9db8ff',
  ok: '#4ade80',
  bad: '#f87171',
};

// VS Code Dark Modern, as the app uses it (web/style.css).
export const APP = {
  chrome: '#181818',
  editor: '#1f1f1f',
  border: '#2b2b2b',
  widget: '#313131',
  fg: '#cccccc',
  strong: '#e7e7e7',
  muted: '#9d9d9d',
  btn: '#0078d4',
  btn2: '#313131',
  selection: '#264f78',
  lineNo: '#6e7681',
  ins: 'rgba(156,204,44,0.32)',
  del: 'rgba(255,40,40,0.34)',
  keyword: '#c586c0',
  string: '#ce9178',
  math: '#b5cea8',
  heading: '#569cd6',
  label: '#4fc1ff',
  typ: '#3dafbd',
  bib: '#d4a15a',
  ok: '#89d185',
};
