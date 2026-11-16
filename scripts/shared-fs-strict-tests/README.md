# Shared-fs first-attempt CI gate

Portable shared-fs CI explicitly uses this configuration for the library and
CLI. Ordinary `pnpm --filter @peerbit/shared-fs run test` behavior is unchanged.
No test retry budgets, protocol assertions, setup hooks, or timeouts are changed.

Vitest 4.0.18 permits a per-test `retry` option to override `--retry=0`, and the
default reporter can show an eventual pass without the original error stack.
This gate keeps those attempts visible while refusing to call them a strict pass:

- A small `VitestTestRunner` subclass emits a
  `shared-fs.first-attempt-failure` JSON line to stderr after the first failing
  attempt and its cleanup hooks. The write is flushed before the next attempt
  begins. The event identifies the file, full test name, attempt, repeat, and
  original serialized error messages/stacks. Expected failures without retries
  are not reported as unexpected failures.
- The additional reporter emits `shared-fs.strict-retry` lines containing the
  final outcome and actual retry count. Any retry makes the process exit nonzero,
  even if the test ultimately passes or dynamically skips. Worker metadata keeps
  retry-then-skip from erasing the count. Missing worker instrumentation on an
  executed test also fails closed.
- The normal reporter and test results remain intact. A
  `shared-fs.strict-summary` line gives the strict-gate totals. These lines are
  available in the raw GitHub Actions job log; this does not depend on scraping
  Vitest's colored progress output.
- The runner raises `Error.stackTraceLimit` from V8's default of 10 frames to
  50 in every worker, before any test file loads, so a failure inside a
  shared helper keeps the frames of the step that called it.
- A test attempt that is still running, hooks included, after
  `SHARED_FS_HANG_REPORT_MS` (default 30000; `0` turns it off) gets one
  `shared-fs.hang-report` line: file, test, attempt, `state` (`run` while
  `beforeEach` or the body runs, `pass` or `fail` once the after hooks run),
  elapsed time, per-type counts from `process.getActiveResourcesInfo()`
  (pending `FSReqCallback`/`FSReqPromise` are fs requests that have not
  completed; thread-pool work of a native addon such as LevelDB is not
  listed), event loop delay max and p99 in ms (a large max means the JS thread
  was blocked), load average (zeros on Windows), free memory, RSS, and the
  `debug()` of up to eight live readiness runtimes of the library's test
  registry. A `shared-fs.hang-probe` line follows: a new `node` process writes
  and fsyncs 4 KiB in `os.tmpdir()` and in the working directory, and is
  killed at 10 s. It reports each latency, an error or `pending > 10 s`. The
  probe has its own thread pool, so a slow probe means the volume stalled,
  while a fast probe points at a wait in the code under test; the probe's
  latency, not the resource counts, tells the two apart. A failed attempt
  writes its probe line before its `shared-fs.first-attempt-failure` line; a
  passing attempt never waits for it, so a probe still running when its worker
  exits is not printed. The report changes no result: its timer, the probe
  process and its pipe are unref'd. The probe writes and removes a
  `.shared-fs-hang-probe-*.tmp` file and finishes even when nothing reads its
  output any more. The file is left behind only if the probe process is
  killed: at its 10 s deadline, or on Windows, where a worker's exit ends its
  child processes.

The original failure is emitted once per test. Each diagnostic string is limited
to 16,384 characters with an explicit truncation marker; at most four errors are
included, with an explicit omitted-error count. This bounds added diagnostics,
not Vitest's own captured logs or memory. No error objects or stacks are retained
in the worker metadata after emission.

Nested `cause` and `AggregateError.errors` evidence is also retained, including
serialized error records and explicit undefined rejection values. Only the
boolean `localCommitSucceeded`, `retrySafe`, and `nativeCommitApplied` fields are
copied beyond name/message/stack; arbitrary payload properties are not inspected.
Nested expansion has a four-level depth limit, 16 expanded nodes, four children
per aggregate, and a shared 32,768-character text budget. Explicit markers and
`errorEvidence` counters expose truncation or unreadable fields. These additional
bounds do not reduce the existing top-level text limits. Hostile getters or
cycles cannot throw through the diagnostic serializer or replace readable
original fields. The ordinary reporter remains unchanged.

Run the same gate locally from the repository root:

```sh
pnpm --filter @peerbit/shared-fs exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
pnpm --filter @peerbit/shared-fs-cli exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
node --test scripts/shared-fs-strict-tests/regression.test.mjs scripts/shared-fs-strict-tests/error-evidence.test.mjs
```

Append a test-file filter to either Vitest command for a targeted diagnostic run.
The subprocess regression fixtures intentionally include failing and retrying
tests. The outer Node test suite succeeds only when those child processes have
the correct failure evidence and exit codes. It also checks cleanup-hook errors,
retry-then-skip, normal/expected passes, unused retry budgets, bounded diagnostics,
setup/collection errors, accidental omission of the worker runner, and the hang
report of a hung test or after hook (and its absence for fast tests, after its
attempt ended, or when turned off), the probe line ahead of the failure line, a
probe killed at its deadline, and a probe that still removes its files when
nothing reads its output. Vitest
actually retries an expected-failure test when it has an explicit retry budget;
that still fails the strict gate because it consumed an actual retry. All
instrumentation and fixtures are outside the published shared-fs packages.
