Okay, this is a great goal! Breaking down large test files makes them much easier to maintain and understand. We'll use Vitest's `globalSetup` feature to manage the shared server process across multiple test files.

Here is the step-by-step plan. Remember to run `pnpm test` after *each* step and commit only if the tests pass.

**Assumptions:**

1.  You have `vitest` configured in your `package.json` or a `vitest.config.ts` file.
2.  `pnpm test` currently passes with the single large file.
3.  You are using Git for version control.

---

**Step 0: Verify Current State**

1.  Run `pnpm test`.
2.  Confirm all tests in `tests/integration/mcp-server.test.ts` pass.
3.  Ensure your working directory is clean (no uncommitted changes).

```bash
git status # Should report 'nothing to commit, working tree clean'
pnpm test  # Should pass
```

---

**Step 1: Extract Shared Helper Functions and Types**

*   **Goal:** Move reusable code (like `sendRequest`, logging helpers, types, constants) into a separate helper file.
*   **Why:** Reduces duplication and makes the main test file cleaner before splitting.

1.  **Create `tests/integration/test-helpers.ts`:**
    ```typescript
    // tests/integration/test-helpers.ts
    import type { ChildProcessWithoutNullStreams } from "node:child_process";
    import path from "node:path";

    // --- Configuration ---
    export const SERVER_EXECUTABLE = "node";
    export const SERVER_SCRIPT_PATH = path.resolve(__dirname, "../../build/index.mjs");
    export const SERVER_ARGS: string[] = [];
    export const SERVER_READY_OUTPUT = "MCP Server connected and listening via stdio.";
    export const STARTUP_TIMEOUT = 20000; // 20 seconds
    export const TEST_TIMEOUT = STARTUP_TIMEOUT + 10000; // Increase slightly for overhead

    // --- Verbose Logging ---
    export const IS_VERBOSE = process.env.MCP_TEST_VERBOSE === "1";
    export function logVerbose(...args: unknown[]) {
        if (IS_VERBOSE) {
            console.log("[VERBOSE]", ...args);
        }
    }
    export function logVerboseError(...args: unknown[]) {
        if (IS_VERBOSE) {
            console.error("[VERBOSE_ERR]", ...args);
        }
    }

    // --- Type definitions ---
    // (Keep these simplified or import from src if preferred and stable)
    export type MCPResponse = {
        jsonrpc: "2.0";
        id: string;
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
    };

    // Adjusted based on usage in tests
    export type CallToolResult = {
      toolCallId?: string; // Optional based on MCP spec/impl
      toolName?: string; // Optional
      isError?: boolean; // Common pattern
      payload: Array<{ type: "text"; content: string }>; // Assuming text content holds JSON string
    };


    export type ProcessStatusResult = {
        label: string;
        status: "running" | "stopped" | "starting" | "error" | "crashed";
        pid?: number;
        command?: string;
        args?: string[];
        cwd?: string;
        exitCode?: number | null;
        signal?: string | null;
        logs?: string[];
        log_hint?: string; // Add log_hint here
        message?: string; // Added for summary test
        // Other fields omitted for simplicity
    };

    // --- sendRequest Function ---
    // Note: We will modify this later to accept the process from global setup
    export async function sendRequest(
        process: ChildProcessWithoutNullStreams, // Keep process as argument for now
        request: Record<string, unknown>,
        timeoutMs = 15000, // Slightly increased default timeout
    ): Promise<MCPResponse> { // Return MCPResponse directly
        const requestId = request.id as string;
        if (!requestId) {
            throw new Error('Request must have an "id" property');
        }
        const requestString = `${JSON.stringify(request)}\n`;
        logVerbose(
            `[sendRequest] Sending request (ID ${requestId}): ${requestString.trim()}`,
        );

        // Wrap the existing logic in a promise
        return new Promise<MCPResponse>((resolve, reject) => {
            let responseBuffer = "";
            let responseReceived = false;
            let responseListenersAttached = false;

            const timeoutTimer = setTimeout(() => {
                if (!responseReceived) {
                    cleanup();
                    const errorMsg = `Timeout waiting for response ID ${requestId} after ${timeoutMs}ms. Request: ${JSON.stringify(request)}`;
                    console.error(`[sendRequest] ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            }, timeoutMs);

            const onData = (data: Buffer) => {
                const rawChunk = data.toString();
                logVerbose(
                    `[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk.substring(0, 200)}${rawChunk.length > 200 ? "..." : ""}`,
                );
                responseBuffer += rawChunk;
                // Process buffer line by line
                let newlineIndex;
                while ((newlineIndex = responseBuffer.indexOf('\n')) !== -1) {
                  const line = responseBuffer.substring(0, newlineIndex).trim();
                  responseBuffer = responseBuffer.substring(newlineIndex + 1); // Remove processed line + newline

                  if (line === "") continue;
                  logVerbose(`[sendRequest] Processing line for ${requestId}: ${line.substring(0, 200)}${line.length > 200 ? "..." : ""}`);

                  try {
                      const parsedResponse = JSON.parse(line);
                      if (parsedResponse.id === requestId) {
                          logVerbose(
                              `[sendRequest] Received matching response for ID ${requestId}: ${line.trim()}`,
                          );
                           // Log the full received result object when ID matches, before resolving
                          logVerbose(
                              `[sendRequest] Full MATCHING response object for ${requestId}:`,
                              JSON.stringify(parsedResponse),
                          );
                          responseReceived = true;
                          cleanup();
                          resolve(parsedResponse as MCPResponse); // Resolve with the parsed response
                          return; // Found the response, exit handler
                      }
                      logVerbose(
                          `[sendRequest] Ignoring response with different ID (${parsedResponse.id}) for request ${requestId}`,
                      );
                  } catch (e) {
                      logVerboseError(
                          `[sendRequest] Failed to parse potential JSON line for ${requestId}: ${line}`,
                          e,
                      );
                  }
                }
            };


            const onError = (err: Error) => {
                if (!responseReceived) {
                    cleanup();
                    const errorMsg = `Server process emitted error while waiting for ID ${requestId}: ${err.message}`;
                    console.error(`[sendRequest] ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            };

            const onExit = (code: number | null, signal: string | null) => {
                if (!responseReceived) {
                    cleanup();
                    const errorMsg = `Server process exited (code ${code}, signal ${signal}) before response ID ${requestId} was received.`;
                    console.error(`[sendRequest] ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            };

            const cleanup = () => {
                logVerbose(
                    `[sendRequest] Cleaning up listeners for request ID ${requestId}`,
                );
                clearTimeout(timeoutTimer);
                // Check if process exists and streams are readable/writable before removing listeners
                 if (responseListenersAttached && process && process.stdout && !process.stdout.destroyed) {
                    process.stdout.removeListener("data", onData);
                }
                if (responseListenersAttached && process && process.stderr && !process.stderr.destroyed) {
                    process.stderr.removeListener("data", logStderr); // Also remove stderr listener if added
                }
                 if (responseListenersAttached && process && !process.killed) {
                    process.removeListener("error", onError);
                    process.removeListener("exit", onExit);
                 }
                responseListenersAttached = false;
            };

            const logStderr = (data: Buffer) => {
                logVerboseError(
                    `[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
                );
            };

             // Attach listeners only if process streams are available
            if (process && process.stdout && process.stderr) {
                logVerbose(
                    `[sendRequest] Attaching listeners for request ID ${requestId}`,
                );
                process.stdout.on("data", onData);
                process.stderr.on("data", logStderr);
                process.once("error", onError);
                process.once("exit", onExit);
                responseListenersAttached = true;
             } else {
                reject(new Error(`Server process or stdio streams are not available for request ID ${requestId}`));
                return;
             }


            logVerbose(`[sendRequest] Writing request (ID ${requestId}) to stdin...`);
            // Check if stdin is writable before writing
            if (process && process.stdin && process.stdin.writable) {
                 process.stdin.write(requestString, (err) => {
                    if (err) {
                        if (!responseReceived) {
                            cleanup();
                            const errorMsg = `Failed to write to server stdin for ID ${requestId}: ${err.message}`;
                            console.error(`[sendRequest] ${errorMsg}`);
                            reject(new Error(errorMsg));
                        }
                    } else {
                        logVerbose(
                            `[sendRequest] Successfully wrote request (ID ${requestId}) to stdin.`,
                        );
                    }
                 });
            } else {
                 const errorMsg = `Server stdin is not writable for request ID ${requestId}`;
                 console.error(`[sendRequest] ${errorMsg}`);
                 cleanup(); // Cleanup listeners if attach failed
                 reject(new Error(errorMsg));
            }
        });
    }

    ```
2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the constants (`SERVER_EXECUTABLE`, etc.), types (`MCPResponse`, etc.), logging functions (`logVerbose`, `logVerboseError`), and the `sendRequest` function definition from this file.
    *   Add imports for these elements from `./test-helpers.ts` at the top.

    ```typescript
    // tests/integration/mcp-server.test.ts
    import type { ChildProcessWithoutNullStreams } from "node:child_process";
    import { spawn } from "node:child_process";
    import path from "node:path";
    import { afterAll, beforeAll, describe, expect, it } from "vitest";

    // Import shared elements
    import {
        SERVER_EXECUTABLE,
        SERVER_SCRIPT_PATH,
        SERVER_ARGS,
        SERVER_READY_OUTPUT,
        STARTUP_TIMEOUT,
        TEST_TIMEOUT, // Use TEST_TIMEOUT from helpers
        logVerbose,
        logVerboseError,
        sendRequest,
        type MCPResponse,
        type CallToolResult, // Ensure this is exported/imported if needed
        type ProcessStatusResult, // Ensure this is exported/imported
    } from "./test-helpers.js"; // Add .js extension for ESM compatibility if needed

    // --- Configuration --- (Remove constants defined in helpers)
    // const SERVER_EXECUTABLE = ... (Remove)
    // const SERVER_SCRIPT_PATH = ... (Remove)
    // ... etc ...

    // --- Verbose Logging --- (Remove functions defined in helpers)
    // const IS_VERBOSE = ... (Remove)
    // function logVerbose(...){...} (Remove)
    // function logVerboseError(...){...} (Remove)

    // --- Type definitions --- (Remove types defined in helpers)
    // type MCPResponse = {...} (Remove)
    // type ResultContent = {...} (Remove if not used, or keep if specific)
    // type ProcessStatusResult = {...} (Remove)

    describe("MCP Process Manager Server (Stdio Integration)", () => {
        let serverProcess: ChildProcessWithoutNullStreams | null = null;
        let serverReadyPromise: Promise<void>;
        let resolveServerReady: () => void;
        let rejectServerReady: (reason?: Error | string | undefined) => void;
        let serverErrorOutput: string[] = [];
        let serverStdoutOutput: string[] = [];
        let serverExitCode: number | null = null;
        let serverWasKilled = false;

        // beforeAll and afterAll remain the same for now

        beforeAll(async () => {
             // ... (no changes inside beforeAll needed yet) ...
            console.log("[TEST] BeforeAll: Setting up server...");
            serverProcess = null;
            serverErrorOutput = [];
            serverStdoutOutput = [];
            serverExitCode = null;
            serverWasKilled = false;

            serverReadyPromise = new Promise((resolve, reject) => {
                resolveServerReady = resolve;
                rejectServerReady = reject;
            });

            console.log(
                `[TEST] Spawning MCP server: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(" ")}`,
            );
            serverProcess = spawn( /* ... */ ); // Use imported constants
            console.log(`[TEST] Server process spawned with PID: ${serverProcess.pid}`);

            let serverReady = false;

            const startupTimeoutTimer = setTimeout(() => { /* ... */ }, STARTUP_TIMEOUT); // Use imported constant

            serverProcess.stdout.on("data", (data: Buffer) => {
                const output = data.toString();
                logVerbose(`[Server STDOUT RAW]: ${output}`); // Use imported logVerbose
                serverStdoutOutput.push(output);
                logVerbose(`[Server STDOUT]: ${output.trim()}`); // Use imported logVerbose
            });

            serverProcess.stderr.on("data", (data: Buffer) => {
                 const output = data.toString();
                 logVerboseError(`[Server STDERR RAW]: ${output}`); // Use imported logVerboseError
                 serverErrorOutput.push(output);
                 logVerboseError(`[Server STDERR]: ${output.trim()}`); // Use imported logVerboseError

                 if (!serverReady && output.includes(SERVER_READY_OUTPUT)) { // Use imported constant
                     console.log("[TEST] MCP server ready signal detected in stderr.");
                     serverReady = true;
                     clearTimeout(startupTimeoutTimer);
                     resolveServerReady();
                 }
             });

            serverProcess.on("error", (err) => { /* ... */ });
            serverProcess.on("exit", (code, signal) => { /* ... */ });
            serverProcess.on("close", () => { /* ... */ });

             try {
                 logVerbose("[TEST] Waiting for server ready promise..."); // Use imported logVerbose
                 await serverReadyPromise;
                 console.log("[TEST] Server startup successful.");
             } catch (err) {
                 console.error("[TEST] Server startup failed:", err);
                 if (serverProcess && !serverProcess.killed) {
                     console.log("[TEST] Killing server process after startup failure...");
                     serverWasKilled = true;
                     serverProcess.kill("SIGKILL");
                 }
                 throw err;
             }

             await new Promise((resolve) => setTimeout(resolve, 200));
             logVerbose("[TEST] Short delay after server ready signal completed."); // Use imported logVerbose

        }, TEST_TIMEOUT); // Use imported constant

        afterAll(async () => {
           // ... (no changes inside afterAll needed yet) ...
           console.log("[TEST] AfterAll: Tearing down server...");
           // ... rest of afterAll ...
        });

        // Remove the sendRequest function definition here
        // async function sendRequest(...) { ... } (Remove)

        // --- Test Cases ---
        // (Tests remain the same for now, they should automatically use the imported helpers/types)
        it( /* ... list zero processes ... */ );
        it( /* ... health check ... */ );
        it( /* ... start process ... */ );
        // ... all other tests ...

    }); // End describe block
    ```
3.  **Verify:**
    *   Run `pnpm test`.
    *   Fix any import errors (e.g., missing `.js` extension if using pure ESM, incorrect paths, missing exports). Ensure all types used in the tests are correctly imported. The `CallToolResult` type might need adjustment in the helper file based on how it's used in the tests.
    *   Make sure the tests still pass exactly as before.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/test-helpers.ts
    git commit -m "refactor: Extract shared helpers for integration tests"
    ```

---

**Step 2: Implement Global Setup and Teardown**

*   **Goal:** Move the server startup (`beforeAll`) and shutdown (`afterAll`) logic into a Vitest global setup file. This ensures the server runs only once for all integration test files.
*   **Why:** This is the core step enabling test file separation while sharing the server instance.

1.  **Create `vitest.config.ts` (if you don't have one):**
    *   Make sure it's configured for your project (e.g., include paths). Add the `globalSetup` option.

    ```typescript
    // vitest.config.ts
    import { defineConfig } from 'vitest/config';

    export default defineConfig({
      test: {
        // Ensure integration tests are included
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        // Add the global setup file
        globalSetup: ['./tests/integration/global.setup.ts'],
        // Optional: Increase default test timeout if needed globally
        testTimeout: 40000, // e.g., 40 seconds, adjust as needed
        // Optional: Run integration tests sequentially if needed (though global setup handles the server)
        // poolOptions: {
        //   threads: {
        //     singleThread: true,
        //   },
        // },
         // Allow using globals like 'expect' without importing
         globals: true,
      },
    });
    ```
    *If you already have a config, just add the `globalSetup` line.*

2.  **Create `tests/integration/global.setup.ts`:**
    *   Move the `beforeAll` and `afterAll` logic here.
    *   The setup function needs to return teardown logic.
    *   We'll store the `serverProcess` in `globalThis` so tests can access it.

    ```typescript
    // tests/integration/global.setup.ts
    import type { ChildProcessWithoutNullStreams } from "node:child_process";
    import { spawn } from "node:child_process";
    import {
        SERVER_EXECUTABLE,
        SERVER_SCRIPT_PATH,
        SERVER_ARGS,
        SERVER_READY_OUTPUT,
        STARTUP_TIMEOUT,
        logVerbose,
        logVerboseError,
    } from "./test-helpers.js"; // Use helpers

    // Define a global variable structure (optional but good practice)
    declare global {
      // eslint-disable-next-line no-var
      var __MCP_TEST_SERVER_PROCESS__: ChildProcessWithoutNullStreams | null;
    }

    export async function setup() {
        console.log("[GlobalSetup] Starting MCP server for integration tests...");

        let serverProcess: ChildProcessWithoutNullStreams | null = null;
        let serverErrorOutput: string[] = [];
        let serverWasKilled = false; // Track if we kill it

        const serverReadyPromise = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
            const rejectTimeout = setTimeout(() => {
                 const errMsg = `[GlobalSetup] Server startup timed out after ${STARTUP_TIMEOUT}ms. Stderr: ${serverErrorOutput.join("")}`;
                 console.error(errMsg);
                 if (serverProcess && !serverProcess.killed) {
                    serverProcess.kill("SIGKILL");
                 }
                 reject(new Error(errMsg));
            }, STARTUP_TIMEOUT);

            logVerbose(
                `[GlobalSetup] Spawning: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(" ")}`,
            );

            serverProcess = spawn(
                SERVER_EXECUTABLE,
                [SERVER_SCRIPT_PATH, ...SERVER_ARGS],
                {
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { ...process.env, MCP_PM_FAST: "1" },
                },
            );
             logVerbose(`[GlobalSetup] Spawned PID: ${serverProcess.pid}`);


            let serverReady = false;

            serverProcess.stdout.on("data", (data: Buffer) => {
                logVerbose(`[GlobalSetup][Server STDOUT]: ${data.toString().trim()}`);
            });

            serverProcess.stderr.on("data", (data: Buffer) => {
                const output = data.toString();
                serverErrorOutput.push(output); // Capture stderr
                logVerboseError(`[GlobalSetup][Server STDERR]: ${output.trim()}`);
                if (!serverReady && output.includes(SERVER_READY_OUTPUT)) {
                    logVerbose("[GlobalSetup] Server ready signal detected.");
                    serverReady = true;
                    clearTimeout(rejectTimeout);
                    resolve(serverProcess as ChildProcessWithoutNullStreams); // Resolve with the process
                }
            });

            serverProcess.on("error", (err) => {
                console.error("[GlobalSetup] Failed to start server process:", err);
                clearTimeout(rejectTimeout);
                reject(err);
            });

            serverProcess.on("exit", (code, signal) => {
                logVerbose(
                    `[GlobalSetup] Server process exited unexpectedly during setup. Code: ${code}, Signal: ${signal}`,
                );
                 // If it exits before ready promise resolved/rejected, reject the promise
                if (!serverReady) {
                    clearTimeout(rejectTimeout);
                    const errMsg = `[GlobalSetup] Server process exited prematurely (code ${code}, signal ${signal}) before ready signal. Stderr: ${serverErrorOutput.join("")}`;
                    console.error(errMsg);
                    reject(new Error(errMsg));
                 }
                 // If killed by teardown, that's expected.
                 else if (!serverWasKilled) {
                    console.warn(`[GlobalSetup] Server process exited unexpectedly AFTER setup completed (code ${code}, signal ${signal}). Tests might fail.`);
                 }
                 // Reset global var if process exits unexpectedly after setup
                 if(globalThis.__MCP_TEST_SERVER_PROCESS__ === serverProcess) {
                    globalThis.__MCP_TEST_SERVER_PROCESS__ = null;
                 }
            });
        });

        try {
            // Wait for the server to be ready and get the process instance
            const readyProcess = await serverReadyPromise;
            console.log(`[GlobalSetup] Server ready (PID: ${readyProcess.pid}).`);
            // Store the process globally for tests to access
            globalThis.__MCP_TEST_SERVER_PROCESS__ = readyProcess;

        } catch (error) {
            console.error("[GlobalSetup] Failed to start server:", error);
             // Ensure process is killed if setup failed
             if (serverProcess && !serverProcess.killed) {
                 serverProcess.kill("SIGKILL");
             }
            throw error; // Propagate error to fail the test run
        }

        // Return the teardown function
        return async () => {
            console.log("[GlobalTeardown] Tearing down MCP server...");
            const currentProcess = globalThis.__MCP_TEST_SERVER_PROCESS__; // Use the globally stored one
            if (currentProcess && !currentProcess.killed) {
                 serverWasKilled = true; // Signal intentional kill
                logVerbose("[GlobalTeardown] Closing stdin and sending SIGTERM...");
                currentProcess.stdin.end();
                const killed = currentProcess.kill("SIGTERM");
                if (killed) {
                    await new Promise(resolve => setTimeout(resolve, 500)); // Wait briefly
                    if (!currentProcess.killed) {
                        logVerbose("[GlobalTeardown] SIGTERM failed, sending SIGKILL.");
                        currentProcess.kill("SIGKILL");
                    } else {
                       logVerbose("[GlobalTeardown] Server terminated gracefully.");
                    }
                } else {
                   logVerbose("[GlobalTeardown] Failed to send SIGTERM, sending SIGKILL.");
                   currentProcess.kill("SIGKILL");
                }
            } else {
               logVerbose("[GlobalTeardown] Server process already terminated or not started.");
            }
            globalThis.__MCP_TEST_SERVER_PROCESS__ = null; // Clean up global state
            console.log("[GlobalTeardown] Teardown complete.");
        };
    }
    ```

3.  **Update `tests/integration/test-helpers.ts`:**
    *   Modify `sendRequest` to get the server process from `globalThis`.

    ```typescript
    // tests/integration/test-helpers.ts
    // ... (imports and other helpers remain) ...

    // --- sendRequest Function ---
    // Now gets process from global state
    export async function sendRequest(
        // process: ChildProcessWithoutNullStreams, // REMOVE this parameter
        request: Record<string, unknown>,
        timeoutMs = 15000,
    ): Promise<MCPResponse> {
        // Get the process from global scope
        const process = globalThis.__MCP_TEST_SERVER_PROCESS__;

        // Add a check to ensure the process is available
        if (!process || process.killed) {
            throw new Error(
                `[sendRequest] Server process is not running or available (Request ID: ${request.id}). Ensure global setup succeeded.`,
            );
        }

        const requestId = request.id as string;
        // ... (rest of the sendRequest logic remains exactly the same)
        // ... it will use the 'process' variable fetched from globalThis ...
         return new Promise<MCPResponse>((resolve, reject) => {
            // ... (promise logic using 'process') ...
         });
    }
    ```

4.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the `beforeAll` and `afterAll` blocks entirely.
    *   Remove the `serverProcess` variable and related state variables (`serverReadyPromise`, `resolveServerReady`, etc.) from the `describe` block scope. They are now managed globally.
    *   Ensure tests call `sendRequest` *without* passing the `serverProcess` argument.

    ```typescript
    // tests/integration/mcp-server.test.ts
    // Imports remain, but remove spawn, ChildProcessWithoutNullStreams unless used elsewhere specifically
    // import type { ChildProcessWithoutNullStreams } from "node:child_process";
    // import { spawn } from "node:child_process";
    import path from "node:path"; // Keep path if used in tests
    import { describe, expect, it } from "vitest"; // Keep vitest imports

    // Import shared elements (ensure sendRequest is imported)
    import {
        TEST_TIMEOUT, // Use TEST_TIMEOUT from helpers
        logVerbose,
        // logVerboseError, // Keep if used directly in tests
        sendRequest, // <- Important
        type MCPResponse,
        type CallToolResult,
        type ProcessStatusResult,
    } from "./test-helpers.js";

    describe("MCP Process Manager Server (Stdio Integration)", () => {
        // Remove server process state variables - they are now global
        // let serverProcess: ChildProcessWithoutNullStreams | null = null;
        // let serverReadyPromise: Promise<void>;
        // ... remove all these ...

        // Remove beforeAll and afterAll blocks entirely
        // beforeAll(async () => { ... }, TEST_TIMEOUT);
        // afterAll(async () => { ... });

        // --- Test Cases ---
        // Update calls to sendRequest - remove the first argument

        it(
            "should list zero processes initially",
            async () => {
                logVerbose("[TEST][listEmpty] Starting test...");
                // No need to check serverProcess here, sendRequest will do it

                const listRequest = { /* ... */ id: "req-list-empty-1" };
                logVerbose("[TEST][listEmpty] Sending list_processes request...");

                // Call sendRequest WITHOUT the process argument
                const response = await sendRequest(listRequest);

                logVerbose(/* ... */); // Assertions remain the same
                expect(response.error).toBeUndefined();
                // ... rest of the test ...
            },
            TEST_TIMEOUT,
        );

        it(
            "should respond successfully to health_check",
            async () => {
                logVerbose("[TEST][healthCheck] Starting test...");
                const healthRequest = { /* ... */ id: "req-health-1" };
                logVerbose("[TEST][healthCheck] Sending health_check request...");

                // Call sendRequest WITHOUT the process argument
                const response = await sendRequest(healthRequest);

                logVerbose(/* ... */); // Assertions remain the same
                // ... rest of the test ...
            },
            TEST_TIMEOUT,
        );

        // Update ALL other tests similarly...
        it("should start a simple process...", async () => {
            // ... setup ...
            const startRequest = { /* ... */ id: "req-start-1"};
            const response = await sendRequest(startRequest); // No process arg
            // ... assertions ...
            // ... cleanup using sendRequest(stopRequest) ...
        }, TEST_TIMEOUT);

        // ... repeat for listOne, checkStatus, stop, restart, log filtering, summary ...

    });
    ```

5.  **Verify:**
    *   Run `pnpm test`.
    *   You should see "[GlobalSetup]" logs *once* at the beginning and "[GlobalTeardown]" logs *once* at the end.
    *   All tests in `mcp-server.test.ts` should still pass. Debug any issues related to accessing the global process or `sendRequest` modifications. Check `vitest.config.ts` path.

6.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/test-helpers.ts tests/integration/global.setup.ts vitest.config.ts
    git commit -m "refactor: Implement global setup/teardown for integration tests"
    ```

---

**Step 3: Move the First Test (`list_processes` empty)**

*   **Goal:** Move a single, simple test case to its own file.
*   **Why:** Prove that the global setup works and tests can run independently using the shared server.

1.  **Create `tests/integration/list-processes.test.ts`:**
    ```typescript
    // tests/integration/list-processes.test.ts
    import { describe, expect, it } from "vitest";
    import {
        TEST_TIMEOUT,
        logVerbose,
        sendRequest,
        type MCPResponse,
        type CallToolResult,
        type ProcessStatusResult,
    } from "./test-helpers.js"; // Import necessary helpers

    describe("Tool: list_processes", () => {
        it(
            "should list zero processes initially",
            async () => {
                logVerbose("[TEST][listEmpty] Starting test...");
                const listRequest = {
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        name: "list_processes",
                        arguments: { log_lines: 0 },
                    },
                    id: "req-list-empty-2", // Use a unique ID if needed, though likely fine
                };

                logVerbose("[TEST][listEmpty] Sending list_processes request...");
                const response = await sendRequest(listRequest); // Uses global process
                logVerbose(
                    "[TEST][listEmpty] Received response:",
                    JSON.stringify(response),
                );

                logVerbose("[TEST][listEmpty] Asserting response properties...");
                expect(
                    response.error,
                    `Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
                ).toBeUndefined();
                expect(
                    response.result,
                    `Expected result to be defined, error: ${JSON.stringify(response.error)}`,
                ).toBeDefined();

                const result = response.result as CallToolResult;
                expect(result?.payload?.[0]?.content).toBeDefined();

                let listResult: ProcessStatusResult[] | null = null;
                try {
                    listResult = JSON.parse(result.payload[0].content);
                } catch (e) {
                    throw new Error(`Failed to parse list_processes result payload: ${e}`);
                }

                expect(listResult).toBeInstanceOf(Array);
                expect(listResult?.length).toBe(0);
                console.log("[TEST][listEmpty] Assertions passed. Test finished.");
            },
            TEST_TIMEOUT,
        );

        // Add the other list_processes test here later (Step 5)
    });
    ```

2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the `it("should list zero processes initially", ...)` block completely.

3.  **Verify:**
    *   Run `pnpm test`.
    *   The tests should now run from *both* `mcp-server.test.ts` (with one less test) and `list-processes.test.ts`. All should pass.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/list-processes.test.ts
    git commit -m "test: Move initial list_processes test to separate file"
    ```

