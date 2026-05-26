#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

has_macfuse_files() {
  [ -d /Library/Filesystems/macfuse.fs ] || command -v mount_macfuse >/dev/null 2>&1
}

has_loaded_macfuse() {
  kextstat 2>/dev/null | grep -qi macfuse
}

if ! has_macfuse_files && command -v brew >/dev/null 2>&1; then
  brew install --cask macfuse || true
fi

if ! has_macfuse_files; then
  cat >&2 <<'MESSAGE'
macFUSE is not installed. Install macFUSE on the reusable Scaleway Mac host
before running shared-fs native mount tests.
MESSAGE
  exit 1
fi

if has_loaded_macfuse; then
  exit 0
fi

load_log="${RUNNER_TEMP:-/tmp}/peerbit-macfuse-load.log"
: >"$load_log"

if [ -x /Library/Filesystems/macfuse.fs/Contents/Resources/load_macfuse ]; then
  /Library/Filesystems/macfuse.fs/Contents/Resources/load_macfuse >>"$load_log" 2>&1 || true
fi

if has_loaded_macfuse; then
  exit 0
fi

for version in 15 14 13 12; do
  kext="/Library/Filesystems/macfuse.fs/Contents/Extensions/$version/macfuse.kext"
  if [ ! -d "$kext" ]; then
    continue
  fi
  sudo -n kmutil load -p "$kext" >>"$load_log" 2>&1 || true
  if has_loaded_macfuse; then
    exit 0
  fi
done

cat >&2 <<'MESSAGE'
macFUSE is installed, but its kernel extension is not loadable.

On Scaleway Apple Silicon this usually means the host was created with kernel
extensions enabled, but macFUSE still needs the one-time approval in macOS
System Settings > Privacy & Security. Approve macFUSE on the reusable Mac host,
reboot it once, then rerun the native shared-fs workflow.
MESSAGE

if [ -s "$load_log" ]; then
  echo "" >&2
  echo "macFUSE load attempts:" >&2
  tail -80 "$load_log" >&2
fi

exit 1
