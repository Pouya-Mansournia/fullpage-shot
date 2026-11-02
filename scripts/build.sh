#!/usr/bin/env bash
# Package the extension into dist/fullpage-shot-v<version>.zip for the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
OUT="dist/fullpage-shot-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json background.js popup.html popup.js icons LICENSE -x '*.DS_Store'
echo "$OUT"
