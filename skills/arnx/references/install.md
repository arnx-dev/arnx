# Installing arnx

Show the user the line that fits and run it only after they say yes. Logins are theirs to run, never yours.

## Requirements

Docker, running; macOS or Linux; a model key in the environment (`ANTHROPIC_API_KEY` for the default, or the
variable `.arnx/config.toml` names), or arnx cloud instead (`arnx init --cloud`, then `arnx login`). `arnx doctor`
says what is missing. Never print or ask for key values: the user exports them in their own shell.

## Install

With npm (Node 20 or later), no login needed:

    npm install -g @arnx-dev/arnx

Or the standalone binary, no Node needed (the user picks `darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64`):

    curl -fLO https://github.com/arnx-dev/arnx/releases/latest/download/arnx-linux-x64 && chmod +x arnx-linux-x64 && mv arnx-linux-x64 /usr/local/bin/arnx

The macOS binaries are not signed yet: one downloaded in a browser is quarantined, and
`xattr -d com.apple.quarantine /usr/local/bin/arnx` releases it. On Windows, arnx runs in WSL 2 (the Linux line).

Check it: `arnx --version`.

## Minimum version

This skill needs **arnx 0.1.0** or later. Older: upgrade with the same line (`npm install -g @arnx-dev/arnx`, or download the binary again).

## After installing: the user's steps

- `arnx init`: writes `.arnx/config.toml` and `.arnxignore`. Only the user runs it.
- `arnx setup`: checks keys and Docker as `arnx doctor` does, asks the user's consent to send code (the first time),
  then an agent proposes the test environment and proves it by running the suites. Costs model calls; the user runs
  it.
- `arnx skill install`: writes this skill to `.agents/skills/arnx/` (Codex and other Agent Skills agents) and `.claude/skills/arnx/` (Claude Code) in the repository (`--user`: the same folders under `~`).
