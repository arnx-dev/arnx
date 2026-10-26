# Code arnx did not review

arnx reviews only code inside a project backed by an existing test suite (a project in `.arnx/review.yaml`, proven by
`arnx setup`). Everything else it leaves out, and says so. That is by design; do not work around it.

## How it shows

- `arnx review` refuses the whole change, exit 3: ``no project covers this change: <paths>. Run `arnx setup --add`
  to cover these paths``.
- Or it reviews the rest and lists what it left out in review.json:
  - `uncovered`: `{path, reason}`, changed files no project covers (the summary says `Not tested: ...`);
  - `untested`: per project, changed source files no arnx test refers to (the summary says `Not tested: ...`;
    review.md says `Not tested by arnx: ...` and "partly covered").

## What to do

1. **Say it plainly.** Tell the user "Not reviewed by arnx:" followed by those paths. Never present another review (a
   diff you read yourself, your own tests) as an arnx review, and never report that code as checked by arnx. What
   arnx did review, report as usual.
2. **Ask for unit tests.** Ask the user whether you should add a small set of unit tests for that code, and say why
   in a few lines:
   - arnx can then cover the code: `arnx setup --add` registers it as a project.
   - The tests become locks: they catch the next regression. Code with no tests is where agent-written bugs reach
     production unnoticed.
   - Every later arnx review of that code writes and proves its tests against a real environment.
3. **Only after the user says yes**, write the minimal suite:
   - with the runner the project already uses (`node --test`, vitest, jest, pytest, `cargo test`), where its tests
     usually live;
   - self-contained: arnx runs tests in Docker with no network, so use saved fixtures (a recorded API response, a
     transaction as JSON in a file), never live services, keys or the internet;
   - run it yourself and make it pass on the current code.
   Then tell the user to run `arnx setup --add` themselves (it sends code to their model and rewrites
   `.arnx/review.yaml`), and to ask you to review again once it has finished. Do not run setup yourself.

## Example wording

> Not reviewed by arnx: `src/billing/invoice.ts`, `src/billing/rates.ts`. arnx only reviews code that already has a
> test suite, and nothing covers these files yet, so nothing here was checked by arnx.
>
> Shall I add a small set of unit tests for them (vitest, like the rest of the repository, with saved fixtures and
> no network)? Then `arnx setup --add` can register them as a project, the tests lock today's behaviour against the
> next regression (untested code is where agent-written bugs reach production unnoticed), and every later arnx review
> of this code writes and proves its tests in a real environment.
