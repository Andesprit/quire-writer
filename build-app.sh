#!/bin/sh
# Builds the desktop app into src-tauri/target/release/bundle/ (see README).
set -e
cd "$(dirname "$0")"
(cd web && npm install && npm run build)
mkdir -p build/bin
# The app carries tinymist as a sidecar, named for this Mac's chip as Tauri expects.
bin="build/bin/tinymist-$(rustc -vV | sed -n 's/^host: //p')"
# Writable copy: Homebrew's is read-only, and a read-only copy breaks the next build.
install -m 755 "$(realpath "$(which tinymist)")" "$bin"
strip "$bin"  # drops debug symbols: about 6 MB smaller, runs the same
# The bridge to Apple's on-device model (src-tauri/apple), also carried next to the app.
swiftc -O -target arm64-apple-macos26.0 -o "build/bin/quire-apple-$(rustc -vV | sed -n 's/^host: //p')" src-tauri/apple/quire-apple.swift
cd src-tauri && cargo tauri build
