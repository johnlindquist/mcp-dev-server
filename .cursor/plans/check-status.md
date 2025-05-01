Okay, here are the instructions for a junior developer to implement the improvement for the `check_process_status` tool, focusing on reducing polling frequency by adding a wait period for active processes.

**Goal:**

Modify the `check_process_status` tool so that if the requested process is currently in an active state (like `running`, `starting`, `verifying`, `restarting`), the tool waits for a short, fixed duration (e.g., 2 seconds) before checking the status again and returning. This prevents rapid, unnecessary polling by the AI agent when waiting for long-running tasks. If the process is already in a terminal state (`stopped`, `crashed`, `error`), it should return immediately as it does now.

**Why:**

Currently, `check_process_status` returns the status immediately. When an AI agent is monitoring a long task (like benchmarks), it calls this tool repeatedly in a tight loop, quickly hitting tool call limits and wasting resources. Adding a small delay on the server side when the process is active allows the process time to potentially finish or change state, making the agent's polling much more efficient.

**How:**

1.  Introduce a mechanism to track *when* the status was last checked or which logs were last returned for a specific process.
2.  In `checkProcessStatusImpl`, if the *initial* check shows an active status, wait for a fixed duration.
3.  After the wait, re-check the process status.
4.  Return the *final* status and only the log lines generated *since the last time logs were returned* for this process.

**Implementation Steps:**

1.  **Update ProcessInfo Type:**
    *   **File:** `src/types.ts`
    *   **Change:** Add a new optional field `lastLogTimestampReturned` to the `ProcessInfo` interface to store the timestamp of the most recent log entry that was sent back in a `check_process_status` response.
    *   **Code:**
        ```typescript
        // src/types.ts

        export interface ProcessInfo {
          // ... existing fields ...
          logFileStream: fs.WriteStream | null;
          lastLogTimestampReturned?: number; // <-- ADD THIS LINE
        }
        ```

