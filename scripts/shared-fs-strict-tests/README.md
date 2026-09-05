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

The original failure is emitted once per test. Each diagnostic string is limited
to 16,384 characters with an explicit truncation marker; at most four errors are
included, with an explicit omitted-error count. This bounds added diagnostics,
not Vitest's own captured logs or memory. No error objects or stacks are retained
in the worker metadata after emission.

Run the same gate locally from the repository root:

```sh
pnpm --filter @peerbit/shared-fs exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
pnpm --filter @peerbit/shared-fs-cli exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
node --test scripts/shared-fs-strict-tests/regression.test.mjs
```

Append a test-file filter to either Vitest command for a targeted diagnostic run.
The subprocess regression fixtures intentionally include failing and retrying
tests. The outer Node test suite succeeds only when those child processes have
the correct failure evidence and exit codes. It also checks cleanup-hook errors,
retry-then-skip, normal/expected passes, unused retry budgets, bounded diagnostics,
setup/collection errors, and accidental omission of the worker runner. Vitest
actually retries an expected-failure test when it has an explicit retry budget;
that still fails the strict gate because it consumed an actual retry. All
instrumentation and fixtures are outside the published shared-fs packages.
