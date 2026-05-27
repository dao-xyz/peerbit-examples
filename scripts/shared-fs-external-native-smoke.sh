#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

adapter="${RUNNER_TEMP:-/tmp}/peerbit-shared-fs-native"
state="${RUNNER_TEMP:-/tmp}/pbfs-state"
mountpoint="${RUNNER_TEMP:-/tmp}/pbfs-mount"
log="${RUNNER_TEMP:-/tmp}/pbfs-mount.log"

unmount_path() {
  local target="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    umount "$target" >/dev/null 2>&1 ||
      umount -f "$target" >/dev/null 2>&1 ||
      diskutil unmount force "$target" >/dev/null 2>&1 ||
      true
  else
    fusermount -u "$target" >/dev/null 2>&1 || fusermount3 -u "$target" >/dev/null 2>&1 || true
  fi
}

remove_path() {
  local target="$1"
  rm -rf "$target" >/dev/null 2>&1 && return 0
  unmount_path "$target"
  rm -rf "$target" >/dev/null 2>&1 && return 0
  return 1
}

if ! remove_path "$mountpoint"; then
  echo "Could not remove stale mountpoint $mountpoint; using a unique mountpoint." >&2
  mountpoint="$(mktemp -d "${RUNNER_TEMP:-/tmp}/pbfs-mount.XXXXXX")"
fi
rm -rf "$state" "$log"
mkdir -p "$state" "$mountpoint"

tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount}"
if [ "$(uname -s)" = "Linux" ]; then
  tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount fuse3}"
fi

(
  cd packages/shared-fs/native
  go build -tags "$tags" -o "$adapter" .
)

address="$(node packages/shared-fs/cli/lib/esm/bin.js create --directory "$state" --no-replicate)"
node packages/shared-fs/cli/lib/esm/bin.js mount "$address" "$mountpoint" \
  --directory "$state" \
  --no-replicate \
  --native-adapter "$adapter" \
  >"$log" 2>&1 &
mount_pid="$!"

cleanup() {
  kill -INT "$mount_pid" >/dev/null 2>&1 || true
  wait "$mount_pid" >/dev/null 2>&1 || true
  unmount_path "$mountpoint"
}

finish() {
  status="$?"
  if [ "$status" -ne 0 ]; then
    cat "$log" || true
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

for _ in {1..90}; do
  if grep -q "Mounted " "$log"; then
    break
  fi
  if ! kill -0 "$mount_pid" >/dev/null 2>&1; then
    cat "$log"
    exit 1
  fi
  sleep 1
done
grep -q "Mounted " "$log" || { cat "$log"; exit 1; }

mkdir "$mountpoint/docs"
printf "hello external native" > "$mountpoint/docs/hello.txt"
test "$(cat "$mountpoint/docs/hello.txt")" = "hello external native"
mv "$mountpoint/docs/hello.txt" "$mountpoint/docs/renamed.txt"
test "$(cat "$mountpoint/docs/renamed.txt")" = "hello external native"
rm "$mountpoint/docs/renamed.txt"
