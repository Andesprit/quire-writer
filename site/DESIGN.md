---
name: Quire Writer website
description: The night stage from the Quire video, lit in the colours of Typst, LaTeX, Quarto and Markdown, with the app itself shown in VS Code Dark Modern.
colors:
  bg: "#060709"
  raised: "#0c0d11"
  line: "rgb(255 255 255 / 0.09)"
  line-2: "rgb(255 255 255 / 0.16)"
  text: "#f4f4f6"
  muted: "#a8a8b3"
  faint: "#8c8c97"
  accent: "#9db8ff"
  cta-top: "#3f6cf0"
  cta-bottom: "#2a52d6"
  blue: "#5b8cff"
  green: "#3fbf74"
  pink: "#e2559c"
  orange: "#f27a3d"
  ok: "#4ade80"
  app-chrome: "#181818"
  app-editor: "#1f1f1f"
  app-border: "#2b2b2b"
  app-widget: "#313131"
  app-fg: "#cccccc"
  app-strong: "#e7e7e7"
  app-muted: "#9d9d9d"
  app-btn: "#0078d4"
  app-sel: "#264f78"
  app-lineno: "#6e7681"
  ins: "rgb(156 204 44 / 0.3)"
  del: "rgb(255 40 40 / 0.32)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(42px, 6vw, 82px)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "clamp(34px, 4.8vw, 64px)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  landing:
    fontFamily: "Instrument Serif, Iowan Old Style, Georgia, serif"
    fontSize: "1.1em"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  title-sm:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body-lg:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "16.5px"
    fontWeight: 400
    lineHeight: 1.6
  fine:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1
  button:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1
  mono:
    fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  app: "4px"
  key: "10px"
  panel: "12px"
  frame: "18px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 4vw, 40px)"
  section: "clamp(88px, 11vw, 150px)"
  block: "56px"
  lead: "18px"
components:
  button-primary:
    backgroundColor: "{colors.cta-bottom}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "15px 24px"
  button-primary-compact:
    backgroundColor: "{colors.cta-bottom}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "rgb(255 255 255 / 0.04)"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "15px 24px"
  button-ghost-hover:
    backgroundColor: "rgb(255 255 255 / 0.08)"
  nav-link:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "9px 12px"
  nav-link-hover:
    backgroundColor: "rgb(255 255 255 / 0.06)"
    textColor: "{colors.text}"
  top-bar:
    backgroundColor: "rgb(6 7 9 / 0.7)"
    height: "66px"
  format-pill:
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "8px 15px"
  status-pill:
    backgroundColor: "rgb(74 222 128 / 0.08)"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
  toggle:
    backgroundColor: "rgb(255 255 255 / 0.03)"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  toggle-pressed:
    backgroundColor: "{colors.text}"
    textColor: "#0b0b0f"
  keycap:
    backgroundColor: "#22242a"
    textColor: "#ececf1"
    rounded: "{rounded.key}"
    height: "40px"
    padding: "0 12px"
  code-block:
    backgroundColor: "{colors.app-editor}"
    textColor: "{colors.app-fg}"
    typography: "{typography.mono}"
    rounded: "{rounded.key}"
    padding: "16px 18px"
  app-button-primary:
    backgroundColor: "{colors.app-btn}"
    textColor: "#ffffff"
    rounded: "{rounded.app}"
    padding: "6px 12px"
  app-button-primary-hover:
    backgroundColor: "#026ec1"
  app-button-secondary:
    backgroundColor: "{colors.app-widget}"
    textColor: "#ffffff"
    rounded: "{rounded.app}"
    padding: "6px 12px"
---

# Design System: Quire Writer website

This file covers the website in `site/` only. The desktop app has its own, different visual system (VS Code-style layout and its colour themes), which lives in `web/style.css` and `web/themes.css`. The site quotes the app in one theme only, VS Code Dark Modern; the `app-*` colours below are a copy of the app's Dark Modern values, kept for the demo panes, samples and code blocks. When the app changes, take new values from `web/style.css`; do not invent them here.

## Overview

**Creative North Star: "The Night Stage"**

