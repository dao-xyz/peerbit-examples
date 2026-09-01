#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <install-dir> <peerbit-fs-command...>" >&2
  exit 2
fi

install_dir="$1"
shift

attempts="${SHARED_FS_NATIVE_INSTALL_ATTEMPTS:-30}"
delay_seconds="${SHARED_FS_NATIVE_INSTALL_RETRY_SECONDS:-10}"
error_file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/peerbit-shared-fs-native-install.err"
adapter_command=("$@" install-adapter --prefix "$install_dir" --print-path)
if [ -n "${SHARED_FS_NATIVE_ADAPTER_VERSION:-}" ]; then
  adapter_command+=(--adapter-version "$SHARED_FS_NATIVE_ADAPTER_VERSION")
fi

for ((attempt = 1; attempt <= attempts; attempt++)); do
  rm -f "$error_file"
  if adapter_path="$("${adapter_command[@]}" 2>"$error_file")"; then
    printf '%s\n' "$adapter_path"
    exit 0
  else
    status=$?
  fi

  if ! grep -q "HTTP 404" "$error_file"; then
    cat "$error_file" >&2
    exit "$status"
  fi

  if [ "$attempt" -eq "$attempts" ]; then
    cat "$error_file" >&2
    exit "$status"
  fi

  echo "native adapter release asset is not available yet (attempt $attempt/$attempts); retrying in ${delay_seconds}s" >&2
  sleep "$delay_seconds"
done
