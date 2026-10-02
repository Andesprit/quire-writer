// Where every scene and every spoken line falls, from the script and the length of each clip.
// Plain TypeScript so that scripts/captions.ts can run it with node as well.

export type Beat = {id: string; text: string; say?: string; pause?: number};
export type SceneSpec = {key: string; lead: number; tail: number; beats: Beat[]};
export type Script = {scenes: SceneSpec[]};
export type Voice = Record<string, {seconds: number}>;
export type Placed = {key: string; from: number; dur: number; cues: number[]; ends: number[]; beats: Beat[]};

export const FPS = 30;
export const GAP = 6; // frames of silence between two lines of one scene
export const OVERLAP = 10; // frames in which one scene leaves while the next comes in

export const buildTimeline = (script: Script, voice: Voice) => {
  let from = 0;
  const scenes: Placed[] = script.scenes.map((s) => {
    const cues: number[] = [];
    const ends: number[] = [];
    let t = s.lead;
    s.beats.forEach((b, i) => {
      t += (i > 0 ? GAP : 0) + (b.pause ?? 0);
      cues.push(t);
      t += Math.ceil(voice[b.id].seconds * FPS);
      ends.push(t);
    });
    const placed = {key: s.key, from, dur: t + s.tail, cues, ends, beats: s.beats};
    from += placed.dur - OVERLAP;
    return placed;
  });
  return {scenes, total: from + OVERLAP};
};

/** The frame, within its scene, at which `phrase` is said in line i, guessed from where it sits in the text. */
export const phraseAt = (p: Placed, i: number, phrase?: string) => {
  if (!phrase) return p.cues[i];
  const text = p.beats[i].say ?? p.beats[i].text;
  const k = text.indexOf(phrase);
  if (k < 0) throw new Error(`"${phrase}" is not in line ${p.beats[i].id}`);
  return Math.round(p.cues[i] + (p.ends[i] - p.cues[i]) * (k / text.length));
};
