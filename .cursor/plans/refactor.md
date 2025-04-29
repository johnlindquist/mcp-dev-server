Okay, let's break down the file organization refactoring for the `mcp-dev-server` project. The goal is to improve modularity, reduce file size, and group related logic more effectively.

**Core Idea:** We will create several new files to house specific functionalities currently residing within larger files like `processLogic.ts`, `state.ts`, and `toolDefinitions.ts`.

**Disclaimer:** This is a significant refactoring. Proceed carefully, ideally on a separate branch, and test thoroughly after each major step.

---

**Detailed Step-by-Step Guide:**

**Phase 1: Preparation**

1.  **Branching:** Create a new git branch for this refactoring:
    ```bash
    git checkout -b feat/refactor-file-organization
    ```
2.  **Backup:** Ensure your current work is committed or backed up.
3.  **Tooling:** Make sure your linter/formatter (`biome check --write .`) and TypeScript compiler (`npm run build`) are working correctly. You'll use these frequently.

**Phase 2: Extracting Utility and Type Logic**

1.  **Create `src/mcpUtils.ts`:** This file will hold the MCP-specific helper functions currently in `src/types.ts`.
    *   Create the file: `src/mcpUtils.ts`
    *   Move the following functions and related imports from `src/types.ts` to `src/mcpUtils.ts`:
        ```typescript
        // src/mcpUtils.ts
        import type { CallToolResult, ToolContent } from "./types.js"; // Import necessary types

        export const textPayload = (text: string): TextContent =>
        	({ type: "text", text }) as const;

        export const ok = (...c: readonly ToolContent[]): CallToolResult => ({
        	content: [...c],
        });

        export const fail = (...c: readonly ToolContent[]): CallToolResult => ({
        	isError: true,
        	content: [...c],
        });

        export const shape = <T extends ZodRawShape>(x: T) => x; // If ZodRawShape import was needed

        export const safeSubstring = (v: unknown, len = 100): string =>
        	typeof v === "string" ? v.substring(0, len) : "";

        export const isRunning = (status: string) => // Assuming ProcessStatus type is imported
        	status === "running" || status === "verifying";

        export const getResultText = (result: CallToolResult): string | null => {
        	for (const item of result.content) {
        		if (item.type === "text") {
        			return item.text;
        		}
        	}
        	return null;
        };

        // Add any necessary imports (like ZodRawShape if used in shape) at the top
        // You might need to import TextContent, CallToolResult etc. from ./types.ts
        ```
    *   Remove these functions from `src/types.ts`.
    *   Update all files that used these functions (e.g., `processLogic.ts`, `toolDefinitions.ts`, `toolHandler.ts`) to import them from `./mcpUtils.js` instead of `./types.js`.

2.  **Clean up `src/types.ts`:** This file should now primarily contain the project-specific type definitions and the MCP content interfaces.
    *   Ensure `src/types.ts` still exports `ProcessInfo`, `ProcessStatus`, `LogEntry`, `TextContent`, `ImageContent`, `AudioContent`, `ResourceContent`, `ToolContent`, `CallToolResult`, `TextResource`, `BlobResource`.
    *   Remove the `ok`, `fail`, `textPayload`, `shape`, `safeSubstring`, `isRunning`, `getResultText` functions and their related imports if they haven't been moved already.

3.  **Verify:** Run `npm run lint:fix` and `npm run build` to catch import errors. Fix any issues.

**Phase 3: Isolating PTY Management**

