#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

adapter="${RUNNER_TEMP:-/tmp}/peerbit-shared-fs-native"
state="${RUNNER_TEMP:-/tmp}/pbfs-state"
mountpoint="${RUNNER_TEMP:-/tmp}/pbfs-mount"
log="${RUNNER_TEMP:-/tmp}/pbfs-mount.log"
readiness_mountpoint=""
readiness_pid=""

is_mountpoint() {
  local target="$1"
  if [ "$(uname -s)" != "Darwin" ] && command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q -- "$target"
  else
    mount | awk -v target="$target" '
      index($0, " on " target " (") { found = 1 }
      END { exit found ? 0 : 1 }
    '
  fi
}

unmount_path() {
  local target="$1"
  if ! is_mountpoint "$target"; then
    return 0
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    umount "$target" >/dev/null 2>&1 ||
      umount -f "$target" >/dev/null 2>&1 ||
      diskutil unmount force "$target" >/dev/null 2>&1 ||
      true
  else
    fusermount -u "$target" >/dev/null 2>&1 ||
      fusermount3 -u "$target" >/dev/null 2>&1 ||
      true
  fi
  for _ in {1..20}; do
    if ! is_mountpoint "$target"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stat_mode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f "%Lp" "$1"
  else
    stat -c "%a" "$1"
  fi
}

stat_mtime() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f "%m" "$1"
  else
    stat -c "%Y" "$1"
  fi
}

remove_path() {
  local target="$1"
  # Never recursively remove a path until it is known not to be a mount. A
  # stale live mount exposes shared data below this directory.
  unmount_path "$target" || return 1
  is_mountpoint "$target" && return 1
  if [ -e "$target" ]; then
    rmdir "$target" >/dev/null 2>&1 || return 1
  fi
}

if ! remove_path "$mountpoint"; then
  echo "Could not safely remove stale mountpoint $mountpoint; using a unique mountpoint." >&2
  mountpoint="$(mktemp -d "${RUNNER_TEMP:-/tmp}/pbfs-mount.XXXXXX")"
fi
rm -rf "$state" "$log"
mkdir -p "$state" "$mountpoint"

tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount}"
if [ "$(uname -s)" = "Linux" ]; then
  tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount fuse3}"
fi

single_line_detail() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '\r\n' ' ' | cut -c 1-256)"
  if [ -z "$value" ]; then
    value="unknown"
  fi
  printf '%s' "$value"
}

go_version="$(single_line_detail "$(go version 2>/dev/null || true)")"
mount_runtime="unknown"
if [ "$(uname -s)" = "Darwin" ]; then
  macfuse_version="$(
    defaults read /Library/Filesystems/macfuse.fs/Contents/Info CFBundleShortVersionString 2>/dev/null ||
      pkgutil --pkg-info com.github.macfuse.pkg.Core 2>/dev/null | awk -F ': ' '$1 == "version" { print $2; exit }' ||
      true
  )"
  macfuse_version="$(single_line_detail "$macfuse_version")"
  mount_runtime="macFUSE $macfuse_version"
elif [ "$(uname -s)" = "Linux" ]; then
  fuse3_version="$(pkg-config --modversion fuse3 2>/dev/null || true)"
  if [ -z "$fuse3_version" ] && command -v fusermount3 >/dev/null 2>&1; then
    fuse3_version="$(fusermount3 --version 2>&1 | head -n 1 || true)"
  fi
  fuse3_version="$(single_line_detail "$fuse3_version")"
  mount_runtime="fuse3 $fuse3_version"
fi
mount_runtime="$(single_line_detail "$mount_runtime")"

(
  cd packages/shared-fs/native
  go build -tags "$tags" -o "$adapter" .
)

address="$(node packages/shared-fs/cli/lib/esm/bin.js create --directory "$state")"
node packages/shared-fs/cli/lib/esm/bin.js mount "$address" "$mountpoint" \
  --directory "$state" \
  --native-adapter "$adapter" \
  >"$log" 2>&1 &
mount_pid="$!"

