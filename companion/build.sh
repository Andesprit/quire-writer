#!/bin/sh
# Builds Quire Companion.app into companion/build/ (macOS 26, Apple silicon).
# It is signed for this Mac only: after each build, macOS asks again for Accessibility.
set -e
cd "$(dirname "$0")"
app="build/Quire Companion.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos26.0 \
  -o "$app/Contents/MacOS/Quire Companion" Sources/*.swift
cp Info.plist "$app/Contents/"
cp ../agents.json "$app/Contents/Resources/"  # the agents it can start: Quire's copy of the ACP registry
cp ../src-tauri/icons/icon.icns "$app/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$app"
"$app/Contents/MacOS/Quire Companion" --selftest
echo "Built $app"
