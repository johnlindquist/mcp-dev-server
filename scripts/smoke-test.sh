#!/usr/bin/env bash
# Smoke-test helper: run a command with a TIMEOUT (default 3 s).
# Success = exit 0 OR forced stop after timeout.
set -euo pipefail

TIMEOUT="${TIMEOUT:-3}"

is_windows() {
  [[ "${OS:-}" == "Windows_NT" || "$(uname -s 2>/dev/null)" =~ MINGW|MSYS|CYGWIN ]]
}

run_with_guard() {
  "$@" &               # launch real command
  local pid=$!

  if is_windows; then
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! taskkill PID $pid"
      taskkill.exe /T /F /PID "$pid" >NUL 2>&1 || true
    ) &
  else
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! kill -INT $pid"
      kill -s INT "$pid" 2>/dev/null || true
    ) &
  fi
  local watcher=$!

  # Wait for the command, remember its exit status
  wait "$pid"; local status=$?

  # Clean up watcher
  kill "$watcher" 2>/dev/null || true

  # Linux: 130 = SIGINT; Windows taskkill -> 1.  Treat both as success.
  if [[ $status -eq 0 || $status -eq 130 || ( $status -eq 1 && is_windows ) ]]; then
    echo "✅ Smoke test passed"
    return 0
  fi

  echo "❌ Smoke test failed (exit $status)"
  return "$status"
}

run_with_guard node build/index.mjs 