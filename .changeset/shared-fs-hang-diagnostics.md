---
---

Make a hung shared-fs test say where it hangs. The strict test runner
prints a `shared-fs.hang-report` line (active handles, event loop delay,
load, memory and the live readiness runtimes) and a `shared-fs.hang-probe`
line (write and fsync latency in the temp and working directories,
measured by a child process) once a test attempt runs past 30 s
(`SHARED_FS_HANG_REPORT_MS`; 0 disables). The readiness-escape sidecar
test and the on-disk snapshot-segment-gc tests fail with the step that
stalled instead of an anonymous 120 s timeout. Test-only; no package
change.
