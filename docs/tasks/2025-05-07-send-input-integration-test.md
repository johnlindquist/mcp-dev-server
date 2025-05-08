# Task: Add/Update Integration Test for send_input Wait-and-Check Behavior

## Commit 1: ✅ test: add integration test for send_input returning check_shell result (79dd650)
**Description:**
Add a new integration test in `tests/integration/prompt-detection.test.ts` (or a new file if preferred) to verify that the `send_input` tool, after sending input to a running shell, waits for 1 second and then returns the result of a `check_shell` call. The test should:
- Start a shell process using the `start_shell` tool.
- Use `send_input` to send a command (e.g., `echo "hello"`).
- Assert that the response from `send_input` includes updated logs and status as would be returned by `check_shell`.
- Optionally, compare the result of a direct `check_shell` call after the input to ensure consistency.
- Clean up by stopping the shell.

**Verification:**
- Run the test with `pnpm test` or `pnpm vitest tests/integration/prompt-detection.test.ts`.
- Confirm that the test passes and that the `send_input` response includes the expected log output and process status.
- Manually inspect the logs in the test output to ensure the 1-second wait and status check are observable.

---

## Commit 2: ✅ refactor: ensure all send_input integration tests assert on returned logs/status (2f74a6c)
**Description:**
Update any existing integration tests in `tests/integration/prompt-detection.test.ts` (and related files) that use `send_input` to also assert on the returned logs and process status, not just on side effects or subsequent `check_shell` calls. This ensures all tests are aligned with the new behavior of `send_input` returning a status payload.

**Verification:**
- Run all integration tests with `pnpm test` or `pnpm vitest`.
- Confirm that all tests using `send_input` now include assertions on the returned logs and status.
- Ensure all tests pass and that failures would indicate a regression in the new behavior.

---

## Commit 3: ✅ docs: document send_input integration test behavior in README (dc704ce)
**Description:**
Update the `README.md` to document the new behavior of the `send_input` tool, specifically that it waits for 1 second and returns the result of a `check_shell` call. Include a code snippet from the new integration test as an example.

**Verification:**
- View the rendered `README.md` and confirm the documentation is clear and accurate.
- Ensure the documented example matches the actual test and tool behavior.

--- 