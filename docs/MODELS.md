# Models

Which models arnx uses, how to change them, and what they cost. With arnx cloud instead of your own keys, see
[CLOUD.md](CLOUD.md).

## The harness

`arnx init` writes arnx's harness, the models arnx is measured with, one per job:

    [models]
    reviewer = "anthropic:claude-sonnet-5-5"      # reviews the change, writes and runs the tests
    hunter = "anthropic:claude-haiku-5-5"         # looks at each part of a big change
    second_hunter = "openai:gpt-6.1-sol"          # a second look, from another vendor
    challenger = "river:zai-org/GLM-5.3-Flash"    # second opinion on each finding
    challenger_fallback = "openai:gpt-6.1-sol"    # asked when the challenger fails
    answer_model = "anthropic:claude-haiku-5-5"   # turns your answers into tests
    effort = "medium"                             # low, medium or high

The keys in your environment decide: a role whose key is missing is written commented out, with the key it needs,
and Claude stands in (Sonnet gives the second opinion; there is no second hunter and no fallback). With only
`ANTHROPIC_API_KEY`, every job runs on Claude. Change any model there.

Built in: `anthropic` (ANTHROPIC_API_KEY), `openai` (OPENAI_API_KEY; `openai_tier = "fast"` for priority processing)
and `river` (RIVER_API_KEY), the harness's second opinion. Anthropic models run through the Messages API, the others
through the Responses API with arnx's tools as functions.

After your own tables, `arnx init` writes the other providers arnx knows: Z.ai as a table, and DeepSeek, Kimi and
OpenRouter commented out (we haven't run them ourselves yet: uncomment one and tell us), each with the model arnx
suggests for the second opinion. Their models are priced in arnx. Any other provider is a generic table under
`[providers]` for an endpoint that copies one of the two APIs, named in a model as `<table>:<model>`:

    [providers.myprovider]
    api = "messages"                                  # "messages" (copies Anthropic's) or "responses" (copies OpenAI's)
    url = "https://llm.example.com"                   # https (plain http only to localhost); Messages: without /v1
    key_env = "MY_PROVIDER_KEY"                       # the variable holding the key; never the key itself
    effort = { medium = "high" }                      # optional: arnx's effort in the endpoint's words

    [models]
    challenger = "myprovider:some-model"

    [prices]
    "some-model" = [0.5, 2.0, 0.05, 0.0]              # USD per million tokens: input, output, cache read, cache write

A model arnx has no price for needs one under `[prices]`, from the provider's price page. `store = false` (Responses
only) sends unstored requests, with reasoning passed back encrypted, for endpoints that refuse stored ones. A table
named like a built-in provider (`[providers.openai]`, say with another `url`) changes only the fields it gives.
`arnx doctor` lists each table a role uses, with its host and whether its key's variable is set; telemetry counts it as
`other`.
Endpoints that copy only OpenAI's Chat Completions API come in a later version.

More settings under `[models]`, written only when set: `second_hunter_effort` (the second hunter's own effort),
`openai_tier`, `openai_transport`.

`effort` (default `"medium"`) applies to every role. `second_hunter_effort` gives the configured `second_hunter` its
own, sent as is (`"none"`, `"low"`, …; the provider rejects a value it does not take): a second hunter that reasons
long can run past the time a hunt is given. OpenAI calls run as background responses
that arnx polls every 3 s and cancels when the call runs out of time, since a long OpenAI stream can stall on some
networks; `openai_transport = "stream"` streams them instead. Generic tables always stream. Background mode needs
stored responses, so it does not work for an OpenAI organization with Zero Data Retention: set
`openai_transport = "stream"` there. `openai_tier = "fast"` together with background mode is not verified yet.
Interrupting arnx (Ctrl-C or SIGTERM) cancels the background responses still running.

Output is coloured on a terminal; NO_COLOR turns it off.

## Make it yours

Any model for any job, any mix of vendors: try it. The harness above is the one we measure, not the only one that
works. A cheap reviewer with a strong second opinion, a local model behind a generic table, two vendors arguing:
`arnx doctor` tells you what is wired up, and the review's cost line tells you what it spent.

The prompts are yours to change too, one key at a time. `arnx prompts` lists the keys (`review.task`, `hunt.task`,
`challenge.task`, ...); `arnx prompts copy hunt.task` writes arnx's text of that key into `.arnx/prompts.toml`, where
you edit it. The file holds only the keys you changed: every other key follows arnx's defaults, also after an upgrade.
A key keeps the `$placeholders` its default offers (arnx refuses others, naming the ones it has); `arnx doctor` warns
when arnx changed the default you copied (`<name>_base` records it) and when you dropped a placeholder the step needs,
such as `$diff`. Each review names your keys and the hash of the prompts it ran, in review.json and review.md's
header. The file is not part of the approval: editing it needs no `arnx approve`. With arnx cloud its own prompts run
(arnx says so in one line and sends nothing of yours). The defaults are in `src/prompts.toml`. Whatever the prompt
says, a finding is still a test that failed in every run in Docker, so a prompt cannot make arnx report a failure that
did not happen. It can make arnx write tests that expect the wrong thing: those fail for real and still need your
mark, so a worse prompt shows up as more findings you mark intended, noise or rewrite.

Found a combination or a prompt that catches more? Open an issue with the review's numbers: we'll try it in our own
measurements.

## Cost

You pay your model providers directly. Each review prints its cost, and review.md splits it per model, such as
`Cost $0.47 (claude-sonnet-5-5 $0.40 · gpt-5.5-2026-04-23 $0.07)`; `review`, `setup` and `accept` append one
line per run to `.arnx/usage.jsonl` with tokens and cost per model, dated by UTC day as the providers bill.
A review costs from a few cents for a small change to a few dollars for a large one (our own reviews on real
changes: $0.17 to $3.19); it stops writing tests at your cap, `review_usd` under `[budget]` (default $3.00), and the
report says when it did.