1.  **Create `src/ptyManager.ts`:** This file will handle the direct interaction with `node-pty`.
    *   Create the file: `src/ptyManager.ts`
    *   **Goal:** Move the core PTY spawning, writing, and basic signal handling here.
    *   **Move PTY Spawning Logic:** Extract the `pty.spawn(...)` part from `_startProcess` in `src/processLogic.ts` into a new function in `ptyManager.ts`. This function should take necessary parameters (shell, cwd, env, label) and return the `ptyProcess` instance.

        ```typescript
        // src/ptyManager.ts
        import * as pty from "node-pty";
        import { log } from "./utils.js";

        export function spawnPtyProcess(
        	shell: string,
        	cwd: string,
        	env: NodeJS.ProcessEnv,
        	label: string,
        	cols = 80,
        	rows = 30,
        ): pty.IPty {
        	try {
        		const ptyProcess = pty.spawn(shell, [], {
        			name: "xterm-color",
        			cols: cols,
        			rows: rows,
        			cwd: cwd,
        			env: env,
        			encoding: "utf8",
        		});
        		log.debug(label, `PTY process spawned with PID: ${ptyProcess.pid}`);
        		return ptyProcess;
        	} catch (error: unknown) {
        		const errorMsg = `Failed to spawn PTY process: ${error instanceof Error ? error.message : String(error)}`;
        		log.error(label, errorMsg);
        		// Re-throw or handle appropriately – maybe return null or throw a custom error
        		throw new Error(errorMsg); // Or return null and check in caller
        	}
        }

        export function writeToPty(
        	ptyProcess: pty.IPty,
        	data: string,
        	label: string,
        ): boolean {
        	try {
        		ptyProcess.write(data);
        		log.debug(label, `Wrote to PTY: ${data.length} chars`);
        		return true;
        	} catch (error) {
        		log.error(
        			label,
        			`Failed to write to PTY process ${ptyProcess.pid}`,
        			error,
        		);
        		return false;
        	}
        }

        export function killPtyProcess(
        	ptyProcess: pty.IPty,
        	signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
        	label: string,
        ): boolean {
        	try {
        		log.info(
        			label,
        			`Sending ${signal} to PTY process PID ${ptyProcess.pid}...`,
        		);
        		ptyProcess.kill(signal);
        		return true;
        	} catch (error) {
        		log.error(
        			label,
        			`Failed to send ${signal} to PTY process ${ptyProcess.pid}`,
        			error,
        		);
        		return false;
        	}
        }
        ```
    *   **Refactor `_startProcess` (in `src/processLogic.ts`):** Update it to call `spawnPtyProcess` from `ptyManager.ts`. Handle potential errors from spawning.
    *   **Refactor `_stopProcess` (in `src/processLogic.ts`):** Update it to call `killPtyProcess` from `ptyManager.ts`.
    *   **Refactor `_sendInput` (in `src/processLogic.ts`):** Update it to call `writeToPty` from `ptyManager.ts`.
    *   **Update Imports:** Add necessary imports in `processLogic.ts` from `./ptyManager.js` and remove the direct `node-pty` import if no longer needed there.

4.  **Verify:** Run `npm run lint:fix` and `npm run build`. Test process starting, stopping, and input sending.

**Phase 4: Separating Process Lifecycle Logic**

