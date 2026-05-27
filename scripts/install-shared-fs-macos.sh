#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. Use the platform-specific native adapter setup on other systems." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${PEERBIT_SHARED_FS_PREFIX:-$HOME/.local}"
bin_dir="$prefix/bin"
adapter="$bin_dir/peerbit-shared-fs-native"
wrapper="$bin_dir/peerbit-fs"

has_macfuse() {
  [ -d /Library/Filesystems/macfuse.fs ] || command -v mount_macfuse >/dev/null 2>&1
}

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm
  else
    echo "pnpm is required. Install Node.js with corepack or install pnpm, then rerun this script." >&2
    exit 1
  fi
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required to build the native adapter. Install Go, then rerun this script." >&2
  exit 1
fi

if ! has_macfuse; then
  if command -v brew >/dev/null 2>&1; then
    brew install --cask macfuse || true
  fi
fi

if ! has_macfuse; then
  cat >&2 <<'MESSAGE'
macFUSE is required for native mounts on macOS.

Install it from https://macfuse.github.io/ or with:
  brew install --cask macfuse

After installation, approve macFUSE in System Settings > Privacy & Security if
macOS asks, reboot if required, then rerun this script.
MESSAGE
  exit 1
fi

mkdir -p "$bin_dir"
cd "$repo_root"

pnpm install
pnpm -r --sort --filter @peerbit/shared-fs --filter @peerbit/shared-fs-cli run build

(
  cd packages/shared-fs/native
  go build -tags native_mount -o "$adapter" .
)

cat > "$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PEERBIT_SHARED_FS_NATIVE_ADAPTER="\${PEERBIT_SHARED_FS_NATIVE_ADAPTER:-$adapter}"
exec node "$repo_root/packages/shared-fs/cli/lib/esm/bin.js" "\$@"
EOF
chmod +x "$adapter" "$wrapper"

cat <<MESSAGE
Installed Peerbit shared-fs commands:
  $wrapper
  $adapter

Add this to your shell profile if it is not already on PATH:
  export PATH="$bin_dir:\$PATH"

Try:
  peerbit-fs status
  ADDRESS=\$(peerbit-fs create)
  mkdir -p "\$HOME/PeerbitShared"
  peerbit-fs mount "\$ADDRESS" "\$HOME/PeerbitShared"
MESSAGE