wait_for_mount_exit() {
  local attempts="$1"
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    if ! kill -0 "$mount_pid" >/dev/null 2>&1; then
      wait "$mount_pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
  return 1
}

signal_child_processes() {
  local parent_pid="$1"
  local signal="$2"
  local child_pid
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  while IFS= read -r child_pid; do
    if [ -n "$child_pid" ]; then
      kill "-$signal" "$child_pid" >/dev/null 2>&1 || true
    fi
  done < <(pgrep -P "$parent_pid" 2>/dev/null || true)
}

stop_readiness_process() {
  if [ -z "$readiness_pid" ]; then
    return 0
  fi
  if ! kill -0 "$readiness_pid" >/dev/null 2>&1; then
    wait "$readiness_pid" >/dev/null 2>&1 || true
    readiness_pid=""
    return 0
  fi
  # The Node smoke owns signal-aware graceful cleanup. Give it time to detach
  # its adapter before falling back to killing the still-attached process tree.
  kill -TERM "$readiness_pid" >/dev/null 2>&1 || true
  for _ in {1..80}; do
    if ! kill -0 "$readiness_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if kill -0 "$readiness_pid" >/dev/null 2>&1; then
    signal_child_processes "$readiness_pid" KILL
    kill -KILL "$readiness_pid" >/dev/null 2>&1 || true
  fi
  wait "$readiness_pid" >/dev/null 2>&1 || true
  readiness_pid=""
}

cleanup() {
  local cleanup_status=0
  stop_readiness_process
  if kill -0 "$mount_pid" >/dev/null 2>&1; then
    kill -INT "$mount_pid" >/dev/null 2>&1 || true
    if ! wait_for_mount_exit 10; then
      unmount_path "$mountpoint" || true
      signal_child_processes "$mount_pid" TERM
      kill -TERM "$mount_pid" >/dev/null 2>&1 || true
      if ! wait_for_mount_exit 5; then
        signal_child_processes "$mount_pid" KILL
        kill -KILL "$mount_pid" >/dev/null 2>&1 || true
      fi
    fi
  fi
  wait "$mount_pid" >/dev/null 2>&1 || true
  if [ -n "$readiness_mountpoint" ]; then
    if ! unmount_path "$readiness_mountpoint" || is_mountpoint "$readiness_mountpoint"; then
      echo "Readable-first mountpoint remained attached after cleanup: $readiness_mountpoint" >&2
      cleanup_status=1
    elif [ -d "$readiness_mountpoint" ] && ! rmdir "$readiness_mountpoint" >/dev/null 2>&1; then
      echo "Readable-first mountpoint was not empty after unmount; leaving it untouched: $readiness_mountpoint" >&2
      cleanup_status=1
    fi
  fi
  if ! unmount_path "$mountpoint" || is_mountpoint "$mountpoint"; then
    echo "Mountpoint remained attached after cleanup: $mountpoint" >&2
    cleanup_status=1
  elif [ -d "$mountpoint" ] && ! rmdir "$mountpoint" >/dev/null 2>&1; then
    echo "Owned mountpoint was not empty after unmount; leaving it untouched: $mountpoint" >&2
    cleanup_status=1
  fi
  return "$cleanup_status"
}