1.  **Create `src/processLifecycle.ts`:** This file will manage what happens *after* a process exits or crashes, including retry logic.
    *   Create the file: `src/processLifecycle.ts`
    *   Move the following functions from `src/state.ts` to `src/processLifecycle.ts`:
        *   `handleExit`
        *   `handleCrashAndRetry`
    *   These functions will need imports for `log`, `managedProcesses`, `updateProcessStatus`, `addLogEntry`, constants (`MAX_RETRIES`, etc.), and potentially `_startProcess` (or its refactored equivalent) for the retry mechanism. You might need to pass `_startProcess` or make it importable.

        ```typescript
        // src/processLifecycle.ts
        import {
        	CRASH_LOOP_DETECTION_WINDOW_MS,
        	DEFAULT_RETRY_DELAY_MS,
        	MAX_RETRIES,
        } from "./constants.js";
        import { _startProcess } from "./processLogic.js"; // May need adjustment if _startProcess is refactored further
        import {
        	managedProcesses,
        	updateProcessStatus,
        	addLogEntry,
        } from "./state.js"; // Assuming state functions remain in state.ts for now
        import { log } from "./utils.js";
        import type { ProcessInfo } from "./types.js"; // Import necessary types

        // --- Paste handleExit function here ---
        export function handleExit(/*...*/) {
        	// ... implementation ...
        	// Make sure all dependencies (log, managedProcesses, updateProcessStatus, addLogEntry) are imported/available
        	// Close log stream logic remains here
        	// Check if retry is needed and call handleCrashAndRetry
        	const processInfo = managedProcesses.get(label);
        	if (processInfo?.status === "crashed") {
        		 if (
        				processInfo.maxRetries !== undefined &&
        				processInfo.maxRetries > 0 &&
        				processInfo.retryDelayMs !== undefined
        			) {
        				void handleCrashAndRetry(label); // Needs access to handleCrashAndRetry
        			} else {
        				log.info(label, "Process crashed, but no retry configured.");
        				addLogEntry(label, "Process crashed. No retry configured.");
        			}
        	}
        }

        // --- Paste handleCrashAndRetry function here ---
        export async function handleCrashAndRetry(/*...*/) {
        	// ... implementation ...
        	// Make sure all dependencies (log, managedProcesses, updateProcessStatus, addLogEntry, constants, _startProcess) are imported/available
            // It calls _startProcess recursively for retries
        	await _startProcess(
        	    // ... existing parameters from processInfo ...
        	    true, // Indicate this is a restart
        	);
        }
        ```
    *   Remove these functions from `src/state.ts`.
    *   Update the `onExit` handler setup in `_startProcess` (within `processLogic.ts`) to call `handleExit` from `./processLifecycle.js`.

2.  **Verify:** Run `npm run lint:fix` and `npm run build`. Test process crashes and restarts if configured.

**Phase 5: Isolating State Management and Supervision**

1.  **Refine `src/state.ts`:** Focus this file purely on holding the state (`managedProcesses`, `zombieCheckIntervalId`) and providing basic accessors/mutators.
    *   Keep `managedProcesses` and `zombieCheckIntervalId` exports.
    *   Keep `addLogEntry` (as it directly modifies `processInfo.logs` and the stream).
    *   Keep `updateProcessStatus` (as it directly modifies `processInfo.status` and related fields).
    *   Keep `removeProcess` (if you still have it, for cleanup).
    *   Ensure `stopAllProcessesOnExit` remains (as it iterates the state map) or move it to a new "supervisor" file if preferred. Let's keep it here for now as it's related to managing the lifecycle of the *entire* set of processes held in state.

