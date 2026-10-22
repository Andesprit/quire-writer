import type { Lang } from "./highlight.ts"

// Markup that is not words: comments, math, code and commands.
const NOT_WORDS: Record<Lang, RegExp[]> = {
  typst: [/\/\/.*$/gm, /\$[^$]*\$/g, /#[a-zA-Z_][\w.-]*/g],
  latex: [/(?<!\\)%.*$/gm, /\$[^$]*\$/g, /\\[a-zA-Z@]+\*?/g],
  quarto: [/<!--[\s\S]*?-->/g, /```[\s\S]*?```/g, /\$[^$]*\$/g, /\{[^}]*\}/g],
  markdown: [/<!--[\s\S]*?-->/g, /```[\s\S]*?```/g, /\$[^$]*\$/g],
  text: [],
}
export const countWords = (lang: Lang, s: string) =>
  (NOT_WORDS[lang].reduce((t, r) => t.replace(r, " "), s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
