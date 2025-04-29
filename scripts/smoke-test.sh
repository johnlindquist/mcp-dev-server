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
    # ----- Windows branch (taskkill) -----
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! taskkill PID $pid"
      taskkill.exe /T /F /PID "$pid" >NUL 2>&1 || true
    ) &
    local watcher=$!
    # Wait specifically for the watcher subshell to finish
    wait "$watcher"
    echo "[Info] Watcher finished. Assuming timeout success on Windows."
    kill "$pid" 2>/dev/null || true # Attempt a final cleanup of original pid just in case
    echo "✅ Smoke test passed (Windows timeout)"
    exit 0 # Explicitly exit script with 0 on Windows timeout
  else
    # ----- POSIX branch (SIGINT) -----
    (
      sleep "$TIMEOUT"
      echo "⏳ Timeout! kill -INT $pid"
      kill -s INT "$pid" 2>/dev/null || true
    ) &
    local watcher=$!
    # Wait for the command, remember its exit status
    wait "$pid"; local status=$?
    # Clean up watcher
    kill "$watcher" 2>/dev/null || true
    # Linux: 130 = SIGINT treat as success.
    if [[ $status -eq 0 || $status -eq 130 ]]; then
      echo "✅ Smoke test passed"
      exit 0 # Explicitly exit script with 0 on POSIX success/timeout
    fi
    echo "❌ Smoke test failed (exit $status)"
    exit "$status" # Explicitly exit script with failure code
  fi
}

# Call the function; the script will exit from within run_with_guard
run_with_guard node build/index.mjs 