2.  **Create `src/processSupervisor.ts`:** This file will handle periodic checks and corrections (like zombie reaping).
    *   Create the file: `src/processSupervisor.ts`
    *   Move the following functions from `src/state.ts` to `src/processSupervisor.ts`:
        *   `doesProcessExist`
        *   `checkAndUpdateProcessStatus` (This function *reads* state and *corrects* it based on OS reality, fitting the supervisor role)
        *   `reapZombies`
        *   `setZombieCheckInterval`
        *   `isZombieCheckActive`
    *   These functions will need imports for `log`, `managedProcesses`, `updateProcessStatus`, potentially `handleCrashAndRetry` (from `processLifecycle.ts`), and node `process`.

        ```typescript
        // src/processSupervisor.ts
        import { managedProcesses, updateProcessStatus } from "./state.js";
        import { handleCrashAndRetry } from "./processLifecycle.js"; // Import retry logic
        import { log } from "./utils.js";
        import type { ProcessInfo } from "./types.js"; // Import necessary types

        // Keep zombieCheckIntervalId managed via exported functions
        let zombieCheckIntervalIdInternal: NodeJS.Timeout | null = null;

        // --- Paste doesProcessExist function here ---
        export function doesProcessExist(/*...*/) { /* ... implementation ... */ }

        // --- Paste checkAndUpdateProcessStatus function here ---
        // This function now calls handleCrashAndRetry if correction leads to 'crashed' state
        export async function checkAndUpdateProcessStatus(
        	label: string,
        ): Promise<ProcessInfo | null> {
            const processInfo = managedProcesses.get(label);
            // ... (existing logic to check pid) ...
            if (/* process is found to be missing */) {
                 updateProcessStatus(label, "crashed", { code: -1, signal: null });
                 // Trigger retry if configured (moved from state.ts)
        			if (
        				processInfo.maxRetries !== undefined &&
        				processInfo.maxRetries > 0 &&
        				processInfo.retryDelayMs !== undefined
        			) {
        				void handleCrashAndRetry(label); // Fire and forget retry
        			}
            }
             return processInfo; // Return potentially updated info
        }


        // --- Paste reapZombies function here ---
        export async function reapZombies() {
            // ... implementation ...
            // Ensure it calls the local checkAndUpdateProcessStatus which handles retries
             for (const [label, processInfo] of managedProcesses.entries()) {
                 // ... existing check logic ...
                 if (/* process is found to be a zombie */) {
                     // checkAndUpdateProcessStatus will handle logging, status update, and retry trigger
                     await checkAndUpdateProcessStatus(label);
                 }
             }
             // ... logging ...
        }

        // --- Paste setZombieCheckInterval function here ---
         export function setZombieCheckInterval(intervalMs: number): void {
        	if (zombieCheckIntervalIdInternal) {
        		clearInterval(zombieCheckIntervalIdInternal);
        	}
        	log.info(null, `Setting zombie process check interval to ${intervalMs}ms.`);
        	zombieCheckIntervalIdInternal = setInterval(() => {
        		void reapZombies();
        	}, intervalMs);
        }

        // --- Paste isZombieCheckActive function here ---
        export function isZombieCheckActive(): boolean {
        	return !!zombieCheckIntervalIdInternal;
        }

        // Function to clear interval (used in main.ts cleanup)
        export function clearZombieCheckInterval(): void {
             if (zombieCheckIntervalIdInternal) {
        		clearInterval(zombieCheckIntervalIdInternal);
                zombieCheckIntervalIdInternal = null;
        	}
        }
        ```
    *   Remove these functions from `src/state.ts`.
    *   Update `main.ts` to import `setZombieCheckInterval` and `clearZombieCheckInterval` from `./processSupervisor.js`.
    *   Update any code calling `checkAndUpdateProcessStatus` (e.g., in `processLogic.ts`, `toolDefinitions.ts`) to import it from `./processSupervisor.js`.

3.  **Verify:** Run `npm run lint:fix` and `npm run build`. Test zombie checking functionality (might require manual process killing).

**Phase 6: Organizing Tool Implementations**

