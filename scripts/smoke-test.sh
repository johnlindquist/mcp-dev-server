#!/usr/bin/env bash
# Run a command with a 3-second guard. Return 0 if it finishes or times out.

set -euo pipefail

run_with_guard() {
  ( "$@" & pid=$!             # launch in background, capture PID
    sleep 3                   # guard duration
    kill -s INT $pid 2>/dev/null || true   # politely stop if still running
  ) &
  wait $pid                   # wait for process (or INT) to finish
  return $?                   # propagate exit code
}

run_with_guard node build/index.mjs
EXIT=$?

if [[ $EXIT -eq 0 || $EXIT -eq 130 ]]; then   # 130 = SIGINT
  echo "✅ Smoke test passed"
  exit 0
else
  echo "❌ Smoke test failed"
  exit $EXIT
fi 