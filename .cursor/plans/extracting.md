Okay, let's analyze the project structure and identify opportunities for extraction and cleanup. Based on the provided files, here are three key areas where refactoring could improve organization and reduce potential duplication or drift:

1.  **Centralize Shared Type Definitions:** Several type definitions, particularly Zod schemas for tool parameters and internal interfaces, are spread across `toolDefinitions.ts` and `toolImplementations.ts`. Moving these to `src/types.ts` consolidates type information, making it easier to manage and reuse.
2.  **Consolidate Process Lifecycle Logic:** The `stopAllProcessesOnExit` function currently resides in `src/state.ts`. While it modifies state (clears the map), its primary function is process management during shutdown, aligning better with the responsibilities of `src/processLifecycle.ts`.
3.  **Extract Magic Constants:** The `WAIT_DURATION_MS` constant used in `src/toolImplementations.ts` is defined inline. Moving it to `src/constants.ts` improves clarity and makes it easier to adjust timing parameters consistently.

Here is a step-by-step plan to implement these changes:

---

### Refactoring Plan

**Goal:** Improve code organization, reduce duplication, and centralize related logic and types.

**1. Centralize Type Definitions in `src/types.ts`**

*   **Why:** Consolidates shared type definitions (like `HostEnum`) and internal interfaces used across different modules, improving maintainability and consistency. Keeps `src/types.ts` as the single source of truth for project-specific types.
*   **Steps:**
    *   **Move `HostEnum` and `HostEnumType` from `src/toolDefinitions.ts` to `src/types.ts`:**
        *   **File:** `src/toolDefinitions.ts`
        *   **Remove:**
            ```typescript
            export const HostEnum = z.enum([
            	"cursor",
            	"claude",
            	"chatgpt",
            	"vscode",
            	"windsurf",
            	"unknown", // Default value
            ]);
            export type HostEnumType = z.infer<typeof HostEnum>;
            ```
        *   **File:** `src/types.ts`
        *   **Add:**
            ```typescript
            import { z } from "zod"; // Add this import if not already present

            // Enum for identifying the host client
            export const HostEnum = z.enum([
            	"cursor",
            	"claude",
            	"chatgpt",
            	"vscode",
            	"windsurf",
            	"unknown",
            ]);
            export type HostEnumType = z.infer<typeof HostEnum>;
            ```
        *   **Update Imports:** Modify imports in files that use `HostEnum` or `HostEnumType` (e.g., `src/toolDefinitions.ts`, `src/processLogic.ts`, `src/state.ts`) to point to `src/types.ts`.
            *   Example change in `src/toolDefinitions.ts`:
                ```diff
                - import type { HostEnumType } from "./toolDefinitions.js"; // <-- IMPORT HostEnumType
                + import type { HostEnumType } from "./types.js"; // <-- IMPORT HostEnumType
                + import { HostEnum } from "./types.js"; // <-- Import the enum itself
                ```
            *   Example change in `src/processLogic.ts`:
                 ```diff
                 - import type { HostEnumType } from "./types.ts"; // Renamed types
                 + import type { HostEnumType } from "./types.ts"; // Renamed types
                 ```
                 *(Ensure it points to `types.ts` if it wasn't already)*
             *   Example change in `src/state.ts` (within `ProcessInfo` interface):
                  ```diff
                  - import type { HostEnumType } from "./toolDefinitions.js"; // <-- IMPORT HostEnumType
                  + import type { HostEnumType } from "./types.js"; // <-- IMPORT HostEnumType
                  ```

    *   **(Optional but Recommended) Move inline interfaces from `src/toolImplementations.ts` to `src/types.ts`:**
        *   **File:** `src/toolImplementations.ts`
        *   **Remove:**
            ```typescript
            interface CheckStatusResponsePayload {
            	label: string;
            	status: ProcessStatus;
            	pid: number | undefined;
            	// ... other fields
            	hint?: string;
            }

            interface ListProcessDetail {
            	label: string;
            	status: ProcessStatus;
            	pid: number | undefined;
            	// ... other fields
            	tail_command: string | null | undefined;
            }
            ```
        *   **File:** `src/types.ts`
        *   **Add (potentially integrate with existing Zod schemas):** You could define these as interfaces or align them more closely with the existing Zod payload schemas (`CheckStatusPayloadSchema`, `ListProcessDetailSchema`). Using the Zod schemas directly is often preferred. *If you keep them as interfaces, add them here.* Example:
            ```typescript
            // Example if kept as separate interfaces
            export interface CheckStatusResponsePayload {
              label: string;
              status: ProcessStatus;
              pid?: number;
              command: string;
              args: string[];
              cwd: string;
              exitCode: number | null;
              signal: string | null;
              logs: string[];
              log_file_path?: string | null;
              tail_command?: string | null;
              hint?: string;
            }

            export interface ListProcessDetail {
              label: string;
              status: ProcessStatus;
              pid?: number;
              command: string;
              args: string[];
              cwd: string;
              exitCode: number | null;
              signal: string | null;
              logs: string[];
              log_hint: string | null;
              log_file_path?: string | null;
              tail_command?: string | null;
            }
            ```
        *   **Update Usage:** If you moved them as interfaces, update `src/toolImplementations.ts` to import and use these types from `src/types.ts`. If you decide to use the Zod schemas' inferred types instead, update the code accordingly (e.g., `const payload: z.infer<typeof CheckStatusPayloadSchema> = { ... };`). *This plan assumes using the existing Zod schemas is sufficient.*

**2. Move `stopAllProcessesOnExit` to `src/processLifecycle.ts`**

*   **Why:** This function handles process cleanup during server shutdown, fitting logically within the process lifecycle management module rather than the core state management file.
*   **Steps:**
    *   **File:** `src/state.ts`
    *   **Cut (Remove):** The entire `stopAllProcessesOnExit` function.
        ```typescript
        // CUT THIS FUNCTION:
        export function stopAllProcessesOnExit(): void {
        	log.info(null, "Stopping all managed processes on exit...");
        	// ... function implementation ...
        	managedProcesses.clear(); // Clear the map finally
        }
        ```
    *   **File:** `src/processLifecycle.ts`
    *   **Paste (Add):** The `stopAllProcessesOnExit` function.
    *   **Add Imports:** Ensure necessary imports are present in `src/processLifecycle.ts`.
        ```typescript
        import { promisify } from "node:util";
        import treeKill from "tree-kill";
        import { managedProcesses, updateProcessStatus } from "./state.js"; // Needs access to state
        import { log } from "./utils.js";

        const killProcessTree = promisify(treeKill); // Ensure this is defined or imported

        // PASTED FUNCTION:
        export function stopAllProcessesOnExit(): void {
        	log.info(null, "Stopping all managed processes on exit...");
            const stopPromises: Promise<void>[] = [];

            managedProcesses.forEach((processInfo, label) => {
                // ... existing logic ...
                if (processInfo.process && processInfo.pid) {
                    updateProcessStatus(label, "stopping"); // <-- Needs updateProcessStatus import
                    const stopPromise = new Promise<void>((resolve) => {
                        if (processInfo.pid) {
                            killProcessTree(processInfo.pid) // <-- Needs killProcessTree
        						.then(() => { resolve(); })
        						.catch((err: Error | null) => {
                                    if (err) { log.error(label, `Error stopping process tree for ${label}:`, err); }
                                    resolve();
                                });
                        } else {
                            log.warn(label, "Cannot kill process tree, PID is missing.");
                            resolve();
                        }
                    });
                    stopPromises.push(stopPromise);
                } else {
                     log.warn(label, `Process ${label} has no active process or PID to stop.`);
                }

                if (processInfo.logFileStream) {
                    log.info( label, `Closing log stream for ${label} during server shutdown.`);
                    processInfo.logFileStream.end();
                    processInfo.logFileStream = null;
                }
            });
        	log.info(null, "Issued stop commands for all processes.");
        	managedProcesses.clear(); // Clear the map finally // <-- Needs managedProcesses import
        }
        ```
    *   **Update Imports:** Modify the import in `src/main.ts` where `stopAllProcessesOnExit` is called.
        *   **File:** `src/main.ts`
        *   **Change:**
            ```diff
            - import { stopAllProcessesOnExit } from "./state.js";
            + import { stopAllProcessesOnExit } from "./processLifecycle.js";
            ```

**3. Extract `WAIT_DURATION_MS` Constant**

*   **Why:** Removes a magic number from the implementation logic, centralizes timing constants, and makes the value easier to find and modify.
*   **Steps:**
    *   **File:** `src/toolImplementations.ts`
    *   **Find:**
        ```typescript
        const WAIT_DURATION_MS = 2000; // Fixed wait time for active processes
        ```
    *   **Replace:** Remove the inline definition.
    *   **Add Import:** Add an import for the new constant from `src/constants.ts`.
        ```typescript
        import {
        	// ... other imports ...
        	CHECK_STATUS_WAIT_DURATION_MS // Use a descriptive name
        } from "./constants.js";
        ```
    *   **Update Usage:** Use the imported constant where `WAIT_DURATION_MS` was previously used (Note: This constant was defined but seemingly *not used* in the provided `checkProcessStatusImpl`. If it were used, the usage would be updated like `await delay(CHECK_STATUS_WAIT_DURATION_MS);`). *Assuming it was intended for a wait/delay, the plan includes adding it to constants.*
    *   **File:** `src/constants.ts`
    *   **Add:** Define the constant.
        ```typescript
        /** Duration (ms) to potentially wait during check_process_status for active processes (if needed). */
        export const CHECK_STATUS_WAIT_DURATION_MS = 2000;
        ```

---

Executing this plan will result in:

1.  More centralized type definitions in `src/types.ts`.
2.  Better logical grouping of process shutdown logic in `src/processLifecycle.ts`.
3.  Improved clarity and maintainability by extracting constants to `src/constants.ts`.