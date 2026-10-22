#!/bin/sh
# Builds dist/arnx (single binary) or dist/cli.js (Node bundle) with the commit and build time baked in, so
# `arnx --version` says which code a built copy holds.
set -eu
cd "$(dirname "$0")/.."
commit=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain -- . | head -1)
info="$commit $(date '+%Y-%m-%d %H:%M')${dirty:+ dirty}"
case "${1:-}" in
  # bin [target] [outfile]: a Bun target such as bun-darwin-arm64 builds for that platform from any machine.
  bin) bun build --compile ${2:+--target=$2} src/main.ts --outfile "${3:-dist/arnx}" --define "ARNX_BUILD=\"$info\"" ;;
  node) bun build --target=node src/main.ts --outfile dist/cli.js --banner '#!/usr/bin/env node' \
    --define "ARNX_BUILD=\"$info\"" ;;
  *) echo "usage: scripts/build.sh bin [target] [outfile] | node" >&2; exit 2 ;;
esac
