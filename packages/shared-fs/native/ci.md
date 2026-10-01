# Shared FS Native OS CI

The `Shared FS Native Smoke` workflow mounts the filesystem for real on
GitHub-hosted runners, on every shared-fs pull request and push to master:

- Linux: fuse3 on `ubuntu-latest`.
- Windows: WinFsp on `windows-2025` and `windows-2022`, installed with
  Chocolatey. The smoke builds the adapter without cgo, as releases do.

A manual run of the same workflow can add the mounted and local-control
filesystem benchmarks, the developer workload, and (Linux only) the A-B-B-A
mount profile.

macFUSE needs a kernel extension approved in System Settings, which hosted
runners cannot load. Its smoke (`Shared FS Native OS Smoke`) is opt-in and runs
on a physical Scaleway Apple Silicon host with kernel extensions enabled and
macFUSE installed.

The `Shared FS Native Cross-OS Interop` workflow starts a Linux FUSE seed and
can join `windows`, `macos`, or `all` native peers on Scaleway hosts. The `all`
mode waits for Linux, macOS, and Windows to each write a file through its
native mount, read the other platforms' files, then write and observe ack files.

The Scaleway macOS host is reused while warm because those machines have a
minimum allocation period. Each workflow run still creates a fresh ephemeral
GitHub runner registration, token, and unique label. The interop's Windows host
is likewise pooled and powered off between runs, with a fresh ephemeral runner
registration every run.

A pristine macOS host requires a one-time manual bootstrap before it can run the
macFUSE smoke test. The check script can attempt the Homebrew cask installation
and reports its bounded install log on failure, but an operator must approve
macFUSE in macOS System Settings > Privacy & Security and reboot after the first
installation. Scaleway's kernel-extension flag only allows the approved host to
load kernel extensions; it cannot perform that interactive approval.

## Required GitHub Secrets

The hosted jobs need no secrets. Set these repository secrets before running the
Scaleway workflows:

- `PEERBIT_RUNNER_ADMIN_TOKEN`: GitHub token that can create/delete repository
  self-hosted runners. Use a fine-grained token with repository Administration
  write access, or a classic token with appropriate repo/admin access.
- `SCALEWAY_ACCESS_KEY_ID`: Scaleway API access key id.
- `SCALEWAY_SECRET_ACCESS_KEY`: Scaleway API secret key.
- `PEERBIT_SCALEWAY_SSH_PRIVATE_KEY`: private key used by the provisioner to
  SSH into temporary runners.
- `PEERBIT_SCALEWAY_SSH_PUBLIC_KEY`: matching public key registered with
  Scaleway and authorized on Windows.

Optional:

- `SCALEWAY_PROJECT_ID`: required only when the Scaleway API key does not have a
  default project.

## Optional GitHub Variables

- `PEERBIT_SCALEWAY_ZONE`, default `fr-par-1`.
- `PEERBIT_SCALEWAY_MACOS_SERVER_TYPE`, default `M2-M`.
- `PEERBIT_SCALEWAY_WINDOWS_SERVER_TYPE`, default `POP2-2C-8G-WIN`.
- `PEERBIT_SCALEWAY_WINDOWS_IMAGE`, optional pinned Windows image id.
- `PEERBIT_SCALEWAY_WINDOWS_ROOT_GB`, default `100`.
- `PEERBIT_GITHUB_RUNNER_VERSION`, default `2.330.0`.

## Local Use

Copy `.env.scaleway.example` to `.env.scaleway` and fill in local values. The
real `.env.scaleway` is ignored by git.

```bash
pnpm scaleway:start
pnpm scaleway:status
pnpm scaleway:stop

pnpm scaleway:windows:start
pnpm scaleway:windows:status
pnpm scaleway:windows:stop
```

## Cleanup Model

The runners are registered with `--ephemeral`, so GitHub de-registers each
runner after it accepts one job.

The native smoke and cross-OS interop workflows share one concurrency group so
only one Scaleway native run provisions or reconfigures runners at a time.
Both workflows also run a resource sanity check after cleanup. The check allows
at most one matching pooled physical host per platform; ephemeral GitHub runner
registrations are still expected to be removed after their one job.

For macOS, cleanup releases the runner registration but keeps the reusable
physical Scaleway host warm. The scheduled janitor runs every six hours and
deletes pool hosts once they are at least 26 hours old by default. A healthy
schedule therefore normally reclaims a host about 26–32 hours after creation.

For Windows (used by the interop only), the workflow releases the ephemeral runner registration,
power off the reusable physical instance in an `always()` cleanup job, and keep
it in the pool for a later run. The janitor eventually deletes stale Windows
pool hosts.

There is also a scheduled janitor in the same workflow:

- Windows physical pool hosts at least 2 hours old are deleted.
- macOS physical pool hosts at least 26 hours old are deleted by default,
  because Scaleway Apple Silicon servers can have a minimum allocation period.

If cleanup cannot delete a server, the local state is intentionally kept so
`pnpm scaleway:stop` can be retried later.

To inspect the current native runner resources locally:

```bash
pnpm scaleway:resources -- --mac-max 1 --windows-max 1
```
