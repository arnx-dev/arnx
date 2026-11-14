# arnx plugin for Claude Code

This plugin adds the arnx skill. When a change is finished, the skill has Claude Code run `arnx review`, fix the findings
arnx confirmed, and run `arnx check` until it passes. Marking and accepting stay with you.

The skill drives the arnx CLI, which must be installed separately: see the
[install section](https://github.com/arnx-dev/arnx#install) of the main README.

Install in Claude Code:

    /plugin marketplace add arnx-dev/arnx
    /plugin install arnx@arnx

Apache-2.0, see LICENSE.
