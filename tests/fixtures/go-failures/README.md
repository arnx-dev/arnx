# Go failure fixtures

Captured stdout of `go test -json -count=1 -vet=off ./...` in `src/` (module `example.com/failures`, testify
v1.12.1 from the module cache, `GOPROXY=off`, go1.26), for what a failure's first line must tell apart. The source
directory's absolute path was replaced by `/src`.

| File | Run |
|---|---|
| `run-a.jsonl` | first run |
| `run-b.jsonl` | the same run again: other addresses, ports, temporary directories and timings |
| `run-variant.jsonl` | `FAIL_VARIANT=1`: other values at the same lines (`chain`, `testify`) |

| Package | What it shows |
|---|---|
| `chain` | a helper outside the test reports `check.go:N: chain_test.go:M:` with a coloured diff under it |
| `testify` | testify's bare `x_test.go:N:` line with `Error Trace:` / `Error:` / `Messages:` under it; a t.Log before |
| `logged` | a server handler in another file logs `Method: POST` before the test's own error |
| `plain` | one-line messages; a t.Log before t.Fatal |
| `volatile` | a message with a local port, a t.TempDir path, an address and a duration |
| `table` | parallel subtests: one passing with a log, two failing (testify and t.Errorf), a parent log |
