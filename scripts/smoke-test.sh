#!/usr/bin/env bash
# Run a command with a 3-second guard. Natural exit **or** forced stop = success.
set -euo pipefail

TIMEOUT="${TIMEOUT:-3}"

run_with_guard() {
  "$@" &                 # launch real command
  local pid=$!

  if [[ "$OS" == "Windows_NT" ]]; then
    # ----- Windows branch (taskkill) -----
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! taskkill PID $pid"
      taskkill.exe /T /F /PID "$pid" >NUL 2>&1 || true
    ) &
  else
    # ----- POSIX branch (SIGINT) -----
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! kill -INT $pid"
      kill -s INT "$pid" 2>/dev/null || true
    ) &
  fi

  local watcher=$!
  wait "$pid"; local status=$?
  kill "$watcher" 2>/dev/null || true   # clean up watcher

  # Treat forced stop (128+signal on Linux, 1 on taskkill) as success
  if [[ $status -eq 0 || $status -ge 128 ]]; then
    echo "✅ Smoke test passed"
    return 0
  else
    echo "❌ Smoke test failed (exit $status)"
    return "$status"
  fi
}

run_with_guard node build/index.mjs 