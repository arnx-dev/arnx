# Go test event fixtures

Captured stdout of `go test -json -count=1 -vet=off ./<case>` (the `timeout` case also has `-timeout 3s`), one
`<case>.jsonl` per case, from the `golang:1.26-bookworm` image. Source is in `src/` (module `example.com/events`,
one package per case). Each was also run on `golang:1.24-bookworm`: same Action set and same build-failure shape in
every case. The only differences are stack frames, addresses and timings inside `output` text (the 1.24 panic also has
an extra `[recovered]` line pair where 1.26 prints `[recovered, repanicked]`).

Run: non-root uid 1000, `--network none`, source mounted read-only at `/src` (working directory), writable
`GOCACHE`, `HOME=/tmp`, `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOFLAGS=-buildvcs=false`.

| Case | What it shows |
|---|---|
| `pass-fail-skip` | `TestPass`, `TestFail`, `TestSkip` in one package |
| `subtests` | `TestTop` with slash, space, nested, duplicate, failing and quoted subtests |
| `panic` | panic on the test's own goroutine: `TestPanics` ends in `fail`, then package `fail` |
| `goroutine-panic` | `TestGoroutinePanic` panics from a goroutine it starts: `run`, no terminal event, then package `fail` |
| `exit3` | `TestCrash` calls `os.Exit(3)`: `run`, no terminal event |
| `timeout` | `-timeout 3s`; `TestHang` has `run`, no terminal event |
| `test-compile` | undefined name in a test file: `build-fail`, package `fail` with `FailedBuild` |
| `code-compile` | type error in non-test code: same shape |
| `import-main` | test-only package `import-main/x_arnx` imports a `package main`: `is a program, not an importable package`, `[setup failed]`, `FailedBuild`; run as `./import-main/x_arnx` |
| `duplicate-func` | two test files declare `helper`: `redeclared` build failure |
| `no-tests` | package without tests: package `skip` only |
| `testmain-exit0` | `TestMain` calls `os.Exit(0)` with a declared test: package `pass`, zero test events |
| `forge` | `0x16` byte forges events for `TestForged` (never declared) and a `fail` for `TestReal`, which also passes |
| `vet-off` | wrong `t.Logf` verb still runs with `-vet=off` |

Action set seen: `start run output pass fail skip build-output build-fail`. Build failures carry `ImportPath`
events with `Action` `build-output` and `build-fail`, then a package `fail` with `FailedBuild`.

## Run seconds (docker run wall time, `pass-fail-skip`)

| Image | Cold `GOCACHE` | Warm |
|---|---|---|
| go1.24 | 7.4 | 0.5 |
| go1.26 | 8.6 | 0.5 |

Cold includes container start and compiling the standard library tests into an empty cache.

## Layout check

`tests/arnx/r20261109_abc123/x_arnx/x_arnx_test.go` (`package arnx`, importing the module and a root-level
`internal/` package) passes when run by explicit path on both images. The same file under `.arnx/tests/` also
passes by explicit path, and `go test ./...` from that copy does not run it.