---

**Step 4: Move the `health_check` Test**

*   **Goal:** Move another simple test.
*   **Why:** Reinforce the pattern and continue shrinking the original file.

1.  **Create `tests/integration/health-check.test.ts`:**
    ```typescript
    // tests/integration/health-check.test.ts
    import { describe, expect, it } from "vitest";
    import {
        TEST_TIMEOUT,
        logVerbose,
        sendRequest,
        type MCPResponse,
        type CallToolResult,
    } from "./test-helpers.js"; // Import necessary helpers

    describe("Tool: health_check", () => {
        it(
            "should respond successfully to health_check",
            async () => {
                logVerbose("[TEST][healthCheck] Starting test...");
                const healthRequest = {
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        name: "health_check",
                        arguments: {},
                    },
                    id: "req-health-2", // Unique ID
                };
                logVerbose("[TEST][healthCheck] Sending health_check request...");

                const response = await sendRequest(healthRequest); // Uses global process
                logVerbose(
                    "[TEST][healthCheck] Received response:",
                    JSON.stringify(response),
                );

                logVerbose("[TEST][healthCheck] Asserting response properties...");
                expect(response.id).toBe("req-health-2");
                expect(response.result).toBeDefined();
                expect(response.error).toBeUndefined();

                logVerbose("[TEST][healthCheck] Asserting result properties...");
                const result = response.result as CallToolResult;
                expect(result?.payload?.[0]?.content).toBeDefined();

                try {
                    const parsedContent = JSON.parse(result.payload[0].content);
                    expect(parsedContent.status).toBe("ok");
                    expect(parsedContent.server_name).toBe("mcp-pm");
                    // ... other health check assertions
                    expect(parsedContent.is_zombie_check_active).toBe(false); // Example
                    console.log("[TEST][healthCheck] Assertions passed.");
                    logVerbose("[TEST][healthCheck] Test finished.");
                } catch (e) {
                    throw new Error(`Failed to parse health_check result payload: ${e}`);
                }
            },
            TEST_TIMEOUT,
        );
    });

    ```