1.  **Create `src/toolImplementations.ts`:** This file will contain the core logic for each MCP tool, separating it from the Zod schemas and registration.
    *   Create the file: `src/toolImplementations.ts`
    *   Move the following internal (`_`) functions from `src/toolDefinitions.ts` to `src/toolImplementations.ts`:
        *   `_checkProcessStatus`
        *   `_listProcesses`
        *   `_stopAllProcesses` (Note: This calls `_stopProcess` which is in `processLogic.ts`)
        *   `_restartProcess` (Note: This calls `_stopProcess` and `_startProcess` from `processLogic.ts`)
        *   `_waitForProcess`
        *   `_getAllLoglines`
        *   `_healthCheck`
    *   Also move the helper `getResultText` from `toolDefinitions.ts` if it's still there (it might have moved to `mcpUtils.ts` already).
    *   These functions will need imports for types, constants, `log`, `managedProcesses`, `checkAndUpdateProcessStatus` (from `processSupervisor.ts`), `_startProcess`, `_stopProcess` (from `processLogic.ts`), `isZombieCheckActive` (from `processSupervisor.ts`), `formatLogsForResponse`, `stripAnsiAndControlChars` (from `utils.ts`), `ok`, `fail`, `textPayload` (from `mcpUtils.ts`).

        ```typescript
        // src/toolImplementations.ts
        import { /* ... necessary imports ... */ } from "./constants.js";
        import { _startProcess, _stopProcess } from "./processLogic.js";
        import { checkAndUpdateProcessStatus, isZombieCheckActive } from "./processSupervisor.js";
        import { managedProcesses } from "./state.js";
        import { /* ... Tool Param Types ... */ } from "./toolDefinitions.js"; // Import param types
        import { fail, ok, textPayload } from "./mcpUtils.js";
        import type { CallToolResult, /* ... other types ... */ } from "./types.js";
        import { formatLogsForResponse, log, stripAnsiAndControlChars } from "./utils.js";
        import type { z } from "zod"; // If using inferred types

        // --- Paste _checkProcessStatus function here ---
        export async function checkProcessStatusImpl(/* params matching CheckProcessStatusParams */): Promise<CallToolResult> { /* ... */ }

        // --- Paste _listProcesses function here ---
        export async function listProcessesImpl(/* params matching ListProcessesParams */): Promise<CallToolResult> { /* ... */ }

        // --- Paste _stopAllProcesses function here ---
        // Needs access to _stopProcess
        export async function stopAllProcessesImpl(): Promise<CallToolResult> { /* ... calls _stopProcess ... */ }

        // --- Paste _restartProcess function here ---
        // Needs access to _stopProcess and _startProcess
        export async function restartProcessImpl(/* params matching RestartProcessParams */): Promise<CallToolResult> { /* ... calls _stopProcess, _startProcess ... */ }

        // --- Paste _waitForProcess function here ---
        export async function waitForProcessImpl(/* params matching WaitForProcessParams */): Promise<CallToolResult> { /* ... */ }

        // --- Paste _getAllLoglines function here ---
        export async function getAllLoglinesImpl(/* params matching GetAllLoglinesParams */): Promise<CallToolResult> { /* ... */ }

        // --- Paste _healthCheck function here ---
        export async function healthCheckImpl(): Promise<CallToolResult> { /* ... */ }

        // Add other necessary helper functions if any were moved
        ```
    *   Rename the functions slightly (e.g., `_checkProcessStatus` to `checkProcessStatusImpl`) to avoid naming conflicts if desired, or keep the underscore convention. Let's rename them by removing the underscore and adding `Impl` suffix for clarity.

