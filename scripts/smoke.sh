#!/bin/sh
# Both build outputs must start and report the version; the Node bundle must also run a real command, and both must
# carry the arnx skill.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
bun run build:bin >/dev/null
bun run build:node >/dev/null
want="arnx $(node -p 'require("./package.json").version')"
# A build names the commit it was built from.
case "$(./dist/arnx --version)" in "$want (built "*" from $(git rev-parse --short HEAD)"*) ;; *) exit 1 ;; esac
case "$(node dist/cli.js --version)" in "$want (built "*" from $(git rev-parse --short HEAD)"*) ;; *) exit 1 ;; esac
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git -C "$repo" init -q
set +e
(cd "$repo" && env -u ANTHROPIC_API_KEY node "$root/dist/cli.js" doctor) >"$repo/out" 2>&1
code=$?
set -e
test "$code" = 3
grep -q "config" "$repo/out"
# Both builds carry the skill for coding agents (imported as text at build time).
(cd "$repo" && node "$root/dist/cli.js" skill install) >/dev/null
cmp "$repo/.claude/skills/arnx/SKILL.md" "$root/skills/arnx/SKILL.md"
rm -rf "$repo/.claude"
(cd "$repo" && "$root/dist/arnx" skill install) >/dev/null
cmp "$repo/.claude/skills/arnx/references/review-json.md" "$root/skills/arnx/references/review-json.md"
echo "smoke ok: $want (binary and Node bundle)"
