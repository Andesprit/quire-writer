#!/bin/sh
# Builds the desktop app into src-tauri/target/release/bundle/ (see README).
set -e
cd "$(dirname "$0")"
(cd web && npm install && npm run build)
mkdir -p build/bin
# Writable copy: Homebrew's is read-only, and a read-only copy breaks the next build.
install -m 755 "$(realpath "$(which tinymist)")" build/bin/tinymist
strip build/bin/tinymist  # drops debug symbols: about 6 MB smaller, runs the same
cd src-tauri && cargo tauri build
