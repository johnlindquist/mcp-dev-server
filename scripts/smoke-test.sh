#!/usr/bin/env bash
# Run any command with a 3-second guard. Treat natural exit **or** SIGINT as success.
set -euo pipefail

timeout_guard() {
  local seconds="$1"; shift

  "$@" &                     # start the real command
  local cmd_pid=$!

  # background watcher that nukes the process after N seconds
  (
    sleep "$seconds"
    kill -s INT "$cmd_pid" 2>/dev/null || true
  ) &
  local watcher_pid=$!

  # wait for the command; capture status
  wait "$cmd_pid"
  local status=$?

  kill "$watcher_pid" 2>/dev/null || true  # clean up watcher
  [[ $status -eq 130 ]] && status=0        # 130 = SIGINT → treat as success
  return $status
}

timeout_guard "${TIMEOUT:-3}" node build/index.mjs
EXIT=$?

if [[ $EXIT -eq 0 || $EXIT -eq 130 ]]; then   # 130 = SIGINT
  echo "✅ Smoke test passed"
  exit 0
else
  echo "❌ Smoke test failed"
  exit $EXIT
fi 