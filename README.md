# Typst Writer

A writing app for Typst with an AI agent of your choice (Claude, Codex, Gemini and
any other agent in the ACP registry), using your own agent login.

- Chat bar: ask the agent to write or change things in your folder.
- Cmd+K on selected text: ask for an edit of just that part.
- Autocomplete: grey text after you pause typing, Tab to accept. Toggle in the top bar.
- Track changes: every change the agent makes shows as a change to review.
  Accept or reject each one, edit it before you accept, or use
  "Restore files to before this message" in the chat to undo a whole turn.
- Live preview with tinymist. Click text in the preview to jump to it in the editor; the
  preview follows the caret when it moves to another line.
- Labels: a list under the explorer of every `<label>` in the project, how often it is used,
  and which ones nothing refers to. Click one to go to it.
- Cite by DOI or arXiv ID (formatting bar): adds the paper to your `.bib` file and `@key` at
  the cursor. Needs the internet (doi.org).
- Explorer: new file, new folder, rename (F2), delete (moves to the macOS Trash), right-click menu.
- Saving: auto save (default) or manual with Cmd+S; switch in the status bar. With auto save
  off, a dot marks unsaved changes and the app asks before closing them.
- Formatting bar: headings, bold, italic, math, lists, links, citations, footnotes, figures, tables.

## Run (macOS)

Needs Rust, `node`, `tinymist` (`brew install tinymist`), and an agent you are logged in
to (for Claude: Claude Code).

```bash
cd web && npm install && npm run build && cd ..
cargo run --manifest-path src-tauri/Cargo.toml -- --browser sample
```

It opens http://127.0.0.1:8765. Use "Open folder" for your own project. Without
`--browser` the same command opens the app in its own window.

## Desktop app (macOS)

Also needs the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`).

```bash
./build-app.sh
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`. The app carries tinymist.
Agents still need their own tools (most need Node) and login. Use the Grammarly for Mac app
there; browser extensions do not run in it.
App and agent logs: `~/Library/Logs/com.andesprit.typstwriter/agent.log`.

## Grammarly test

Open the app in Chrome or Safari with the Grammarly extension. `sample/main.typ` has
grammar mistakes on purpose. Compare the editor with "Plain editor test", which shows the
same text in a plain text field.

## How it works

- `src-tauri/`: one Rust program. In the app it shows the page in a window; with
  `--browser` it serves the page to a browser.
- `src-tauri/src/server.rs`: serves the page, watches the folder, runs the preview.
  Any file change not made by the editor becomes a change to review.
- `src-tauri/src/agent.rs`: talks ACP to one agent process with three sessions: chat, inline edits,
  autocomplete (smallest model the agent offers). Agents come from `agents.json`, a copy
  of the ACP registry. With flow-atelier installed, `atelier harness sync` writes a newer
  copy that the app uses instead.
- `web/`: the editor and the chat. The editor is a plain text field, so Grammarly and the
  spellchecker work in it; a colored copy of the text is drawn behind it (`web/typst.ts`).
  Track changes use the diff from `@codemirror/merge`.

Checks: `cargo test --manifest-path src-tauri/Cargo.toml`, `node web/typst.test.ts` and
`node web/merge.test.ts`

## Credits

- Icons: [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft, CC BY 4.0.
- Manuscript font: [iA Writer Quattro](https://github.com/iaolo/iA-Fonts) by Information Architects, SIL Open Font License 1.1.

Add `?dev` to the URL to show a button that opens the Grammarly test page
(`/grammarly.html`): the same text in four kinds of text field.
