#!/usr/bin/env bash
set -euo pipefail

role=""
machine="linux"
address_file=""
expected=""
expected_acks=""
metrics_file=""
timeout_seconds="2100"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)
      role="$2"
      shift 2
      ;;
    --machine)
      machine="$2"
      shift 2
      ;;
    --address-file)
      address_file="$2"
      shift 2
      ;;
    --expected)
      expected="$2"
      shift 2
      ;;
    --expected-acks)
      expected_acks="$2"
      shift 2
      ;;
    --metrics-file)
      metrics_file="$2"
      shift 2
      ;;
    --timeout-seconds)
      timeout_seconds="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$role" != "seed" ] && [ "$role" != "join" ]; then
  echo "--role must be seed or join" >&2
  exit 2
fi
if [ -z "$address_file" ]; then
  echo "--address-file is required" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

temp_root="${RUNNER_TEMP:-/tmp}"
adapter="$temp_root/peerbit-shared-fs-native-$machine"
state="$temp_root/pbfs-native-interop-$machine-state"
mountpoint="$temp_root/pbfs-native-interop-$machine-mount"
log="$temp_root/pbfs-native-interop-$machine.log"
observations_file="$temp_root/pbfs-native-interop-$machine-observations.tsv"
mount_pid=""
script_status=0
started_at_ms="$(now_ms)"
ended_at_ms=""
adapter_build_ms=""
address_ms=""
mount_ready_ms=""
local_write_ms=""
ack_write_ms=""
local_rename_ms=""
local_delete_ms=""
cleanup_ms=""

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
  mountpoint="$(mktemp -d "$temp_root/pbfs-native-interop-$machine-mount.XXXXXX")"
fi
rm -rf "$state" "$log" "$observations_file"
mkdir -p "$state" "$mountpoint"
touch "$observations_file"

local_file="$mountpoint/$machine.txt"
local_contents="hello from $machine via native mount"
ack_file="$mountpoint/$machine-ack.txt"
ack_contents="acked by $machine via native mount"
rename_source_file="$mountpoint/$machine-rename-source.txt"
rename_target_file="$mountpoint/$machine-rename-target.txt"
rename_contents="rename from $machine via native mount"
rename_ack_file="$mountpoint/$machine-rename-ack.txt"
rename_ack_contents="rename observed by $machine via native mount"

record_observation() {
  printf "%s\t%s\t%s\n" "$1" "$2" "$3" >> "$observations_file"
}

write_metrics() {
  if [ -z "$metrics_file" ]; then
    return
  fi
  mkdir -p "$(dirname "$metrics_file")"
  MACHINE="$machine" \
    ROLE="$role" \
    STATUS="$script_status" \
    STARTED_AT_MS="$started_at_ms" \
    ENDED_AT_MS="$ended_at_ms" \
    ADAPTER_BUILD_MS="$adapter_build_ms" \
    ADDRESS_MS="$address_ms" \
    MOUNT_READY_MS="$mount_ready_ms" \
    LOCAL_WRITE_MS="$local_write_ms" \
    ACK_WRITE_MS="$ack_write_ms" \
    LOCAL_RENAME_MS="$local_rename_ms" \
    LOCAL_DELETE_MS="$local_delete_ms" \
    CLEANUP_MS="$cleanup_ms" \
    node - "$metrics_file" "$observations_file" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [metricsFile, observationsFile] = process.argv.slice(2);
const numberOrNull = (value) =>
	value === undefined || value === "" ? null : Number(value);
const addPhase = (phases, key, envKey) => {
	const value = numberOrNull(process.env[envKey]);
	if (typeof value === "number" && Number.isFinite(value)) {
		phases[key] = value;
	}
};

const phases = {};
addPhase(phases, "adapterBuild", "ADAPTER_BUILD_MS");
addPhase(phases, "address", "ADDRESS_MS");
addPhase(phases, "mountReady", "MOUNT_READY_MS");
addPhase(phases, "localWriteReadback", "LOCAL_WRITE_MS");
addPhase(phases, "ackWriteReadback", "ACK_WRITE_MS");
addPhase(phases, "localRenameReadback", "LOCAL_RENAME_MS");
addPhase(phases, "localDeleteReadback", "LOCAL_DELETE_MS");
addPhase(phases, "cleanup", "CLEANUP_MS");

const observations = fs.existsSync(observationsFile)
	? fs
			.readFileSync(observationsFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [kind, machine, waitMs] = line.split("\t");
				return { kind, machine, waitMs: Number(waitMs) };
			})
	: [];

