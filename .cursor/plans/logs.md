Okay, let's craft a plan to ensure the `start_process` tool returns enough initial log lines to capture critical information like the server's port, addressing the issue where the default log limit truncated the necessary output.

The core idea is to adjust the behavior specifically for the *initial* response of `start_process`. We will ensure that the logs returned in that specific response include everything captured during the initial log settling/verification phase, overriding the default limit for this one instance. We'll also slightly increase the maximum time we wait for logs to settle to give slower servers a better chance.

---

**Step-by-Step Guide:**

**Phase 1: Increase Initial Wait Timeout**

1.  **Goal:** Give processes slightly more time to output initial logs, including port information, before the `start_process` call returns.
2.  **File:** `src/constants.ts`
3.  **Action:** Locate the `OVERALL_LOG_WAIT_TIMEOUT_MS` constant and increase its value. A moderate increase should help without excessively delaying the response for fast processes.
    *   **Current Value (Example):** `5000` (5 seconds)
    *   **New Value:** `10000` (10 seconds) - Adjust as needed based on typical server start times.

    ```typescript
    // src/constants.ts
    // ... other constants ...

    // Constants for start_process log settling
    export const LOG_SETTLE_DURATION_MS = 500; // Time without logs to consider settled
    // Increase this timeout to allow more time for initial output capture
    export const OVERALL_LOG_WAIT_TIMEOUT_MS = 10000; // Max time to wait for settling (Increased from 5000)

    // ... other constants ...
    ```

**Phase 2: Modify `_startProcess` Return Logic**

1.  **Goal:** Ensure the `ok()` or `fail()` response from `_startProcess` includes *all* log lines captured up to that point, rather than being limited by `DEFAULT_LOG_LINES`.
2.  **File:** `src/processLogic.ts`
3.  **Locate:** Find the section near the end of the `_startProcess` function where `formatLogsForResponse` is called to prepare the logs for the final return payload. This happens just before the `ok(...)` or `fail(...)` calls.
4.  **Action:** Instead of passing `DEFAULT_LOG_LINES` to `formatLogsForResponse`, pass the *total number of logs currently stored* for that process (`currentInfoAfterWait.logs.length`). This effectively tells `formatLogsForResponse` to return all available lines.

    *   **Find this code block (simplified):**
        ```typescript
        // src/processLogic.ts ~ near end of _startProcess

        // ... (after settle wait and status check) ...
        const currentInfoAfterWait = await checkAndUpdateProcessStatus(label);
        // ... (error handling if !currentInfoAfterWait) ...

        // --- This is the part to modify ---
        const logsToReturn = formatLogsForResponse(
            currentInfoAfterWait.logs.map((l: LogEntry) => l.content),
            DEFAULT_LOG_LINES, // <-- We will change this
        );

        log.info(
            label,
            `Returning result for start_process. Included ${logsToReturn.length} log lines. Status: ${finalStatus}.`,
        );

        if (["starting", "running", "verifying"].includes(finalStatus)) {
            // ... (construct successPayload using logsToReturn) ...
            return ok(textPayload(JSON.stringify(successPayload, null, 2)));
        } else {
            // ... (construct errorPayload using logsToReturn) ...
            return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
        }
        ```

    *   **Modify the `formatLogsForResponse` call:**
        ```typescript
        // src/processLogic.ts ~ near end of _startProcess

        // ... (after settle wait and status check) ...
        const currentInfoAfterWait = await checkAndUpdateProcessStatus(label);
        // ... (error handling if !currentInfoAfterWait) ...

        // --- MODIFIED LINE ---
        // Pass the *actual number* of stored logs to return everything captured so far.
        const logsToReturn = formatLogsForResponse(
            currentInfoAfterWait.logs.map((l: LogEntry) => l.content),
            currentInfoAfterWait.logs.length, // <-- Use the full length here
        );
        // --- END MODIFICATION ---

        // Determine the final status and message
        const finalStatus = currentInfoAfterWait.status;
        let message = `Process "${label}" started (PID: ${currentInfoAfterWait.pid}). Status: ${finalStatus}.`;
        // ... (rest of the message construction logic remains the same) ...

        log.info(
            label,
            `Returning result for start_process. Included ${logsToReturn.length} log lines. Status: ${finalStatus}.`,
        );

        // The rest of the success/fail logic remains the same, using the potentially larger logsToReturn array
        if (["starting", "running", "verifying"].includes(finalStatus)) {
            message = `Process is ${finalStatus}.`;
            // ... (construct successPayload as before) ...
             const successPayload: StartSuccessPayload = {
                label: label,
                message: message,
                status: finalStatus,
                pid: currentInfoAfterWait.pid,
                cwd: currentInfoAfterWait.cwd,
                logs: logsToReturn, // Will now contain all captured logs
                monitoring_hint: `Process is ${finalStatus}. Use check_process_status with label "${label}" for updates.`,
             };
             // ... add log_file_path / tail_command ...
            return ok(textPayload(JSON.stringify(successPayload, null, 2)));
        } else {
            // ... (construct errorPayload as before) ...
            const errorMsg = `Process "${label}" failed to stabilize or exited during startup wait. Final status: ${finalStatus}`;
            // ...
            const errorPayload: StartErrorPayload = {
                error: errorMsg,
                status: finalStatus,
                pid: currentInfoAfterWait.pid,
                exitCode: currentInfoAfterWait.exitCode,
                signal: currentInfoAfterWait.signal,
                logs: logsToReturn, // Will now contain all captured logs
            };
            // ... add log_file_path ...
            return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
        }
        ```

**Phase 3: Verification and Testing**

1.  **Build:** Re-build the project to incorporate the changes:
    ```bash
    npm run build
    ```
2.  **Test:**
    *   Run the MCP server (`node build/index.mjs` or using `npx mcp-pm`).
    *   Use an MCP client (like the MCP Inspector `npm run inspector`, or Cursor itself) to call `start_process` with parameters similar to the ones that caused the original issue (e.g., starting the Next.js dev server `pnpm dev` in the test project).
    *   **Observe:** Examine the `logs` array within the JSON response payload from the `start_process` call.
    *   **Verify:** Confirm that the response *now* includes the complete initial output, including the lines showing the server's address and port (e.g., `   - Local:        http://localhost:3000`).
    *   **Verify `check_process_status`:** Call `check_process_status` for the same process *after* it has started. Ensure that the `log_lines` parameter (or its default) is respected here, returning only the requested number of *recent* lines, confirming that our change only affected the initial `start_process` response.

---

This approach ensures that the critical initial output is always returned by `start_process` by returning all logs captured during its initial wait period, while subsequent log requests via `check_process_status` or `list_processes` still adhere to the specified line limits for brevity. The increased wait timeout provides a slightly larger window for this information to be printed by the target process.