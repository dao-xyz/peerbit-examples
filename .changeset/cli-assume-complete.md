---
"@peerbit/shared-fs-cli": minor
---

- `--assume-complete` on `mount`, `resolve-conflict` and
  `resolve-naming-conflict`: if the replica's view is not proven within
  `--write-ready-timeout-ms` and no required peer can still answer (no peer,
  none write-ready, or every required peer stays silent), it is assumed
  complete instead of failing (the library's `assumeComplete()`), and the
  replica records source `operator` for later runs too. Rows held only by
  peers it did not reconcile with are missing from its view. While a required
  peer is still being asked, also beside a silent one, the command fails and
  says the flag was not applied. It is refused with `--allow-partial-writes`,
  and not applied while a snapshot bootstrap has not settled; the error names
  the wait that lets it settle within one run.
- While a command waits for write readiness it shows one progress line on
  stderr naming what it waits for. A timeout names `--assume-complete` where
  it applies.
- `--write-ready-timeout-ms` must be an integer from 1 to 2147483647 (Node's
  timer limit); other values are refused before anything opens.
- `mount` prints its write readiness source. `status` says why a join is
  pending, and `--json` includes `bootstrap.readiness`.
- `snapshot` waits for write readiness (`--write-ready-timeout-ms`, default
  120 s) instead of a quiet period. `--settle-seconds` is removed.
