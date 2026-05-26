# Shared FS Native OS CI

The always-on shared-fs CI uses GitHub-hosted runners. It builds on Linux,
macOS, and Windows, and runs a real Linux FUSE mount smoke test.

Real macOS and Windows native mount tests are opt-in because they need host
filesystem drivers:

- macOS requires a Scaleway Apple Silicon runner with kernel extensions enabled
  and macFUSE installed/loadable.
- Windows requires a Scaleway Windows runner with WinFsp installed/loadable.

The `Shared FS Native OS Smoke` workflow provisions Scaleway runners, registers
GitHub Actions ephemeral self-hosted runners, runs one native mount smoke job,
then attempts cleanup.

The `Shared FS Native Cross-OS Interop` workflow starts a Linux FUSE seed and
can join either `windows`, `macos`, or `all` native peers. The `all` mode waits
for Linux, macOS, and Windows to each write a file through its native mount, read
the other platforms' files, then write and observe ack files.

The macOS path reuses a warm Scaleway Apple Silicon host by default because
those machines have a minimum allocation period. It still creates a fresh
ephemeral GitHub runner registration, token, and unique label for each workflow
run. The Windows path creates and deletes a fresh instance by default.

The reusable macOS host must have macFUSE installed and approved once in macOS
System Settings. Scaleway's kernel-extension flag allows the host to load kernel
extensions, but macFUSE still needs the one-time Privacy & Security approval and
a reboot after first installation.

The macOS and Windows native smoke jobs use the external Go adapter path. The
optional Node `fuse-native` adapter is not part of the required cross-platform
mount path.

## Required GitHub Secrets

Set these repository secrets before running the workflow:

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
Both workflows also run a resource sanity check after cleanup. The check fails
if more than one matching reusable macOS pool host exists or if any matching
ephemeral Windows runner remains.

For macOS, cleanup releases the runner registration but keeps the reusable
Scaleway host warm. The scheduled janitor deletes stale macOS pool hosts after
the configured age threshold.

For Windows, cleanup deletes the Scaleway machine in an `always()` cleanup job.

There is also a scheduled janitor in the same workflow:

- Windows runners older than 2 hours are deleted.
- macOS runners older than 26 hours are deleted by default, because Scaleway
  Apple Silicon servers can have a minimum allocation period.

If cleanup cannot delete a server, the local state is intentionally kept so
`pnpm scaleway:stop` can be retried later.

To inspect the current native runner resources locally:

```bash
pnpm scaleway:resources -- --mac-max 1 --windows-max 0
```
