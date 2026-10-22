# Security

arnx runs code from the repository it reviews (install steps, the project's tests, tests a model wrote) and handles
model keys, so we take reports seriously.

## Reporting

Email **info@arnx.dev** with "arnx security report" in the subject. Do not open a public issue. Include:

- the arnx version (`arnx --version`) and your OS;
- what an attacker can do, and under which conditions;
- a minimal reproduction you can share safely. Never send real credentials or private code.

We answer as soon as we can, agree with you on a fix and a date to disclose, and credit you if you want.

## What counts

- A way out of the test sandbox: network, host files, the host environment, or the Docker socket from inside a test
  container.
- Model keys reaching a container, a file, a log or a model.
- Files the secrets filter or `.arnxignore` should withhold being sent to a model, or key-shaped text slipping
  through.
- `arnx accept`, `remove` or any command writing or deleting outside what it says it touches.
- A way around the pins of accepted tests (`arnx check` running an edited test without exit 4).
- For arnx cloud (https://api.arnx.dev): access to another account's data, balance or reviews.

## Known limits (not vulnerabilities)

- Docker shares the host kernel: it is not a perfect boundary for hostile code. Review code you do not trust before
  you run setup on it.
- Image builds and test runs are restricted differently. Builds run your approved install steps with network access,
  to install dependencies. Test runs get no network (or an internal one reaching only the services you approved), no
  host environment beyond the variables in `.arnx/review.yaml`, no capabilities, and CPU, memory and process limits.
  Model keys are never passed to either.
- The secrets filter is a heuristic, not a complete detector of confidential data; `.arnxignore` is yours to extend.
- `arnx allow-secret PATH` deliberately lets the key-shaped strings of a test fixture through (pinned in
  `.arnx/review.yaml`, which then needs approving again). Use it only for fake keys, never real credentials.
- Accepted tests run outside the sandbox once you commit them, in your own test runner: read them first.

See [docs/SAFETY.md](docs/SAFETY.md#what-runs-where) for the full set of boundaries.