2.  **Refactor `src/toolDefinitions.ts`:**
    *   Remove the implementation functions (`_checkProcessStatus`, etc.) that were moved.
    *   Keep the Zod schemas (`StartProcessParams`, `CheckProcessStatusParams`, etc.) and the `registerToolDefinitions` function.
    *   Inside `registerToolDefinitions`, update the `server.tool(...)` calls to import and use the implementation functions from `./toolImplementations.js`.

        ```typescript
        // src/toolDefinitions.ts
        import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
        import { z } from "zod";
        import { /* ... constants ... */ } from "./constants.js";
        import { _sendInput, _startProcess } from "./processLogic.js"; // Keep imports for tools implemented directly here or in processLogic
        import { handleToolCall } from "./toolHandler.js";
        import { shape } from "./mcpUtils.js"; // Use shape from mcpUtils

        // Import implementations
        import {
        	checkProcessStatusImpl,
        	listProcessesImpl,
        	stopAllProcessesImpl,
        	restartProcessImpl,
        	waitForProcessImpl,
        	getAllLoglinesImpl,
        	healthCheckImpl,
        } from "./toolImplementations.js";

        // --- Keep Zod Schemas (StartProcessParams, CheckProcessStatusParams, etc.) ---
        // Export SendInputParams if needed by toolImplementations.ts
        export { SendInputParams };

        export function registerToolDefinitions(server: McpServer): void {
        	// start_process might still call _startProcess directly
        	server.tool("start_process", /*...*/ (params) => handleToolCall(/*...*/ async () => _startProcess(/*...*/)) );

            // Update other tools to use imported implementations
        	server.tool("check_process_status", /*...*/ (params) => handleToolCall(params.label, "check_process_status", params, () => checkProcessStatusImpl(params)) );
        	server.tool("stop_process", /*...*/ (params) => handleToolCall(params.label, "stop_process", params, async () => _stopProcess(params.label, params.force)) ); // Calls _stopProcess directly
        	server.tool("list_processes", /*...*/ (params) => handleToolCall(null, "list_processes", params, () => listProcessesImpl(params)) );
        	server.tool("stop_all_processes", /*...*/ (params) => handleToolCall(null, "stop_all_processes", params, stopAllProcessesImpl) ); // Use Impl function
        	server.tool("restart_process", /*...*/ (params) => handleToolCall(params.label, "restart_process", params, () => restartProcessImpl(params)) ); // Use Impl function
        	server.tool("wait_for_process", /*...*/ (params) => handleToolCall(params.label, "wait_for_process", params, () => waitForProcessImpl(params)) ); // Use Impl function
        	server.tool("get_all_loglines", /*...*/ (params) => handleToolCall(params.label, "get_all_loglines", params, () => getAllLoglinesImpl(params)) ); // Use Impl function
        	server.tool("health_check", /*...*/ (params) => handleToolCall(null, "health_check", params, healthCheckImpl) ); // Use Impl function
        	server.tool("send_input", /*...*/ (params) => handleToolCall(params.label, "send_input", params, () => _sendInput(params)) ); // Calls _sendInput directly

        	log.info(null, "Tool definitions registered.");
        }

        ```
    *   Note: `start_process`, `stop_process`, and `send_input` still directly call functions in `processLogic.ts`. This is acceptable, as `processLogic.ts` now acts more like the core orchestrator for process actions.

3.  **Verify:** Run `npm run lint:fix` and `npm run build`. Test various tool calls.

**Phase 7: Final Cleanup and Review**

1.  **Review `src/processLogic.ts`:** This file should now be smaller, focusing on orchestrating process start/stop/input by calling `ptyManager`, setting up listeners that call `processLifecycle`, and potentially handling verification logic (or that could be extracted further to `processVerification.ts` if `_startProcess` is still too large). Check if `_waitForLogSettleOrTimeout` still fits here or could move to `utils.ts` or `ptyManager.ts`. Let's leave it here for now.
2.  **Check Imports:** Ensure there are no unnecessary imports in any file.
3.  **Lint and Format:** Run `pnpm run lint:fix` one last time.
4.  **Build:** Run `npm run build` to confirm everything compiles.
5.  **Test:** Perform thorough testing of all functionalities: starting, stopping (force/graceful), restarting, checking status, listing, waiting, sending input, health check, handling crashes (with/without retries), log viewing, file logging persistence.
6.  **Update Documentation:** If you have internal documentation (like `.cursor/rules/module-structure.mdc`), update it to reflect the new file organization.

---

This refactoring creates a more organized structure where:

*   `ptyManager.ts`: Handles raw PTY interactions.
*   `processLifecycle.ts`: Handles events like exit and crash/retry.
*   `processSupervisor.ts`: Handles periodic checks and state correction (zombies).
*   `state.ts`: Holds the core process state map and simple mutators.
*   `processLogic.ts`: Orchestrates the start/stop/input actions, coordinating other modules.
*   `toolImplementations.ts`: Contains the logic for MCP tools.
*   `toolDefinitions.ts`: Defines MCP tool schemas and registers them.
*   `mcpUtils.ts`: Contains MCP-specific helpers.
*   `types.ts`: Contains project-specific types.
*   `utils.ts`: Contains general utilities (logging, string manipulation).
*   `main.ts` / `index.ts`: Entry point and server setup.
*   `constants.ts`: Shared constants.
*   `toolHandler.ts`: Generic tool call wrapper.

Remember to commit frequently during this process. Good luck!