const startedAtMs = numberOrNull(process.env.STARTED_AT_MS);
const endedAtMs = numberOrNull(process.env.ENDED_AT_MS);
const metrics = {
	schema: 1,
	machine: process.env.MACHINE,
	role: process.env.ROLE,
	status: Number(process.env.STATUS),
	startedAtMs,
	endedAtMs,
	durationMs:
		typeof startedAtMs === "number" && typeof endedAtMs === "number"
			? endedAtMs - startedAtMs
			: null,
	phases,
	observations,
};

fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2) + "\n");
NODE
}

tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount}"
if [ "$(uname -s)" = "Linux" ]; then
  tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount fuse3}"
fi

adapter_build_start_ms="$(now_ms)"
(
  cd packages/shared-fs/native
  go build -tags "$tags" -o "$adapter" .
)
adapter_build_end_ms="$(now_ms)"
adapter_build_ms=$((adapter_build_end_ms - adapter_build_start_ms))

address_start_ms="$(now_ms)"
if [ "$role" = "seed" ]; then
  address="$(node packages/shared-fs/cli/lib/esm/bin.js create --directory "$state")"
  mkdir -p "$(dirname "$address_file")"
  printf "%s\n" "$address" > "$address_file"
else
  address="$(tr -d '\r\n' < "$address_file")"
fi
address_end_ms="$(now_ms)"
address_ms=$((address_end_ms - address_start_ms))

start_mount_process() {
  : >"$log"
  node packages/shared-fs/cli/lib/esm/bin.js mount "$address" "$mountpoint" \
    --directory "$state" \
    --machine "$machine" \
    --native-adapter "$adapter" \
    >"$log" 2>&1 &
  mount_pid="$!"
}

cleanup() {
  cleanup_start_ms="$(now_ms)"
  if [ -n "$mount_pid" ]; then
    kill -INT "$mount_pid" >/dev/null 2>&1 || true
    wait "$mount_pid" >/dev/null 2>&1 || true
  fi
  unmount_path "$mountpoint"
  cleanup_end_ms="$(now_ms)"
  cleanup_ms=$((cleanup_end_ms - cleanup_start_ms))
}

finish() {
  status="$?"
  script_status="$status"
  if [ "$status" -ne 0 ]; then
    cat "$log" || true
  fi
  cleanup
  ended_at_ms="$(now_ms)"
  write_metrics
  exit "$status"
}
trap finish EXIT

mount_start_ms="$(now_ms)"
mount_resolve_attempts="${PEERBIT_SHARED_FS_NATIVE_MOUNT_RESOLVE_ATTEMPTS:-6}"
mount_attempt="0"

while true; do
  mount_attempt=$((mount_attempt + 1))
  start_mount_process
  mount_status="timeout"

  for _ in {1..90}; do
    if grep -q "Mounted " "$log"; then
      mount_status="mounted"
      break
    fi
    if ! kill -0 "$mount_pid" >/dev/null 2>&1; then
      mount_status="exited"
      break
    fi
    sleep 1
  done

  if [ "$mount_status" = "mounted" ]; then
    break
  fi

  if [ "$mount_status" = "exited" ] &&
    grep -q "Failed to resolve program with address" "$log" &&
    [ "$mount_attempt" -lt "$mount_resolve_attempts" ]; then
    cat "$log"
    echo "Mount could not resolve the shared filesystem address; retrying ($mount_attempt/$mount_resolve_attempts)..."
    wait "$mount_pid" >/dev/null 2>&1 || true
    sleep 10
    continue
  fi

  cat "$log"
  exit 1
done
mount_ready_end_ms="$(now_ms)"
mount_ready_ms=$((mount_ready_end_ms - mount_start_ms))

