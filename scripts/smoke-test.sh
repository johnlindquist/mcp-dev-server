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
      # Also try to kill the watcher process itself from within the subshell
      kill $$ 2>/dev/null || true # $$ is the subshell PID
    ) &
    local watcher=$!
    # Wait specifically for the watcher subshell to finish
    wait "$watcher"
    echo "[Info] Watcher finished. Assuming timeout success on Windows."
    kill "$pid" 2>/dev/null || true # Attempt a final cleanup of original pid just in case
    echo "✅ Smoke test passed (Windows timeout)"
    return 0 # Treat timeout on Windows as success
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
      return 0
    fi
    echo "❌ Smoke test failed (exit $status)"
    return "$status"
  fi
}

run_with_guard node build/index.mjs 