The site continues the Quire video. The visitor arrives on the same dark stage: a near-black night, lit from its four corners by large, slow, blurred lights in the colours the app gives Typst, LaTeX, Quarto and Markdown, over a faint 96px grid that fades out toward the edges, under a soft vignette. The stage is fixed; the page scrolls over it. On that stage the page itself is quiet: one sans for every word, one italic serif phrase in periwinkle at the end of each heading, hairlines instead of boxes, and pill-shaped controls.

The app is the only object with a frame. The film, the live review demo, the samples of the three ways to ask, the theme screenshots and the code blocks are all drawn as Quire itself, in VS Code Dark Modern. They are the only rounded, bordered, shadowed rectangles on the page, so a frame always means "this is the app or what it makes". The page proves its promise inside one of those frames: the visitor reviews the agent's edits in a working copy of the app.

Density is low and the rhythm is long. Each section opens with a large two-part headline and a muted sub line, then its content sits in rows ruled by hairlines. Motion is slow and ambient on the stage (lights drift, the agent registry streams past) and happens once in the hero (lines rise in order, and the film lies down flat as it scrolls into view, the way the window rises in the video). The direction refused a light screenshot hero over a grid of feature cards.

**Key Characteristics:**
- A near-black stage lit by four document-colour lights over a fading grid.
- Geist for every word; Instrument Serif italic only for the phrase each heading lands on.
- Rows ruled by 9% white hairlines, never feature cards.
- Frames are reserved for the app, quoted faithfully in VS Code Dark Modern.
- A blue gradient pill for the one main action; every other control is a quiet translucent pill.
- 3D keycaps for shortcuts.

## Colors

A near-black neutral stage, one cool periwinkle voice for type accents, four document hues used as light rather than paint, and a quoted Dark Modern palette that stays inside the app frames.

