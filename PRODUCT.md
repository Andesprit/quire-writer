# Product

<!-- impeccable:product-schema 1 -->

## Platform

desktop (macOS; Linux builds are experimental)

## Users

Academics writing in Typst, LaTeX, Quarto or Markdown: papers, theses and reports with math, figures, tables and
citations. They work in long sessions on one project folder, mostly in prose, and want
AI help without leaving their writing tool.

## Product Purpose

A writing app for Typst, LaTeX, Quarto and Markdown with an AI agent built in. The writer opens a project folder, writes
with a live preview, and asks an agent to draft, rewrite or fix text: from a chat panel,
inline on a selection (Cmd+K), or through autocomplete. Every change the agent makes is
shown as a change to review. Success: the writer trusts the agent with their document
because nothing lands without their say.

## Positioning

- Bring your own agent: connects to any ACP agent (Claude, Codex, Gemini and others from
  the ACP registry) using the writer's own subscription. Model and agent can be switched
  at any time.
- The editor stays a real text field for Grammarly and the spellchecker, which VS Code and
  Cursor do not support.

## Operating Context

- A macOS desktop app. Grammarly works through the Grammarly for Mac app; browser extensions
  do not run in it.
- Live preview comes from tinymist (Typst), the writer's own TeX (LaTeX) and Quarto; the
  app draws Markdown itself. Agents run as local processes with their own logins.
- Agent replies take seconds (inline edits ~5-10 s, autocomplete 3-15 s), so waiting
  states are part of normal use.

## Capabilities and Constraints

- Open a folder; list and edit its text files (.typ, .tex, .qmd, .md, .bib and similar).
- Chat with the agent; stream replies, tool calls and plans; answer permission requests.
- Inline edit on a selection; autocomplete as grey text, Tab to accept, can be turned off.
- Track changes: accept, reject or modify each change; accept/reject all; restore all files
  to before a chat message.
- Agent picker plus the options each agent reports (mode, model, effort, others).
- One open file at a time today; tabs are not built yet.

## Brand Commitments

- The name is Quire. It is set in one place in the editor (`APP_NAME`) and in the app's
  build settings. The open-source project and its repository are Quire Writer
  (`Andesprit/quire-writer`), because other products are called Quire.
- The user pinned VS Code and Cursor as the interface reference: activity bar, explorer,
  editor tabs, side panels, status bar, command-style controls, played straight.
- Personality comes from color themes, as in VS Code: the layout stays the same and a theme
  changes the look. VS Code Dark Modern and Light Modern stay (the default follows the system);
  the Quire themes are Series (book covers, one color per kind of file), Galley (printer's
  proof, agent changes in red ink), Coupon (ticket wallet) and Slate (blackboard).
- The app icon is a chalk Q on slate, made with Codex. The full-size source is
  `src-tauri/app-icon.png`.

## Evidence on Hand

- `sample/main.typ`: a synthetic sample document with deliberate grammar mistakes, for
  testing. No real users, testimonials or benchmarks exist; do not invent them.

## Product Principles

1. The writer's text comes first: the editor gets the most room and the calmest surface.
2. Nothing changes without review: every agent edit is visible, reversible and attributable.
3. Agent-agnostic: no screen may assume one vendor's agent or model names.
4. Familiar over novel: people who know VS Code or Cursor should feel at home at once.

## Accessibility & Inclusion

The editor must stay a normal editable text surface (spellcheck on) so Grammarly and
system spellcheck work. Keyboard access for every action.
