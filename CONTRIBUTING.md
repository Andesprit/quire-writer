# Contributing to Quire Writer

Thank you for helping. Bug reports, ideas, documentation and code are all welcome.

## Before you start

- For a bug, open an issue with the bug form. Attach the end of the log:
  `~/Library/Logs/com.andesprit.quire/agent.log` (Linux:
  `~/.local/share/com.andesprit.quire/logs/agent.log`).
- For a new feature or a large change, open an issue first, so we can agree on the idea
  before you spend time on code.
- Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).

## Run it

See "Run (macOS)" in the [README](README.md). In short:

```bash
cd web && npm install && npm run build && cd ..
mkdir -p build/bin && cp "$(which tinymist)" build/bin/tinymist-aarch64-apple-darwin  # once
cargo run --manifest-path src-tauri/Cargo.toml -- sample
```

Before you open a pull request, run the checks. CI runs the same ones:

```bash
cd web && npm run check && cd ..
cargo test --manifest-path src-tauri/Cargo.toml
```

CI also builds the installers for macOS, Linux and Windows, the way a release does: a change
that breaks one of them fails there.

## What we look for in a change

- It keeps the promises in [PRODUCT.md](PRODUCT.md): the writer's text comes first, nothing
  the agent does lands without review, and no screen assumes one vendor's agent.
- The editor stays a plain text field, so Grammarly and the spellchecker keep working.
- Small and focused. One change per pull request.
- It reads like the code around it: same naming, same comment style.
- A test for logic that can break (parsing, diffs, file changes).

## Sign your commits (DCO)

Quire Writer uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). It is a short statement that you wrote the change, or have the right to submit it
under the project's license (GPL-3.0-or-later). You agree to it by adding a sign-off line
to every commit:

```
Signed-off-by: Your Name <you@example.com>
```

Git adds it for you with `-s`:

```bash
git commit -s -m "Fix the label count after a rename"
```

The name and email must match the commit author. A check on every pull request refuses
commits without a sign-off. To add one to commits you already made:

```bash
git rebase --signoff main
```

Then push again with `git push --force-with-lease`.

## License

By contributing, you agree that your contribution is licensed under GPL-3.0-or-later, the
license of this project. You keep the copyright on your work.