local_write_start_ms="$(now_ms)"
printf "%s" "$local_contents" > "$local_file"
test "$(cat "$local_file")" = "$local_contents"
local_write_end_ms="$(now_ms)"
local_write_ms=$((local_write_end_ms - local_write_start_ms))

wait_for_file_contents() {
  kind="$1"
  expected_machine="$2"
  expected_file="$3"
  expected_contents="$4"
  wait_start_ms="$(now_ms)"

  while true; do
    if [ -f "$expected_file" ] && [ "$(cat "$expected_file" 2>/dev/null || true)" = "$expected_contents" ]; then
      wait_end_ms="$(now_ms)"
      record_observation "$kind" "$expected_machine" "$((wait_end_ms - wait_start_ms))"
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timed out waiting for $expected_file"
      ls -la "$mountpoint" || true
      exit 1
    fi
    sleep 2
  done
}

wait_for_path_absent() {
  kind="$1"
  expected_machine="$2"
  expected_file="$3"
  wait_start_ms="$(now_ms)"

  while true; do
    if [ ! -e "$expected_file" ]; then
      wait_end_ms="$(now_ms)"
      record_observation "$kind" "$expected_machine" "$((wait_end_ms - wait_start_ms))"
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timed out waiting for $expected_file to disappear"
      ls -la "$mountpoint" || true
      exit 1
    fi
    sleep 2
  done
}

deadline=$((SECONDS + timeout_seconds))
IFS=',' read -r -a expected_machines <<< "$expected"
for expected_machine in "${expected_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_file="$mountpoint/$expected_machine.txt"
  expected_contents="hello from $expected_machine via native mount"
  wait_for_file_contents "fileVisible" "$expected_machine" "$expected_file" "$expected_contents"
done

ack_write_start_ms="$(now_ms)"
printf "%s" "$ack_contents" > "$ack_file"
test "$(cat "$ack_file")" = "$ack_contents"
ack_write_end_ms="$(now_ms)"
ack_write_ms=$((ack_write_end_ms - ack_write_start_ms))

IFS=',' read -r -a expected_ack_machines <<< "$expected_acks"
for expected_machine in "${expected_ack_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_file="$mountpoint/$expected_machine-ack.txt"
  expected_contents="acked by $expected_machine via native mount"
  wait_for_file_contents "ackVisible" "$expected_machine" "$expected_file" "$expected_contents"
done

local_rename_start_ms="$(now_ms)"
printf "%s" "$rename_contents" > "$rename_source_file"
mv "$rename_source_file" "$rename_target_file"
test "$(cat "$rename_target_file")" = "$rename_contents"
test ! -e "$rename_source_file"
local_rename_end_ms="$(now_ms)"
local_rename_ms=$((local_rename_end_ms - local_rename_start_ms))

for expected_machine in "${expected_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_source="$mountpoint/$expected_machine-rename-source.txt"
  expected_target="$mountpoint/$expected_machine-rename-target.txt"
  expected_contents="rename from $expected_machine via native mount"
  wait_for_file_contents "renameVisible" "$expected_machine" "$expected_target" "$expected_contents"
  wait_for_path_absent "renameSourceGone" "$expected_machine" "$expected_source"
done

printf "%s" "$rename_ack_contents" > "$rename_ack_file"
test "$(cat "$rename_ack_file")" = "$rename_ack_contents"

for expected_machine in "${expected_ack_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_file="$mountpoint/$expected_machine-rename-ack.txt"
  expected_contents="rename observed by $expected_machine via native mount"
  wait_for_file_contents "renameAckVisible" "$expected_machine" "$expected_file" "$expected_contents"
done

local_delete_start_ms="$(now_ms)"
rm "$rename_target_file"
test ! -e "$rename_target_file"
local_delete_end_ms="$(now_ms)"
local_delete_ms=$((local_delete_end_ms - local_delete_start_ms))

for expected_machine in "${expected_ack_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_file="$mountpoint/$expected_machine-rename-target.txt"
  wait_for_path_absent "deleteVisible" "$expected_machine" "$expected_file"
done

echo "native mount interop complete for $machine"
