# arnx cloud

arnx cloud runs the models for you: no model keys, prepaid credit, and the tests still run in your Docker. With your
own keys instead, see [MODELS.md](MODELS.md); what leaves your machine either way is in [SAFETY.md](SAFETY.md).

**arnx cloud is new.** When `https://api.arnx.dev` does not answer, `login`, `credits` and any
`--cloud` run stop with one line saying so (exit 2); your own keys keep working.

Instead of your own keys, arnx cloud can run the models: it decides what the agent reads, writes and runs, hunts, and
judges the findings, at effort `low`, `medium` or `high`. No model key needed.

- **Runs on your machine, as with your own keys:** every tool call (each file read runs inside the snapshot, secret
  files and `.arnxignore` paths left out), the tests in your Docker, the before/after check and the report. A finding
  is still a test arnx ran three times and saw fail every time.
- **Sent to arnx cloud:** what a model provider gets with your own keys: the diff, the files the agent reads, the
  tests it writes and their output. arnx cloud passes them on to its model providers.
- **Price:** prepaid credit in US dollars; each review shows what it was billed, per role. New accounts start with
  $5 free. Credits and top-ups: https://arnx.dev/credits. Terms: https://arnx.dev/terms; privacy:
  https://arnx.dev/privacy.

The commands:

    arnx cloud on           # in a set-up repository: asks the cloud consent once, sets [cloud] models = true
    arnx cloud off          # back to your own keys: models = false
    arnx init --cloud       # or set a new repository up for arnx cloud from the start
    arnx login              # open the link it shows, enter the code; token in ~/.config/arnx/credentials.json
    arnx credits            # the balance, what reviews in progress reserve, and the top-up link
    arnx logout             # deletes the token

Every `.arnx/config.toml` has the table, so switching is one word, which `arnx cloud on|off` changes (a plain
`arnx init` writes `models = false`):

    [cloud]
    models = false         # true: arnx models instead of your own keys
    tests = false          # leave false: tests run in your Docker
    effort = "medium"      # low, medium or high: the brain's tier

The committed file is the team's default. To override it for yourself or for one run, without editing it:
`ARNX_MODELS=local` or `ARNX_MODELS=cloud`, or `--local` / `--cloud` on `review`, `setup`, `accept`, `doctor` and
`next`. A flag beats the variable, which beats the file; `arnx doctor` says which models are in effect and why.

Sending code needs your consent, once per repository and destination (your model provider, or arnx cloud). The first
command that sends code (normally `arnx setup`) shows where it goes and asks; `arnx cloud on` asks when you switch.
Without a terminal arnx stops with exit 3 and sends nothing: `arnx consent` (`--cloud` for arnx cloud, `--yes` in
scripts) records it.

Money:

- A review first reserves at most your cap (`review_usd` under `[budget]`, default $3.00), is billed what it actually
  cost, and is always closed, also when it fails or you interrupt it.
- The cost shows per role under the tier, such as `arnx:medium/reviewer`, in review.md, review.json and
  `.arnx/usage.jsonl`; arnx cloud does not name the models it used.
- A balance too low to start stops with exit 3, the balance and the top-up link; `arnx review --resume` continues
  after a top-up.

When arnx cloud cannot be reached, arnx exits 2 and says so, and, when your own keys are all set, that `arnx cloud
off` (or `--local`) uses them. With arnx cloud on, `doctor` and `next` check your login and balance instead of
provider keys.