2.  **Modify `checkProcessStatusImpl` Logic:**
    *   **File:** `src/toolImplementations.ts`
    *   **Function:** `checkProcessStatusImpl`
    *   **Changes:**
        *   Get the current `lastLogTimestampReturned` before doing anything else.
        *   Perform the *initial* status check using `checkAndUpdateProcessStatus`.
        *   Check the initial status:
            *   If it's `stopped`, `crashed`, or `error`, filter logs based on `lastLogTimestampReturned` and return immediately (similar to existing logic, but with log filtering).
            *   If it's `running`, `starting`, `verifying`, or `restarting`:
                *   Wait for a fixed duration (e.g., 2000ms). Use `await new Promise(resolve => setTimeout(resolve, 2000));`.
                *   After the wait, call `checkAndUpdateProcessStatus` *again* to get the potentially updated `finalProcessInfo`.
                *   Handle the case where `finalProcessInfo` might be null if the process disappeared during the wait.
        *   Filter the logs: Select only log entries from `finalProcessInfo.logs` whose `timestamp` is greater than the `previousLastLogTimestampReturned`.
        *   Update `processInfo.lastLogTimestampReturned`: Set it to the timestamp of the *newest* log entry being returned in the current response, or keep the previous value if no new logs are returned.
        *   Construct the response payload using the *final* status and the *filtered* new logs.
        *   Update the `hint` to reflect that only *new* logs since the last check are being returned.

    *   **Code Snippets:**

        ```typescript
        // src/toolImplementations.ts
        import { checkAndUpdateProcessStatus } from "./processSupervisor.js"; // Ensure this import is correct

        const WAIT_DURATION_MS = 2000; // Fixed wait time

        export async function checkProcessStatusImpl(
          params: z.infer<typeof CheckProcessStatusParams>,
        ): Promise<CallToolResult> {
          const { label, log_lines } = params;

          // --- Get initial state ---
          let initialProcessInfo = await checkAndUpdateProcessStatus(label);
          if (!initialProcessInfo) {
            return fail(textPayload(JSON.stringify({ error: `Process with label "${label}" not found.` })));
          }
          const previousLastLogTimestampReturned = initialProcessInfo.lastLogTimestampReturned ?? 0;

          // --- Check initial status and potentially wait ---
          let finalProcessInfo = initialProcessInfo; // Start with initial info
          const initialStatus = initialProcessInfo.status;

          if (["running", "starting", "verifying", "restarting"].includes(initialStatus)) {
            log.debug(label, `Process is active (${initialStatus}). Waiting for ${WAIT_DURATION_MS}ms before returning status.`);
            await new Promise(resolve => setTimeout(resolve, WAIT_DURATION_MS));

            // Re-check status after the wait
            finalProcessInfo = await checkAndUpdateProcessStatus(label);

            if (!finalProcessInfo) {
              // Process might have disappeared during the wait
              log.warn(label, `Process disappeared during status check wait.`);
              return fail(textPayload(JSON.stringify({ error: `Process "${label}" disappeared during status check.` })));
            }
             log.debug(label, `Wait complete. Final status: ${finalProcessInfo.status}`);
          } else {
             log.debug(label, `Process is in terminal state (${initialStatus}). Returning status immediately.`);
          }


          // --- Filter Logs ---
          const allLogs = finalProcessInfo.logs || [];
          const newLogs = allLogs.filter(
            (entry) => entry.timestamp > previousLastLogTimestampReturned
          );

          // --- Update Timestamp ---
          let newLastLogTimestamp = previousLastLogTimestampReturned;
          if (newLogs.length > 0) {
            // Use the timestamp of the very last entry in the *newLogs* array
             newLastLogTimestamp = newLogs[newLogs.length - 1].timestamp;
             finalProcessInfo.lastLogTimestampReturned = newLastLogTimestamp; // Update the state
             log.debug(label, `Updating lastLogTimestampReturned to ${newLastLogTimestamp}`);
          }


          // --- Format and Construct Response ---
          const requestedLines = log_lines ?? DEFAULT_LOG_LINES; // Use default if not specified
          // Apply requestedLines limit *to the new logs only*
          const logsToReturnRaw = newLogs.slice(-requestedLines);
          const formattedLogs = formatLogsForResponse(
             logsToReturnRaw.map(l => l.content), // Format only the selected new logs
             logsToReturnRaw.length // Pass the actual count being formatted
          );

          const responsePayload: z.infer<typeof CheckStatusPayloadSchema> = {
            label: finalProcessInfo.label,
            status: finalProcessInfo.status,
            pid: finalProcessInfo.pid,
            command: finalProcessInfo.command,
            args: finalProcessInfo.args,
            cwd: finalProcessInfo.cwd,
            exitCode: finalProcessInfo.exitCode,
            signal: finalProcessInfo.signal,
            logs: formattedLogs, // Return only new, formatted logs
            log_file_path: finalProcessInfo.logFilePath,
             tail_command: finalProcessInfo.logFilePath ? `tail -f "${finalProcessInfo.logFilePath}"` : null, // Regenerate just in case
          };

          // Update hint to reflect new log behavior
          const totalNewLogs = newLogs.length;
          if (requestedLines > 0 && totalNewLogs > formattedLogs.length) {
             const shownCount = formattedLogs.length;
             const hiddenCount = totalNewLogs - shownCount;
             responsePayload.hint = `Returned ${shownCount} newest log lines since last check. ${hiddenCount} more new lines were generated but not shown due to limit.`;
          } else if (totalNewLogs > 0) {
             responsePayload.hint = `Returned all ${totalNewLogs} new log lines since last check.`;
          } else {
             responsePayload.hint = "No new log lines since last check.";
          }
          // Add hint if storage limit reached for *all* logs
           if (allLogs.length >= MAX_STORED_LOG_LINES) {
               responsePayload.hint = (responsePayload.hint ? responsePayload.hint + " " : "") + `(Log storage limit: ${MAX_STORED_LOG_LINES} reached).`;
           }


          log.info(label, `check_process_status returning final status: ${finalProcessInfo.status}. New logs returned: ${formattedLogs.length}`);
          return ok(textPayload(JSON.stringify(responsePayload, null, 2)));
        }
        ```

**Considerations:**

*   **Wait Duration:** The `WAIT_DURATION_MS` (e.g., 2000ms) is fixed. This could potentially be made configurable via tool parameters later if needed, but start with a fixed value.
*   **Log Filtering:** Ensure the logic correctly filters logs based on the timestamp and updates `lastLogTimestampReturned` accurately.
*   **Process Exit During Wait:** The code snippet includes a re-check after the wait. If the process exits *during* the wait, the second `checkAndUpdateProcessStatus` call should correctly reflect the new terminal status (`stopped`, `crashed`, etc.).
*   **Error Handling:** The provided snippet includes basic error handling for the process disappearing. Ensure other potential errors are handled gracefully.

**Testing:**

*   Test with a process that runs for longer than the wait duration (e.g., `node -e "setInterval(() => console.log('ping'), 1000);"`). Verify that `check_process_status` waits and returns new logs correctly.
*   Test with a process that finishes quickly. Verify that `check_process_status` returns the `stopped` status immediately without waiting.
*   Test repeatedly calling `check_process_status` on an active process. Verify that subsequent calls only return logs generated *after* the previous call's returned logs.
*   Test the `log_lines` parameter to ensure it correctly limits the number of *new* logs returned.
*   Test what happens if the process crashes or is stopped externally *during* the wait period inside `check_process_status`.