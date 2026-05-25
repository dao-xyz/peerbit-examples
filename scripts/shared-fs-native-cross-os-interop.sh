#!/usr/bin/env bash
set -euo pipefail

role=""
machine="linux"
address_file=""
expected=""
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

temp_root="${RUNNER_TEMP:-/tmp}"
adapter="$temp_root/peerbit-shared-fs-native-$machine"
state="$temp_root/pbfs-native-interop-$machine-state"
mountpoint="$temp_root/pbfs-native-interop-$machine-mount"
log="$temp_root/pbfs-native-interop-$machine.log"
local_file="$mountpoint/$machine.txt"
local_contents="hello from $machine via native mount"

rm -rf "$state" "$mountpoint" "$log"
mkdir -p "$state" "$mountpoint"

tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount}"
if [ "$(uname -s)" = "Linux" ]; then
  tags="${PEERBIT_SHARED_FS_NATIVE_GO_TAGS:-native_mount fuse3}"
fi

(
  cd packages/shared-fs/native
  go build -tags "$tags" -o "$adapter" .
)

if [ "$role" = "seed" ]; then
  address="$(node packages/shared-fs/cli/lib/esm/bin.js create --directory "$state")"
  mkdir -p "$(dirname "$address_file")"
  printf "%s\n" "$address" > "$address_file"
else
  address="$(tr -d '\r\n' < "$address_file")"
fi

node packages/shared-fs/cli/lib/esm/bin.js mount "$address" "$mountpoint" \
  --directory "$state" \
  --machine "$machine" \
  --native-adapter "$adapter" \
  >"$log" 2>&1 &
mount_pid="$!"

cleanup() {
  kill -INT "$mount_pid" >/dev/null 2>&1 || true
  wait "$mount_pid" >/dev/null 2>&1 || true
  if [ "$(uname -s)" = "Darwin" ]; then
    umount "$mountpoint" >/dev/null 2>&1 || true
  else
    fusermount -u "$mountpoint" >/dev/null 2>&1 || fusermount3 -u "$mountpoint" >/dev/null 2>&1 || true
  fi
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

printf "%s" "$local_contents" > "$local_file"
test "$(cat "$local_file")" = "$local_contents"

deadline=$((SECONDS + timeout_seconds))
IFS=',' read -r -a expected_machines <<< "$expected"
for expected_machine in "${expected_machines[@]}"; do
  expected_machine="$(echo "$expected_machine" | xargs)"
  if [ -z "$expected_machine" ]; then
    continue
  fi
  expected_file="$mountpoint/$expected_machine.txt"
  expected_contents="hello from $expected_machine via native mount"
  while true; do
    if [ -f "$expected_file" ] && [ "$(cat "$expected_file" 2>/dev/null || true)" = "$expected_contents" ]; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timed out waiting for $expected_file"
      ls -la "$mountpoint" || true
      exit 1
    fi
    sleep 2
  done
done

echo "native mount interop complete for $machine"