2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the `it("should respond successfully to health_check", ...)` block.

3.  **Verify:**
    *   Run `pnpm test`. All tests across the three files should pass.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/health-check.test.ts
    git commit -m "test: Move health_check test to separate file"
    ```

---

**Step 5: Move Process Lifecycle Tests (Start, Stop, Restart, Check)**

*   **Goal:** Move tests related to managing a single process lifecycle. These often involve starting, checking, and stopping within the test.
*   **Why:** Group related functionality.

1.  **Create `tests/integration/process-lifecycle.test.ts`:**
    *   Copy the `it("should start a simple process...")`, `it("should check the status...")`, `it("should restart a running process...")` tests into this new file.
    *   Ensure all necessary imports (`path`, helpers, types) are added.
    *   *Important:* Since these tests start/stop processes *within* the test, they should already be self-contained regarding process state *for that specific test*. Make sure the `label` used in each test is unique (e.g., using `Date.now()`) to avoid conflicts if tests run concurrently (though global setup often implies sequential execution within the runner).

    ```typescript
    // tests/integration/process-lifecycle.test.ts
    import path from "node:path"; // Needed for workingDirectory
    import { describe, expect, it, beforeAll, afterAll } from "vitest"; // Vitest imports
    import {
        TEST_TIMEOUT,
        logVerbose,
        sendRequest,
        type MCPResponse,
        type CallToolResult,
        type ProcessStatusResult,
    } from "./test-helpers.js"; // Helpers

    describe("Tool: Process Lifecycle (start, check, stop, restart)", () => {

        // --- Start Test ---
        it(
            "should start a simple process and receive confirmation",
            async () => {
                logVerbose("[TEST][startProcess] Starting test...");
                const uniqueLabel = `test-process-${Date.now()}`;
                const command = "node";
                const args = [ /* ... */ ];
                const workingDirectory = path.resolve(__dirname);

                const startRequest = { /* ... using uniqueLabel ... */ id: `req-start-${uniqueLabel}`};
                logVerbose("[TEST][startProcess] Sending start request...");
                const response = await sendRequest(startRequest);
                // ... assertions for start response ...
                expect(response.id).toBe(`req-start-${uniqueLabel}`);
                // ...

                // Cleanup: Stop the process started in *this test*
                logVerbose(`[TEST][startProcess] Cleaning up ${uniqueLabel}...`);
                const stopRequest = {
                    jsonrpc: "2.0", method: "tools/call", params: { name: "stop_process", arguments: { label: uniqueLabel }}, id: `req-stop-${uniqueLabel}`
                };
                await sendRequest(stopRequest); // Send stop request
                logVerbose("[TEST][startProcess] Cleanup complete. Test finished.");

            },
            TEST_TIMEOUT,
        );

        // --- Check Status Test ---
        it(
            "should check the status of a running process",
             async () => {
                logVerbose("[TEST][checkStatus] Starting test...");
                const uniqueLabel = `test-check-${Date.now()}`;
                // --- Start a process first (within the test) ---
                // ... (copy start logic from original test, using uniqueLabel)
                 const startRequest = { /* ... */ id: `req-start-for-check-${uniqueLabel}`};
                 await sendRequest(startRequest);
                 await new Promise(resolve => setTimeout(resolve, 500)); // Allow time to start
                // --- Now Check Process Status ---
                const checkRequest = { /* ... using uniqueLabel */ id: `req-check-${uniqueLabel}` };
                const response = await sendRequest(checkRequest);
                // ... assertions for check response ...
                expect(response.id).toBe(`req-check-${uniqueLabel}`);
                // ... check status is running, pid > 0 etc. ...

                // --- Cleanup: Stop the process (within the test) ---
                logVerbose(`[TEST][checkStatus] Cleaning up ${uniqueLabel}...`);
                const stopRequest = { /* ... */ id: `req-stop-cleanup-check-${uniqueLabel}` };
                await sendRequest(stopRequest);
                logVerbose("[TEST][checkStatus] Cleanup stop request sent. Test finished.");

            },
            TEST_TIMEOUT,
        );


        // --- Restart Test ---
         it(
             "should restart a running process",
             async () => {
                 logVerbose("[TEST][restart] Starting test...");
                 const uniqueLabel = `test-restart-${Date.now()}`;
                 // --- Start initial process ---
                 const startRequest = { /* ... */ id: `req-start-for-restart-${uniqueLabel}` };
                 const startResponse = await sendRequest(startRequest);
                 // ... get initial PID ...

                 // --- Restart ---
                 await new Promise(resolve => setTimeout(resolve, 500));
                 const restartRequest = { /* ... using uniqueLabel */ id: `req-restart-${uniqueLabel}` };
                 const restartResponse = await sendRequest(restartRequest);
                 // ... assertions for restart response (new PID etc) ...
                 expect(restartResponse.id).toBe(`req-restart-${uniqueLabel}`);
                 // ...

                 // --- Cleanup ---
                 logVerbose(`[TEST][restart] Cleaning up ${uniqueLabel}...`);
                 const stopRequest = { /* ... */ id: `req-stop-cleanup-restart-${uniqueLabel}` };
                 await sendRequest(stopRequest);
                 logVerbose("[TEST][restart] Cleanup stop request sent. Test finished.");
             },
             TEST_TIMEOUT * 2, // Keep longer timeout for restart
         );

    }); // End describe
    ```

2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the three `it(...)` blocks related to start, check status, and restart.

3.  **Verify:**
    *   Run `pnpm test`. All tests across the four files should pass.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/process-lifecycle.test.ts
    git commit -m "test: Move process lifecycle tests (start, check, restart) to separate file"
    ```
    *(Note: We intentionally didn't move `stop_process` yet if there isn't a dedicated test for it just stopping a process. It's currently used for cleanup within other tests).*

---

**Step 6: Move Remaining `list_processes` Test**

*   **Goal:** Move the test that lists processes *after* one has been started.
*   **Why:** Consolidate all `list_processes` tests.

1.  **Update `tests/integration/list-processes.test.ts`:**
    *   Copy the `it("should list one running process after starting it", ...)` test block from `mcp-server.test.ts` into the `describe` block in `list-processes.test.ts`.
    *   Ensure `path` is imported if not already.
    *   Update request IDs to be unique if necessary.

    ```typescript
    // tests/integration/list-processes.test.ts
    import path from "node:path"; // Add path import
    import { describe, expect, it } from "vitest";
    // ... other imports ...

    describe("Tool: list_processes", () => {
        // ... (initial empty list test remains) ...

        it(
            "should list one running process after starting it",
            async () => {
                logVerbose("[TEST][listOne] Starting test...");
                 const uniqueLabel = `test-list-${Date.now()}`;
                 // --- Start a process first (within the test) ---
                 const startRequest = { /* ... */ id: `req-start-for-list-${uniqueLabel}`};
                 await sendRequest(startRequest);
                 await new Promise(resolve => setTimeout(resolve, 500));
                 logVerbose(`[TEST][listOne] Process ${uniqueLabel} started.`);
                 // --- Now List Processes ---
                const listRequest = { /* ... */ id: `req-list-one-${uniqueLabel}`};
                logVerbose("[TEST][listOne] Sending list_processes request...");
                const response = await sendRequest(listRequest);
                // ... assertions for list response (expecting the process) ...
                expect(response.id).toBe(`req-list-one-${uniqueLabel}`);
                // ... check list length >= 1, find process by label ...

                // --- Cleanup: Stop the process ---
                logVerbose(`[TEST][listOne] Cleaning up ${uniqueLabel}...`);
                const stopRequest = { /* ... */ id: `req-stop-cleanup-list-${uniqueLabel}`};
                await sendRequest(stopRequest);
                logVerbose("[TEST][listOne] Cleanup stop request sent. Test finished.");
            },
            TEST_TIMEOUT,
        );
    });
    ```

2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the `it("should list one running process...", ...)` block.

3.  **Verify:**
    *   Run `pnpm test`. All tests should pass.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/list-processes.test.ts
    git commit -m "test: Move second list_processes test to its dedicated file"
    ```

---

**Step 7: Move Logging-Related Tests**

*   **Goal:** Move tests focused on log filtering and summary messages.
*   **Why:** Group tests related to log handling features.

1.  **Create `tests/integration/logging.test.ts`:**
    *   Copy the `it("should filter logs correctly...")` and `it("should generate a summary message...")` tests into this file.
    *   Add necessary imports (`path`, helpers, types).
    *   Update request IDs to be unique.

    ```typescript
    // tests/integration/logging.test.ts
    import path from "node:path";
    import { describe, expect, it } from "vitest";
    import {
        TEST_TIMEOUT,
        logVerbose,
        sendRequest,
        type MCPResponse,
        type CallToolResult,
        type ProcessStatusResult,
    } from "./test-helpers.js";

    describe("Tool Features: Logging and Summaries", () => {

        it(
            "should filter logs correctly on repeated checks of an active process",
            async () => {
                logVerbose("[TEST][checkLogsFilter] Starting test...");
                const label = `test-log-filter-${Date.now()}`;
                // --- Start process ---
                 const startRequest = { /* ... */ id: `req-start-for-log-filter-${label}` };
                 await sendRequest(startRequest);
                 // --- Wait for logs ---
                 await new Promise(resolve => setTimeout(resolve, 4000)); // Initial wait
                // --- First Check ---
                const checkRequest1 = { /* ... */ id: `req-check1-log-filter-${label}` };
                const check1Response = await sendRequest(checkRequest1);
                // ... assertions for first check (logs expected) ...
                expect(check1Response.id).toBe(`req-check1-log-filter-${label}`);
                // --- Wait again ---
                await new Promise(resolve => setTimeout(resolve, 1500)); // Second wait
                // --- Second Check ---
                const checkRequest2 = { /* ... */ id: `req-check2-log-filter-${label}` };
                const check2Response = await sendRequest(checkRequest2);
                // ... assertions for second check (logs should be different or fewer/stopped) ...
                 expect(check2Response.id).toBe(`req-check2-log-filter-${label}`);
                // --- Cleanup ---
                logVerbose(`[TEST][checkLogsFilter] Cleaning up ${label}...`);
                const stopRequest = { /* ... */ id: `req-stop-cleanup-log-filter-${label}`};
                await sendRequest(stopRequest);
                logVerbose("[TEST][checkLogsFilter] Cleanup complete. Test finished.");
            },
            TEST_TIMEOUT + 5000, // Keep longer timeout
        );


        it(
            "should generate a summary message for notable log events",
            async () => {
                 logVerbose("[TEST][checkSummary] Starting test...");
                 const label = `test-summary-msg-${Date.now()}`;
                 // --- Start process ---
                 const startRequest = { /* ... */ id: `req-start-for-summary-${label}` };
                 await sendRequest(startRequest);
                 // --- Wait for logs ---
                 await new Promise(resolve => setTimeout(resolve, 1900)); // Initial wait
                 await new Promise(resolve => setTimeout(resolve, 200)); // Stabilize
                 // --- First Check (expect full summary) ---
                 const checkRequest1 = { /* ... */ id: `req-check1-summary-${label}` };
                 const check1Response = await sendRequest(checkRequest1);
                 // ... assertions for first check (expect specific summary message) ...
                 expect(check1Response.id).toBe(`req-check1-summary-${label}`);
                 // --- Wait longer ---
                 await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for exit
                 // --- Second Check (expect 'no notable events' summary) ---
                 const checkRequest2 = { /* ... */ id: `req-check2-summary-${label}` };
                 const check2Response = await sendRequest(checkRequest2);
                 // ... assertions for second check (expect different summary) ...
                 expect(check2Response.id).toBe(`req-check2-summary-${label}`);
                 // --- Cleanup ---
                 logVerbose(`[TEST][checkSummary] Cleaning up ${label}...`);
                 const stopRequest = { /* ... */ id: `req-stop-cleanup-summary-${label}`};
                 await sendRequest(stopRequest);
                 logVerbose("[TEST][checkSummary] Cleanup complete. Test finished.");
             },
             TEST_TIMEOUT + 5000, // Keep longer timeout
        );

    }); // End describe
    ```

2.  **Update `tests/integration/mcp-server.test.ts`:**
    *   Remove the `it("should filter logs correctly...")` and `it("should generate a summary message...")` blocks.

3.  **Verify:**
    *   Run `pnpm test`. All tests across the five files should pass.

4.  **Commit:**
    ```bash
    git add tests/integration/mcp-server.test.ts tests/integration/logging.test.ts
    git commit -m "test: Move logging and summary tests to separate file"
    ```

---

**Step 8: Final Cleanup**

*   **Goal:** Remove the now empty original test file.
*   **Why:** Complete the refactoring.

1.  **Check `tests/integration/mcp-server.test.ts`:**
    *   It should now only contain imports and an empty `describe` block.

2.  **Delete `tests/integration/mcp-server.test.ts`**.

3.  **Verify:**
    *   Run `pnpm test`. All tests from the remaining integration files (`list-processes.test.ts`, `health-check.test.ts`, `process-lifecycle.test.ts`, `logging.test.ts`) should pass. The global setup/teardown should still run once.

4.  **Commit:**
    ```bash
    git rm tests/integration/mcp-server.test.ts
    git commit -m "chore: Remove empty original integration test file"
    ```

---

You should now have your integration tests split into logical files, all sharing the same server instance managed by the global setup/teardown, with each step having been verified.