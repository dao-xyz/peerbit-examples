# Shared FS Native OS CI

The always-on shared-fs CI uses GitHub-hosted runners. It builds on Linux,
macOS, and Windows, and runs a real Linux FUSE mount smoke test.

Real macOS and Windows native mount tests are opt-in because they need host
filesystem drivers:

- macOS requires a Scaleway Apple Silicon runner with kernel extensions enabled
  and macFUSE installed/loadable.
- Windows requires a Scaleway Windows runner with WinFsp installed/loadable.

The `Shared FS Native OS Smoke` workflow provisions temporary Scaleway runners,
registers them as GitHub Actions ephemeral self-hosted runners, runs one native
mount smoke job, then attempts cleanup.

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
runner after it accepts one job. The workflow still deletes the Scaleway
machine in an `always()` cleanup job.

There is also a scheduled janitor in the same workflow:

- Windows runners older than 2 hours are deleted.
- macOS runners older than 26 hours are deleted by default, because Scaleway
  Apple Silicon servers can have a minimum allocation period.

If cleanup cannot delete a server, the local state is intentionally kept so
`pnpm scaleway:stop` can be retried later.
