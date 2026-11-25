# Installing arnx

Point the user to arnx's own install instructions; installing is theirs to do, and so is any login.

## Requirements

Docker, running; macOS or Linux; a model key in the environment (`ANTHROPIC_API_KEY` for the default, or the
variable `.arnx/config.toml` names), or arnx cloud instead (`arnx init --cloud`, then `arnx login`). `arnx doctor`
says what is missing. Never print or ask for key values: the user exports them in their own shell.

## Install

arnx's install instructions: <https://github.com/arnx-dev/arnx/blob/main/docs/WORKFLOW.md#install>. They cover the
npm package (Node 20 or later, no login needed) and the standalone binaries for macOS and Linux (no Node needed).
No Windows build; WSL 2 with Docker Desktop should work, but we have not tested it.

Check it: `arnx --version`.

## Minimum version

This skill needs **arnx 0.1.0** or later. Older: the same instructions upgrade it.

## After installing: the user's steps

- `arnx init`: writes `.arnx/config.toml` and `.arnxignore`. Only the user runs it.
- `arnx setup`: checks keys and Docker as `arnx doctor` does (with arnx cloud, asks the consent to send code there
  the first time), then an agent proposes the test environment and proves it by running the suites. Costs model calls; the user runs
  it.
- `arnx skill install`: writes this skill to `.agents/skills/arnx/` (Codex and other Agent Skills agents) and `.claude/skills/arnx/` (Claude Code) in the repository (`--user`: the same folders under `~`).