### Primary
- **Periwinkle** (#9db8ff): the landing phrase of every h1 and h2, links (underline at 50% of this colour, full colour on hover), the focus ring (2px, offset 3px) and the text caret. 10.3:1 on the stage.
- **Download Blue** (gradient from #3f6cf0 to #2a52d6, top to bottom): the fill of the main action button only, with a soft glow in the same blue. Nothing else on the page uses this gradient.

### Secondary
The four document lights. Each one is the colour the app gives a kind of document, and each lights one corner of the stage.
- **Typst Blue** (#5b8cff): stage light top left; the Typst pill and dot; the text selection tint (38%); the tint and side borders of the Quire column in the comparison table; the film's halo.
- **LaTeX Green** (#3fbf74): stage light bottom right; the LaTeX pill and dot.
- **Quarto Pink** (#e2559c): stage light top right; the Quarto pill and dot; the second colour of the film's halo; the marker dot of the note to Claude Code users.
- **Markdown Orange** (#f27a3d): stage light bottom left, at 80% opacity; the Markdown pill and dot.

In the demo, the active file tab carries a 2px top stripe in the hue of the open kind of document; switching the file switches the stripe.

### Tertiary
- **Signal Green** (#4ade80): yes marks in the comparison and the check icons in the status pills. Always on its own tint (8 to 14%) with a border at 28 to 40%, never as a bare fill.

### Neutral
- **Night Stage** (#060709): the page background and the browser theme colour.
- **Raised Band** (#0c0d11): the one tonal step above the stage, used at 75% opacity for the full-width privacy band.
- **Hairline** (rgb(255 255 255 / 0.09)): every row rule, the top bar's bottom edge, the footer's top edge, borders of quiet pills.
- **Strong Hairline** (rgb(255 255 255 / 0.16)): the edge of app frames and of ghost buttons and toggles.
- **Stage Text** (#f4f4f6): headings, strong words, active controls. 18.4:1.
- **Muted** (#a8a8b3): sub lines, body paragraphs in rows, nav links at rest. 8.6:1.
- **Faint** (#8c8c97): fine print, captions, footnotes, footer text, the format list next to the brand. 6.1:1. This is the lowest text colour on the stage.

### App quote (VS Code Dark Modern)
These belong to the app, not to the stage. They appear only inside app frames and code blocks.
- **App Chrome** (#181818): title bar and status bar of the demo window.
- **App Editor** (#1f1f1f): editor surface of the demo, the samples and every code block.
- **App Border** (#2b2b2b): pane dividers and code block edges.
- **App Widget** (#313131): secondary app buttons and chip borders.
- **App Foreground** (#cccccc), **App Strong** (#e7e7e7), **App Muted** (#9d9d9d), **Line Number** (#6e7681): the app's text levels.
- **App Button Blue** (#0078d4): the app's primary buttons (Accept, Accept all, Send) and the ring around the current change. Hover is #026ec1.
- **App Selection** (#264f78): selected text in the Cmd+K sample.
- **Insert Tint** (rgb(156 204 44 / 0.3)) and **Delete Tint** (rgb(255 40 40 / 0.32)): the agent's changes in the editor, with white inserted text and struck, pink-grey deleted text.

### Named Rules
**The Four Lights Rule.** The stage has exactly four colours of light, and they are the app's colours for Typst, LaTeX, Quarto and Markdown. Where a hue marks a kind of document, it is always that kind's hue. The hues appear as light: radial glows, small glowing dots, tints near 10% with borders near 45%. Never as a flat panel fill and never for running text.

**The Periwinkle Voice Rule.** Periwinkle is the only colour for type accents: the landing phrase, links and focus. One phrase per heading; its rarity is the point.

**The App Stays in Its Frame Rule.** The `app-*` colours never leave an app frame or a code block, and the stage never borrows them. The stage's lights stay out of the app frame too, with two exceptions the demo needs: the series stripe on the active file tab, which mirrors what the app itself does, and the Typst Blue mark (22%) on words still waiting for review in the preview.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui, -apple-system, sans-serif), self-hosted variable, weights 400 to 800.
**Body Font:** Geist, the same face.
**Landing Font:** Instrument Serif, italic 400 only (with Iowan Old Style, Georgia, serif), self-hosted.
**Label/Mono Font:** Geist Mono (with ui-monospace, SF Mono, Menlo, monospace), weights 400 to 500, for code only.

**Character:** A tight, modern grotesque that does all the talking, and one soft italic serif that lets each headline land, like the narrator's emphasis in the video. Geist and Instrument Serif are pinned by the user's choice of world ("Dark, like the video").

### Hierarchy
- **Display** (700, clamp(42px, 6vw, 82px), 0.98, -0.045em): the hero headline only, two lines, the second in the landing serif. The troubleshooting page's h1 uses the same voice at clamp(44px, 6.4vw, 84px), line height 1.
- **Headline** (650, clamp(34px, 4.8vw, 64px), 1.02, -0.035em): every section h2.
- **Landing** (Instrument Serif italic 400, 1.1em of its heading, 0.95, -0.01em, periwinkle): the closing phrase of each h1 and h2. In the hero it is 1.04em, because the display size is already large.
- **Title** (650, 26px, 1.25, -0.03em): item titles in rows, such as the three ways to ask (26px), install columns (24px) and troubleshooting issues (25px).
- **Title Small** (650, 21px, 1.3, -0.02em): titles in dense lists, such as the long-document features (21px), the kinds of document (22px, weight 600) and "what else you need" (19px).
- **Body Large** (400, 19px, 1.55, muted): the sub line under each section heading, max 38em. The hero lede is its fluid form, clamp(18px, 1.6vw, 21px), max 37em.
- **Body** (400, 18px, 1.6): base text. Paragraphs in rows stay within 30 to 40em.
- **Body Small** (400, 16.5px, 1.6, muted): text inside ruled rows and lists.
- **Fine** (400, 15px, 1.5, faint): fine print under the hero actions, captions, notes, footer. Footnotes go down to 14px.
- **Label** (500, 15px, 1): nav links, format pills, toggles. Pills on the stage run from 15 to 17px at weight 500.
- **Button** (600, 16px, 1): main and ghost buttons; 14px in the top bar.
- **Mono** (Geist Mono 400, 13.5px, 1.7): code blocks; inline code is 0.88em of its line.

Inside the demo, the preview page is set in a document serif (Charter, Bitstream Charter, Iowan Old Style, Georgia) at 13.5px, justified and hyphenated, to look like the rendered document. That face belongs to the app quote, not to the stage.

### Named Rules
**The Landing Phrase Rule.** Every h1 and section h2 ends on one phrase in Instrument Serif italic, in periwinkle. One phrase, always at the end, never in the middle of a sentence. Never in h3s, body text, buttons or pills.

**The One Sans Rule.** Geist sets every word on the stage: headings, body, buttons, labels, pills and table text. Weights carry the hierarchy: 400 body, 500 labels and pills, 600 buttons, 650 headings, 700 display. The serif exists only for the landing phrase and mono only for code.

**The Display Cap Rule.** Display never passes 6rem (96px); the hero stops at 82px. Tracking tightens as size grows: -0.045em at display (-0.04em on phones), -0.035em at headline, -0.02 to -0.03em at titles, 0 for body.

## Layout

- **Container:** max 1200px, centred, with a fluid side gutter of clamp(16px, 4vw, 40px). The film sits in a 1120px column and the theme stage in a 1000px column.
- **Section rhythm:** each section starts clamp(88px, 11vw, 150px) below the last. The sub line sits 18px under the headline, and the section's content starts 56px under that. The last section adds clamp(88px, 11vw, 140px) below itself before the footer.
- **Alignment:** the hero, the agent section and the themes section are centred. All other sections are left aligned, with the headline at the left edge of the container.
- **Grids:** the three ways to ask are rows of three columns (240px title, flexible text, sample up to 470px), gap 24px by 48px. The long-document features are two columns with a 64px gap. Privacy and install are two equal columns with an 80px gap. The kinds of document and the comparison are full-width tables.
- **Rows:** grouped items are separated by 1px hairlines on top, and the group closes with a hairline at the bottom. Row padding runs from 18px (privacy list) to 40px (ways to ask).
- **The stage** is fixed behind everything, does not take pointer events and never scrolls. The top bar is sticky, 66px tall.
- **Responsive steps:**
  - 1060px: the brand's format line hides; the demo becomes two columns with the chat across the top; the ways-to-ask title column shrinks to 200px.
  - 860px: the top bar keeps only the Download button; every two-column grid becomes one column; the demo stacks its panes; the kinds-of-document table stacks each row.
  - 640px: the comparison stacks, each feature on its own line with the four answers in a row under it.
  - 480px: hero buttons go full width; the demo drops its window dots and trims padding.

## Elevation & Depth

A hybrid. The stage is flat and gets its depth from light: the four drifting glows, the grid that fades out, the vignette at the edges, and glowing dots. Only three kinds of object cast shadows: app frames, keycaps and the main action button. Rows, bands and pills are flat. The top bar is translucent (night at 70% with a 14px blur and 150% saturation) so text stays legible as content scrolls under it; the blur is functional, not decoration.

### Shadow Vocabulary
- **Window lift** (`box-shadow: 0 50px 140px rgb(0 0 0 / 0.7)`): the film frame, the demo window and the theme stage. The film also has a blurred blue and pink halo behind it.
- **Sample lift** (`box-shadow: 0 24px 60px rgb(0 0 0 / 0.5)`): the smaller app samples in the ways-to-ask rows.
- **Download glow** (`box-shadow: 0 12px 34px rgb(61 109 250 / 0.38), inset 0 1px 0 rgb(255 255 255 / 0.32)`): the main action button. On hover it grows to `0 16px 42px rgb(61 109 250 / 0.5)` with the same inner highlight. The compact top-bar version uses `0 8px 22px rgb(61 109 250 / 0.3)`.
- **Keycap** (`box-shadow: 0 4px 0 #101115, 0 10px 24px rgb(0 0 0 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.14)`): the solid 4px under-edge is the side of the key. Small inline keycaps use a 2px edge.
- **Dot glow** (`box-shadow: 0 0 12px <hue>`, up to 18px): the coloured dots of the four kinds of document and the note marker.

### Named Rules
**The Lit, Not Lifted Rule.** The stage gets depth from light, not from shadows. Only app frames, keycaps and the main action cast a shadow.

**The Keycap Edge Rule.** The keycap's solid under-edge is the only hard offset shadow on the site. It exists because keys have sides. Nothing else gets one.

## Shapes

- **Pills** (999px) for every control on the stage: buttons, nav links, format pills, toggles, status pills, agent chips and the "extensions"/"code diffs" tags in the comparison.
- **App frames** with large soft corners: the film (18px), the demo window (16px), the theme stage (14px), the samples (12px). Each has a 1px border, at 16% white on the stage or App Border inside the quote.
- **Keys and code** (10px): keycaps and code blocks. Small inline keycaps use 6px.
- **Inside the app** (4px): app buttons, chips, status bar buttons; changed words use 3px; the preview page 2px.
- **Dots:** 8 to 11px circles in a document hue, each with a glow of its own colour.
- **The Quire column** in the comparison is one tall shape: an 18px rounded top and bottom (14px on phones), a blue gradient tint and 40% blue side borders, so Quire's answers read as one lit column.

**The Pill or Frame Rule.** On the stage a control is a full pill, and a rounded rectangle is an app frame. Keycaps aside, there are no in-between radii on the stage.

## Components

### Buttons
Confident and lit, but only once per view.
- **Shape:** full pill (999px), 1px border at 18% white.
- **Primary (Download):** the Download Blue gradient, white label at 600 16px, 15px by 24px padding, an 18px icon 10px before the label, and the Download glow. In the top bar it is compact: 10px by 16px, 14px label, smaller glow.
- **Hover / Focus:** rises 1px with a stronger glow over 0.25s on the site's ease; pressing moves it down 1px. Focus is the global periwinkle ring.
- **Ghost:** 4% white fill, Strong Hairline border, no glow, Stage Text label; hover fills to 8%.
- **Phones:** under 480px the hero's buttons go full width.
- **Contrast:** the white label on this gradient measures 4.55:1 at the top (#3f6cf0) and 6.4:1 at the bottom, so it clears the 4.5:1 floor for 16px text. Do not make the gradient any lighter.

### Chips
- **Format pill:** a pill with a 10% tint and a 45% border in its document hue, Stage Text label at 500 15px, and an 8px glowing dot before the label. The four always come in the order Typst, LaTeX, Quarto, Markdown.
- **Status pill:** Signal Green at 8% with a 28% border, a check icon in Signal Green, Stage Text label at 500 16px.
- **Tag:** "partial" answers in the comparison, a pill with a hairline border and 3% white fill, Muted text at 14px.
- **Toggle group (theme switcher):** pills with a Strong Hairline border, 3% white fill and Muted text; hover brightens text and fill to 7%. The pressed toggle inverts: Stage Text fill with near-black (#0b0b0f) text. State is `aria-pressed`. Changing it cross-fades the screenshots over 0.6s.

### Cards / Containers
There are no content cards. Groups of items are ruled rows (see Layout). The only containers are app frames:
- **Corner Style:** 12 to 18px (see Shapes).
- **Background:** App Editor or App Chrome inside; black behind the film.
- **Shadow Strategy:** Window lift or Sample lift (see Elevation & Depth).
- **Border:** 1px, Strong Hairline outside the quote, App Border inside.
- **Full-width band:** the privacy section sits on Raised Band at 75%, closed top and bottom by hairlines. It is a band, not a card.

### Navigation
- **Top bar:** sticky, 66px, translucent night with blur, hairline bottom edge. The brand (32px icon with 8px corners, "Quire Writer" at 650 18px, then the four format names in Faint at 13px) sits left; links and the compact Download button sit right.
- **Links:** Muted, 500 15px, 9px by 12px pill hit area; hover brightens to Stage Text on a 6% white pill. Under 860px only the Download button stays.
- **Footer:** not sticky, transparent, hairline top edge, Faint 15px text; links in Muted brighten to Stage Text on hover.
- **Body links:** Periwinkle with a 1px underline at 50% that becomes full colour on hover, offset 4px.

### Keycaps
- A physical key: 40px tall, at least 40px wide, 10px corners, a dark gradient from #34363e to #22242a, a light top highlight and the Keycap shadow. Label in #ececf1 at 500 16px.
- On hover of its row, the key presses down 3px and its edge shrinks to 1px (only when motion is allowed).
- The inline version inside samples is 26px tall with 6px corners and a 2px edge.

### Code blocks
- App Editor surface, 1px App Border, 10px corners, 16px by 18px padding, Geist Mono 13.5px at 1.7, App Foreground text, horizontal scroll for long lines. Used on both pages for commands.

### The app window (signature)
A small working copy of Quire in Dark Modern, used to prove the review promise.
- Title bar in App Chrome with window dots, the document title and its file, and file tabs on the right; the active tab takes the editor colour and a 2px top stripe in its document hue.
- Three panes divided by App Border lines: the editor (line numbers in Geist Mono 13px, code in Geist Mono 14.5px on 28px lines, the current line lightly lit), the preview (a white page on #2a2a2a in the document serif), and the chat.
- Pane headers and chat sender names are the app's own small uppercase labels (600 11px, 0.08em tracking, App Muted). They exist only inside this quote, because the app draws them that way.
- The agent's changes show as struck deleted text and highlighted inserted text; the current change has a 1.5px App Button Blue ring. Accepting a change flashes a green settle over 1.1s.
- A status bar in App Chrome holds previous/next, Accept all (App Button Blue) and Reject all (App Widget).

### The agent registry
- Three rows of agent chips stream sideways (90 to 110s per loop, the middle row in reverse) inside a mask that fades both edges. Each chip is a hairline pill at 3% white with a 30px letter disc tinted in a hue taken from the agent's name. Known agents are brighter (Stage Text, Strong Hairline, 6% fill). Screen readers get the plain list instead.

### The film
- The video in an 18px frame with a Strong Hairline border, the Window lift and a blurred blue and pink halo behind it. A transparent full-size play button covers the poster until the visitor starts it. The caption is Faint 15px, centred.

## Do's and Don'ts

### Do:
- **Do** end every h1 and section h2 on one phrase in Instrument Serif italic, periwinkle (#9db8ff), at 1.1em.
- **Do** use the four document hues only as light: stage glows, glowing 8 to 11px dots, tints near 10% with borders near 45%, and only for the kind of document they belong to.
- **Do** frame only the app and its output, with a 1px border, 12 to 18px corners and the Window or Sample lift.
- **Do** separate grouped items with 1px hairlines at 9% white, and close the group with a bottom hairline.
- **Do** keep stage controls as full pills (999px).
- **Do** take every app value from `web/style.css` (Dark Modern) when the app quote changes.
- **Do** gate every ambient and entrance animation behind `prefers-reduced-motion: no-preference`, and stop the drift, the settle flash and the caret blink under `reduce`.
- **Do** keep the site's ease, `cubic-bezier(0.16, 1, 0.3, 1)`, for hovers, entrances and the film's tilt.
- **Do** write "document" in copy. "Paper" is only for a paper someone cites.

### Don't:
- **Don't** put kickers or eyebrows (small uppercase tracked labels) above headings. The only uppercase tracked text on the site is the app's own pane headers inside the app window.
- **Don't** use gradient text. Gradients on this site are fills (the Download button, the Quire column) and light.
- **Don't** use blur or glass as decoration. The top bar's blur is there for legibility over scrolled content and is the only one.
- **Don't** build a light screenshot hero or a grid of feature cards; the direction refused both.
- **Don't** add a fifth stage light, a second accent colour, or let the `app-*` colours onto the stage.
- **Don't** use a hard offset shadow anywhere except the keycap's edge.
- **Don't** set text dimmer than Faint (#8c8c97) on the stage.
- **Don't** make the Download gradient lighter; its white label is already under 4.5:1.
- **Don't** state the exact number of themes. The switcher shows a selection, and the copy says the app has several.
