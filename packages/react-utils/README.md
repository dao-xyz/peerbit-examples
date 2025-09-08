# @peerbit/react utils

This package includes hooks and utilities used across the examples.

## Tests

- Unit tests run with Mocha against the compiled ESM output.
- There is an opt-in reproduction test for a previously observed persistent lock issue.

Run all tests:

```sh
yarn test
```

Run only the persistent-lock repro (intentionally fails):

```sh
yarn test:repro-lock
```

Notes:
- The repro is gated via `REPRO_LOCK_FAIL=1` and is excluded from normal `yarn test` and CI.
- It simulates sequential sessions sharing a persisted localStorage directory and expects the second session to fail acquiring the singleton lock.