#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

adapter="${RUNNER_TEMP:-/tmp}/peerbit-shared-fs-native"
state="${RUNNER_TEMP:-/tmp}/pbfs-state"
mountpoint="${RUNNER_TEMP:-/tmp}/pbfs-mount"
log="${RUNNER_TEMP:-/tmp}/pbfs-mount.log"

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
mount_args=(
  packages/shared-fs/cli/lib/esm/bin.js mount "$address" "$mountpoint"
  --directory "$state"
  --native-adapter "$adapter"
)
# Opt-in mount profiling writes NDJSON files into a new directory; the CLI
# refuses to reuse existing profile files.
if [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR:-}" ]; then
  mount_args+=(--mount-profile "$PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR")
fi
node "${mount_args[@]}" >"$log" 2>&1 &
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

cleanup() {
  if kill -0 "$mount_pid" >/dev/null 2>&1; then
    kill -INT "$mount_pid" >/dev/null 2>&1 || true
    if ! wait_for_mount_exit 10; then
      unmount_path "$mountpoint" || true
      kill -TERM "$mount_pid" >/dev/null 2>&1 || true
      if ! wait_for_mount_exit 5; then
        kill -KILL "$mount_pid" >/dev/null 2>&1 || true
      fi
    fi
  fi
  wait "$mount_pid" >/dev/null 2>&1 || true
  if ! unmount_path "$mountpoint" || is_mountpoint "$mountpoint"; then
    echo "Mountpoint remained attached after cleanup: $mountpoint" >&2
    return 1
  fi
  if [ -d "$mountpoint" ] && ! rmdir "$mountpoint" >/dev/null 2>&1; then
    echo "Owned mountpoint was not empty after unmount; leaving it untouched: $mountpoint" >&2
    return 1
  fi
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

mkdir "$mountpoint/docs"
printf "hello external native" > "$mountpoint/docs/hello.txt"
test "$(cat "$mountpoint/docs/hello.txt")" = "hello external native"

# Profiled Linux runs check the kernel cache policy: names cached for 0.1 s,
# attributes never. The second of two stats 20 ms apart must then cost exactly
# one getattr: 3 means the -o timeouts did not reach the kernel (a cgofuse that
# clears libfuse's config again), 0 means attributes are cached. The probe
# prints the second stat's wall-clock window; the count is checked after
# unmount, when the adapter has flushed its profile.
getattr_guard_window=""
if [ "$(uname -s)" = "Linux" ] && [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR:-}" ]; then
  getattr_guard_window="$(node --input-type=module -e '
    import { lstatSync } from "node:fs";
    const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let attempt = 0; attempt < 5; attempt++) {
      sleep(200); // cached names expire, so the first stat looks them up
      const first = nowNs();
      lstatSync(process.argv[1]);
      sleep(20); // attributes from the first stat expire at any kernel tick rate
      const from = nowNs();
      lstatSync(process.argv[1]);
      const to = nowNs();
      if (to - first < 80_000_000n) {
        console.log(`${from} ${to}`);
        process.exit(0);
      }
    }
    console.error("Could not run two stats within 80 ms of each other.");
    process.exit(1);
  ' "$mountpoint/docs/hello.txt")"
fi

# Only the exec bit and the mtime are stored.
metadata_path="$mountpoint/docs/hello.txt"
chmod 600 "$metadata_path"
test "$(stat_mode "$metadata_path")" = "644"
TZ=UTC touch -t 200001010000 "$metadata_path"
test "$(stat_mtime "$metadata_path")" = "946684800"
touch -a "$metadata_path"
test "$(stat_mtime "$metadata_path")" = "946684800"

printf '#!/bin/sh\necho tool ok\n' > "$mountpoint/docs/tool.sh"
chmod +x "$mountpoint/docs/tool.sh"
test "$(stat_mode "$mountpoint/docs/tool.sh")" = "755"
test "$(cd "$mountpoint/docs" && ./tool.sh)" = "tool ok"
ln -s tool.sh "$mountpoint/docs/tool-link"
test -L "$mountpoint/docs/tool-link"
test "$(readlink "$mountpoint/docs/tool-link")" = "tool.sh"
test "$(cd "$mountpoint/docs" && ./tool-link)" = "tool ok"
rm "$mountpoint/docs/tool-link"
test ! -L "$mountpoint/docs/tool-link"
test -x "$mountpoint/docs/tool.sh"
rm "$mountpoint/docs/tool.sh"

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
  # Opt-in developer-machine workload (git clone/status, editor save, JSONL
  # appends, SQLite) on both targets. It needs a longer default deadline.
  benchmark_timeout_ms=600000
  case "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD:-}" in
    "") ;;
    1) benchmark_timeout_ms=1800000 ;;
    *)
      echo "PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD must be 1 or unset." >&2
      exit 1
      ;;
  esac
  benchmark_common_args=(
    --samples "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES:-30}"
    --warmups "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS:-3}"
    --timeout-ms "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS:-$benchmark_timeout_ms}"
    --implementation-detail "adapter.buildTags=$tags"
    --implementation-detail "adapter.goVersion=$go_version"
    --implementation-detail "mount.runtime=$mount_runtime"
    --implementation-input "$adapter"
    --implementation-input packages/shared-fs/cli/lib/esm
    --implementation-input packages/shared-fs/library/lib/esm
  )
  if [ -n "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES:-}" ]; then
    benchmark_common_args+=(
      --overwrite-base-bytes "$PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES"
    )
  fi
  # Without the variable the benchmark argv is unchanged.
  if [ "${PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD:-}" = "1" ]; then
    benchmark_common_args+=(--dev-workload)
  fi
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
  if [ "$(uname -s)" = "Linux" ]; then
    # Mirrors nativeMountOptions in packages/shared-fs/native/mount_options.go.
    benchmark_args+=(--mount-option "-o" --mount-option "entry_timeout=0.1,attr_timeout=0,negative_timeout=0")
  fi
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

if [ -n "$getattr_guard_window" ]; then
  # The adapter flushes its profile on unmount, so stop the mount first.
  trap - EXIT
  if ! cleanup; then
    cat "$log" || true
    exit 1
  fi
  # shellcheck disable=SC2086 # the window is two decimal numbers
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file, from, to] = process.argv.slice(1);
    const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!records.some((record) => record.phase === "profile.summary")) {
      console.error(`${file} has no profile.summary record, so the adapter did not flush its profile.`);
      process.exit(1);
    }
    const count = records.filter(
      (record) =>
        record.phase === "native.callback" &&
        record.operation === "getattr" &&
        BigInt(record.startUnixNs) >= BigInt(from) &&
        BigInt(record.startUnixNs) <= BigInt(to)
    ).length;
    if (count !== 1) {
      console.error(`The second of two stats cost ${count} getattr callbacks, expected exactly 1 on Linux (3: the mount options did not reach the kernel; 0: attributes are cached).`);
      process.exit(1);
    }
    console.log("Linux kernel cache check: the second stat cost exactly 1 getattr.");
  ' "$PEERBIT_SHARED_FS_NATIVE_MOUNT_PROFILE_DIR/native-adapter.ndjson" $getattr_guard_window
fi
