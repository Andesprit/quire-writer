// Writes out/quire.vtt, the narration as captions for the site's video. Run: node scripts/captions.ts
import {readFileSync, writeFileSync} from 'node:fs';
import {buildTimeline, FPS, type Script, type Voice} from '../src/timeline.ts';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const {scenes} = buildTimeline(read('../src/script.json') as Script, read('../src/voice.json') as Voice);

const stamp = (frame: number) => {
  const ms = Math.round((frame / FPS) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

const cues = scenes.flatMap((s) => s.beats.map((b, i) => `${stamp(s.from + s.cues[i])} --> ${stamp(s.from + s.ends[i])}\n${b.text}`));
writeFileSync(new URL('../out/quire.vtt', import.meta.url), `WEBVTT\n\n${cues.join('\n\n')}\n`);
console.log(`${cues.length} captions`);