finish() {
  status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    cat "$log" || true
  fi
  if ! cleanup && [ "$status" -eq 0 ]; then
    status=1
  fi
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

assert_mount_ready() {
  if ! kill -0 "$mount_pid" >/dev/null 2>&1; then
    echo "Mount process exited before filesystem operations" >&2
    return 1
  fi
  if ! is_mountpoint "$mountpoint"; then
    echo "Expected an active mount at $mountpoint" >&2
    return 1
  fi
}

assert_mount_ready

readiness_mountpoint="$(mktemp -d "${RUNNER_TEMP:-/tmp}/pbfs-readable-first.XXXXXX")"
node scripts/shared-fs-readable-first-native-smoke.mjs \
  --adapter "$adapter" \
  --mountpoint "$readiness_mountpoint" &
readiness_pid="$!"
readiness_finished=0
for _ in {1..360}; do
  if ! kill -0 "$readiness_pid" >/dev/null 2>&1; then
    readiness_finished=1
    break
  fi
  sleep 0.25
done
if [ "$readiness_finished" -ne 1 ]; then
  echo "Readable-first native smoke did not exit within 90 seconds" >&2
  exit 1
fi
readiness_status=0
wait "$readiness_pid" || readiness_status="$?"
readiness_pid=""
if [ "$readiness_status" -ne 0 ]; then
  echo "Readable-first native smoke failed with exit code $readiness_status" >&2
  exit "$readiness_status"
fi
if is_mountpoint "$readiness_mountpoint"; then
  echo "Readable-first smoke mount remained attached: $readiness_mountpoint" >&2
  exit 1
fi
rmdir "$readiness_mountpoint"
readiness_mountpoint=""

mkdir "$mountpoint/docs"
printf "hello external native" > "$mountpoint/docs/hello.txt"
test "$(cat "$mountpoint/docs/hello.txt")" = "hello external native"

metadata_path="$mountpoint/docs/hello.txt"
mode_before="$(stat_mode "$metadata_path")"
if chmod 600 "$metadata_path" 2>/dev/null; then
  echo "chmod unexpectedly succeeded for synthetic Shared FS metadata" >&2
  exit 1
fi
test "$(stat_mode "$metadata_path")" = "$mode_before"

mtime_before="$(stat_mtime "$metadata_path")"
if touch -t 200001010000 "$metadata_path" 2>/dev/null; then
  echo "explicit timestamp update unexpectedly succeeded for synthetic Shared FS metadata" >&2
  exit 1
fi
test "$(stat_mtime "$metadata_path")" = "$mtime_before"

mv "$mountpoint/docs/hello.txt" "$mountpoint/docs/renamed.txt"
test "$(cat "$mountpoint/docs/renamed.txt")" = "hello external native"
rm -f "$mountpoint/docs/renamed.txt"
test ! -e "$mountpoint/docs/renamed.txt"
rmdir "$mountpoint/docs"
test ! -e "$mountpoint/docs"

# Opt-in, report-only filesystem-path benchmarks. Each benchmark owns and
# removes only its unique child directory below the supplied path.
if [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT:-}" ] ||
  [ -n "${PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT:-}" ]; then
  if [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT:-}" ] &&
    [ "$PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT" = "${PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT:-}" ]; then
    echo "Mounted and control benchmark outputs must be different files." >&2
    exit 1
  fi
  benchmark_common_args=(
    --samples "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES:-30}"
    --warmups "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS:-3}"
    --timeout-ms "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS:-600000}"
    --implementation-detail "adapter.buildTags=$tags"
    --implementation-detail "adapter.goVersion=$go_version"
    --implementation-detail "mount.runtime=$mount_runtime"
    --implementation-input "$adapter"
    --implementation-input packages/shared-fs/cli/lib/esm
    --implementation-input packages/shared-fs/library/lib/esm
  )
fi

if [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT:-}" ]; then
  assert_mount_ready
  benchmark_args=(
    scripts/shared-fs-native-mount-benchmark.mjs
    --mount "$mountpoint"
    --output "$PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT"
    --target-kind shared-fs-mount
    --target-label "Shared FS mount (external FUSE/macFUSE)"
    --mount-option "-s"
    "${benchmark_common_args[@]}"
  )
  if [ "${PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG:-}" = "1" ]; then
    benchmark_args+=(--mount-option "-d")
  fi
  node "${benchmark_args[@]}"
  assert_mount_ready
fi

if [ -n "${PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT:-}" ]; then
  assert_mount_ready
  control_root="${RUNNER_TEMP:-/tmp}"
  if [ ! -d "$control_root" ]; then
    echo "Local filesystem control root is not a directory: $control_root" >&2
    exit 1
  fi
  node scripts/shared-fs-native-mount-benchmark.mjs \
    --mount "$control_root" \
    --output "$PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT" \
    --target-kind local-filesystem-control \
    --target-label "local filesystem control ($(uname -s))" \
    "${benchmark_common_args[@]}"
  assert_mount_ready
fi
