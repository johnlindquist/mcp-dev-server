Okay, let's create a step-by-step plan to add Vitest integration tests for the `mcp-pm` project, following the provided guide.

**Goal:** Implement integration tests for the `mcp-pm` server (`build/index.mjs`) using Vitest, focusing on interacting with its MCP tools via stdio.

---

### **Phase 1: Setup and Basic Test Infrastructure**

**Step 1: Install Dependencies**

*   Add Vitest and necessary Node.js types to `devDependencies`.
    ```bash
    pnpm add -D vitest @types/node
    ```

**Step 2: Configure `package.json`**

*   Add a test script command.
    ```json
    // package.json
    {
      // ... other fields
      "scripts": {
        // ... other scripts
        "test": "vitest run", // For CI or single runs
        "test:watch": "vitest" // For development
      },
      // ... rest of the file
    }
    ```

**Step 3: Create Test Directory and File**

*   Create a standard location for tests.
    ```bash
    mkdir tests
    mkdir tests/integration
    touch tests/integration/mcp-server.test.ts
    ```

**Step 4: Basic Test File Structure (`tests/integration/mcp-server.test.ts`)**

*   Set up the initial `describe` block and import necessary modules.
*   Define constants for server execution based on `mcp-pm`.

    ```typescript
    // tests/integration/mcp-server.test.ts
    import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
    import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
    import path from 'node:path';
    import os from 'node:os'; // For temporary directories if needed

    // --- Configuration ---
    const SERVER_EXECUTABLE = 'node';
    // Resolve path from 'tests/integration/' to 'build/index.mjs'
    const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../build/index.mjs');
    const SERVER_ARGS: string[] = []; // No specific args needed to start
    // From src/main.ts log output
    const SERVER_READY_OUTPUT = 'MCP Server connected and listening via stdio.';
    const STARTUP_TIMEOUT = 20000; // 20 seconds (adjust as needed)
    const TEST_TIMEOUT = STARTUP_TIMEOUT + 5000; // Test timeout slightly longer than startup

    describe('MCP Process Manager Server (Stdio Integration)', () => {
      let serverProcess: ChildProcessWithoutNullStreams | null = null;
      let serverReadyPromise: Promise<void>;
      let resolveServerReady: () => void;
      let rejectServerReady: (reason?: any) => void;
      let serverErrorOutput: string[] = []; // Store stderr output
      let serverStdoutOutput: string[] = []; // Store stdout output (mostly for debugging)
      let serverExitCode: number | null = null;
      let serverWasKilled = false; // Flag to check if we killed it intentionally

      // `beforeAll` and `afterAll` will go here (Step 5 & 6)

      // Test cases will go here (Step 8 onwards)
      it('placeholder test', () => {
        expect(true).toBe(true);
      });
    });
    ```

**Step 5: Implement `beforeAll` (Server Startup)**

*   Adapt the guide's `beforeAll` logic to spawn `build/index.mjs`.
*   Use a locally scoped `resolve`/`reject` pattern for the readiness promise.
*   Capture `stderr` for debugging and potential error analysis during startup.

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    beforeAll(async () => {
      // Reset state for potentially retried tests
      serverProcess = null;
      serverErrorOutput = [];
      serverStdoutOutput = [];
      serverExitCode = null;
      serverWasKilled = false;

      // Setup the promise *before* spawning
      serverReadyPromise = new Promise((resolve, reject) => {
        resolveServerReady = resolve;
        rejectServerReady = reject;
      });

      console.log(`Spawning MCP server: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(' ')}`);
      serverProcess = spawn(SERVER_EXECUTABLE, [SERVER_SCRIPT_PATH, ...SERVER_ARGS], {
        stdio: ['pipe', 'pipe', 'pipe'], // pipe stdin, stdout, stderr
        env: { ...process.env }, // Pass environment variables
        // cwd: path.dirname(SERVER_SCRIPT_PATH), // Usually not needed if script path is absolute
      });

      let serverReady = false; // Flag to prevent double resolution

      const startupTimeoutTimer = setTimeout(() => {
        if (!serverReady) {
            const err = new Error(`Server startup timed out after ${STARTUP_TIMEOUT}ms. Stderr: ${serverErrorOutput.join('')}`);
            console.error(err.message);
            serverWasKilled = true;
            serverProcess?.kill('SIGKILL'); // Force kill on timeout
            rejectServerReady(err);
        }
      }, STARTUP_TIMEOUT);

      serverProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        serverStdoutOutput.push(output); // Store for debugging
        // NOTE: MCP responses go to stdout, but the *ready* signal for mcp-pm goes to stderr
        // console.log(`[Server STDOUT]: ${output.trim()}`);
      });

      serverProcess.stderr.on('data', (data: Buffer) => {
        const output = data.toString();
        serverErrorOutput.push(output); // Store for debugging/errors
        console.error(`[Server STDERR]: ${output.trim()}`); // Log stderr for visibility

        // Check for the ready signal in stderr
        if (!serverReady && output.includes(SERVER_READY_OUTPUT)) {
          console.log('MCP server ready signal detected.');
          serverReady = true;
          clearTimeout(startupTimeoutTimer);
          resolveServerReady();
        }
        // Optional: Check for specific fatal startup errors here if known
        // if (output.includes("FATAL ERROR")) {
        //   clearTimeout(startupTimeoutTimer);
        //   rejectServerReady(new Error(`Server emitted fatal error: ${output}`));
        // }
      });

      serverProcess.on('error', (err) => {
        console.error('Failed to start server process:', err);
        if (!serverReady) {
            clearTimeout(startupTimeoutTimer);
            rejectServerReady(err);
        }
      });

      serverProcess.on('exit', (code, signal) => {
        serverExitCode = code;
        console.log(`Server process exited with code: ${code}, signal: ${signal}`);
        if (!serverReady) {
          clearTimeout(startupTimeoutTimer);
          rejectServerReady(new Error(`Server process exited prematurely (code ${code}, signal ${signal}) before ready signal. Stderr: ${serverErrorOutput.join('')}`));
        }
        // If it exits *after* being ready but *before* we killed it, it might be an issue
        else if (!serverWasKilled) {
            console.warn(`Server process exited unexpectedly after being ready (code ${code}, signal ${signal}).`)
            // We might want to fail ongoing tests if this happens, but that's complex.
            // For now, just log it. The tests relying on the process will fail anyway.
        }
      });

      serverProcess.on('close', () => {
          console.log('Server stdio streams closed.');
      });

      try {
        await serverReadyPromise;
        console.log('Server startup successful.');
      } catch (err) {
        console.error('Server startup failed:', err);
        // Ensure process is killed if startup failed partway
        if (serverProcess && !serverProcess.killed) {
            serverWasKilled = true;
            serverProcess.kill('SIGKILL');
        }
        throw err; // Re-throw to fail the test setup
      }
    }, TEST_TIMEOUT); // Vitest timeout for the hook
    ```

**Step 6: Implement `afterAll` (Server Teardown)**

*   Copy the guide's `afterAll` logic to kill the server process.

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    afterAll(async () => {
      if (serverProcess && !serverProcess.killed) {
        console.log('Terminating server process...');
        serverWasKilled = true; // Signal that we initiated the kill
        serverProcess.stdin.end(); // Close stdin first
        const killed = serverProcess.kill('SIGTERM'); // Attempt graceful shutdown
        if (killed) {
          console.log('Sent SIGTERM to server process.');
          // Wait briefly for graceful exit
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!serverProcess.killed) {
            console.warn('Server did not exit after SIGTERM, sending SIGKILL.');
            serverProcess.kill('SIGKILL');
          }
        } else {
            console.warn('Failed to send SIGTERM, attempting SIGKILL directly.');
            serverProcess.kill('SIGKILL');
        }
      } else {
        console.log('Server process already terminated or not started.');
      }
      // Optional: Cleanup temporary directories/files if created by tests
    });
    ```

**Step 7: Implement `sendRequest` Helper**

*   Copy the `sendRequest` helper function from the guide into the test file (or a separate helper file). Ensure it handles newline framing and response parsing correctly.

    ```typescript
    // Can be placed inside the describe block or outside (if exported from a helper module)
    // Using the guide's version directly, ensure it's adapted for TypeScript/Vitest context
    async function sendRequest(
      process: ChildProcessWithoutNullStreams,
      request: Record<string, any>,
      timeoutMs = 10000 // 10 second timeout
    ): Promise<any> {
        const requestId = request.id;
        if (!requestId) {
            throw new Error('Request must have an "id" property');
        }
        const requestString = JSON.stringify(request) + '\n'; // IMPORTANT: Add newline framing

        return new Promise((resolve, reject) => {
            let responseBuffer = '';
            let responseReceived = false;
            let responseListenersAttached = false; // Flag to prevent attaching multiple listeners

            const timeoutTimer = setTimeout(() => {
                if (!responseReceived) {
                    cleanup();
                    reject(new Error(`Timeout waiting for response ID ${requestId} after ${timeoutMs}ms. Request: ${JSON.stringify(request)}`));
                }
            }, timeoutMs);

            const onData = (data: Buffer) => {
                responseBuffer += data.toString();
                // console.log(`[Raw STDOUT chunk]: ${data.toString()}`); // Debugging chunks
                const lines = responseBuffer.split('\n');
                responseBuffer = lines.pop() || ''; // Keep incomplete line fragment

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    // console.log(`[Processing line]: ${line}`); // Debugging lines
                    try {
                        const parsedResponse = JSON.parse(line);
                        if (parsedResponse.id === requestId) {
                            console.log(`Received response for ID ${requestId}: ${line.trim()}`);
                            responseReceived = true;
                            cleanup();
                            resolve(parsedResponse);
                            return; // Found the response
                        } else {
                           // console.log(`Ignoring response with different ID: ${parsedResponse.id}`);
                        }
                    } catch (e) {
                        // Ignore lines that aren't valid JSON or don't match ID
                         console.warn(`Failed to parse potential JSON line or non-matching ID: ${line}`, e);
                    }
                }
            };

            const onError = (err: Error) => {
                if (!responseReceived) {
                    cleanup();
                    reject(new Error(`Server process emitted error while waiting for ID ${requestId}: ${err.message}`));
                }
            };

            const onExit = (code: number | null, signal: string | null) => {
                if (!responseReceived) {
                    cleanup();
                    reject(new Error(`Server process exited (code ${code}, signal ${signal}) before response ID ${requestId} was received.`));
                }
            };

            const cleanup = () => {
                clearTimeout(timeoutTimer);
                if (responseListenersAttached) {
                  process.stdout.removeListener('data', onData);
                  process.stderr.removeListener('data', logStderr); // Also remove stderr listener if added
                  process.removeListener('error', onError);
                  process.removeListener('exit', onExit);
                  responseListenersAttached = false; // Mark as removed
                 // console.log(`Listeners removed for request ID ${requestId}`);
                }
            };

            // Temporary stderr listener during request wait (optional, for debugging)
             const logStderr = (data: Buffer) => {
                console.error(`[Server STDERR during request ${requestId}]: ${data.toString().trim()}`);
             };

            // Attach listeners only once per request
            if (!responseListenersAttached) {
              process.stdout.on('data', onData);
              process.stderr.on('data', logStderr); // Listen to stderr too
              process.once('error', onError); // Use once for exit/error during wait
              process.once('exit', onExit);
              responseListenersAttached = true;
             // console.log(`Listeners attached for request ID ${requestId}`);
            }


            // Write the request to stdin
            console.log(`Sending request (ID ${requestId}): ${requestString.trim()}`);
            process.stdin.write(requestString, (err) => {
                if (err) {
                    if (!responseReceived) { // Check if already resolved/rejected
                        cleanup();
                        reject(new Error(`Failed to write to server stdin for ID ${requestId}: ${err.message}`));
                    }
                }
            });
        });
    }
    ```

---

### **Phase 2: Implementing Test Cases**

**Step 8: Test `health_check`**

*   Write the first actual test case using the `sendRequest` helper.

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should respond successfully to health_check', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();
      expect(serverExitCode, 'Server should not have exited prematurely').toBeNull();

      const request = {
        jsonrpc: '2.0',
        id: 'health-check-1',
        method: 'health_check',
        params: {},
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(request.id);
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      // Parse the JSON string within the text payload
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload.status).toBe('ok');
      expect(resultPayload.server_name).toBe('mcp-pm');
      expect(resultPayload.version).toBeDefined(); // Check if version exists
      expect(resultPayload.active_processes).toBe(0); // Expect 0 initially
      expect(resultPayload.zombie_check_active).toBe(true); // Expect zombie check to be active
    }, TEST_TIMEOUT);
    ```

**Step 9: Test `list_processes` (Initially Empty)**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should list zero processes initially', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();

      const request = {
        jsonrpc: '2.0',
        id: 'list-empty-1',
        method: 'list_processes',
        params: {}, // Default log_lines = 0
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);
      expect(resultPayload).toBeInstanceOf(Array);
      expect(resultPayload.length).toBe(0);
    }, TEST_TIMEOUT);
    ```

**Step 10: Test `start_process`**

*   Use a simple, cross-platform command like `node -e "..."` or a basic shell command.
*   Create a unique label for the test process.

    ```typescript
    // Inside the describe block in mcp-server.test.ts
    const TEST_PROCESS_LABEL = 'test-process-1';
    let testProcessPID: number | undefined;

    it('should start a simple background process', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();

      // Command that runs for a bit and prints something
      const command = 'node';
      const args = ['-e', "console.log('Test process started'); setTimeout(() => console.log('Test process still running'), 500); setTimeout(() => console.log('Test process exiting'), 1500);"];
      // Use a temporary directory specific to the test run if needed, or OS temp dir
      const workingDirectory = os.tmpdir(); // Or create a specific test dir

      const request = {
        jsonrpc: '2.0',
        id: 'start-proc-1',
        method: 'start_process',
        params: {
          label: TEST_PROCESS_LABEL,
          command: command,
          args: args,
          workingDirectory: workingDirectory,
          // Optional: Add verification pattern if needed
          // verification_pattern: "Test process started",
          // verification_timeout_ms: 5000,
        },
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload.label).toBe(TEST_PROCESS_LABEL);
      // Status might be 'running' or 'verifying' depending on timing/verification
      expect(['running', 'verifying', 'starting']).toContain(resultPayload.status);
      expect(resultPayload.pid).toBeGreaterThan(0);
      expect(resultPayload.command).toBe(command);
      expect(resultPayload.args).toEqual(args);
      expect(resultPayload.cwd).toBe(workingDirectory);
      // Logs might contain initial output
      expect(resultPayload.logs).toBeInstanceOf(Array);
       if (resultPayload.logs.length > 0) {
           expect(resultPayload.logs.join('\n')).toContain('Test process started');
       }

      testProcessPID = resultPayload.pid; // Store PID for later tests
    }, TEST_TIMEOUT);
    ```

**Step 11: Test `check_process_status` (After Start)**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should check the status of the running test process', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();
      expect(testProcessPID, 'Test process should have been started').toBeDefined();

      // Add a small delay to allow the process to stabilize if needed
      await new Promise(resolve => setTimeout(resolve, 500));

      const request = {
        jsonrpc: '2.0',
        id: 'check-proc-1',
        method: 'check_process_status',
        params: {
          label: TEST_PROCESS_LABEL,
          log_lines: 10, // Request some logs
        },
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload.label).toBe(TEST_PROCESS_LABEL);
      // Depending on timing, could still be verifying or running
      expect(['running', 'verifying']).toContain(resultPayload.status);
      expect(resultPayload.pid).toBe(testProcessPID);
      expect(resultPayload.logs).toBeInstanceOf(Array);
      // Check if logs reflect expected output (adjust based on the actual command)
       expect(resultPayload.logs.join('\n')).toContain('Test process started');
       // May or may not contain 'still running' depending on exact timing
      expect(resultPayload.exitCode).toBeNull();
      expect(resultPayload.signal).toBeNull();
    }, TEST_TIMEOUT);
    ```

**Step 12: Test `list_processes` (With Running Process)**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should list the running test process', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();
      expect(testProcessPID, 'Test process should have been started').toBeDefined();

      const request = {
        jsonrpc: '2.0',
        id: 'list-running-1',
        method: 'list_processes',
        params: { log_lines: 1 }, // Request minimal logs
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload).toBeInstanceOf(Array);
      expect(resultPayload.length).toBe(1);
      const processInfo = resultPayload[0];
      expect(processInfo.label).toBe(TEST_PROCESS_LABEL);
      expect(['running', 'verifying']).toContain(processInfo.status);
      expect(processInfo.pid).toBe(testProcessPID);
    }, TEST_TIMEOUT);
    ```

**Step 13: Test `stop_process`**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should stop the running test process', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();
      expect(testProcessPID, 'Test process should have been started').toBeDefined();

      const request = {
        jsonrpc: '2.0',
        id: 'stop-proc-1',
        method: 'stop_process',
        params: {
          label: TEST_PROCESS_LABEL,
          force: false, // Test graceful stop first
        },
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload.label).toBe(TEST_PROCESS_LABEL);
      // Status after stop signal is sent might still be 'stopping' briefly
      expect(['stopping', 'stopped']).toContain(resultPayload.status);
      expect(resultPayload.pid).toBe(testProcessPID); // Should report the PID it tried to stop

      // Wait a bit for the process to actually terminate
      await new Promise(resolve => setTimeout(resolve, 1000)); // Adjust delay if needed

    }, TEST_TIMEOUT);
    ```

**Step 14: Test `check_process_status` (After Stop)**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should show the test process as stopped after stopping', async () => {
      expect(serverProcess, 'Server process should be running').not.toBeNull();

      // Wait briefly to ensure the exit handler has updated the status
      await new Promise(resolve => setTimeout(resolve, 500));

      const request = {
        jsonrpc: '2.0',
        id: 'check-stopped-1',
        method: 'check_process_status',
        params: {
          label: TEST_PROCESS_LABEL,
        },
      };

      const response = await sendRequest(serverProcess!, request);

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const resultPayload = JSON.parse(response.result.payload.content);

      expect(resultPayload.label).toBe(TEST_PROCESS_LABEL);
      expect(resultPayload.status).toBe('stopped'); // Should now be definitely stopped
      expect(resultPayload.pid).toBe(testProcessPID); // PID might still be reported
      expect(resultPayload.exitCode).toBeDefined(); // Should have an exit code or signal
      // For the example node command, exit code should likely be 0 or null if terminated by signal
      // expect(resultPayload.exitCode).toBe(0); // Or check if signal is not null
       expect(resultPayload.logs.join('\n')).toContain('Test process exiting');

    }, TEST_TIMEOUT);
    ```

**Step 15: Test `list_processes` (After Stop)**

    ```typescript
    // Inside the describe block in mcp-server.test.ts

    it('should list the process as stopped after stopping', async () => {
        expect(serverProcess, 'Server process should be running').not.toBeNull();

        const request = {
            jsonrpc: '2.0',
            id: 'list-stopped-1',
            method: 'list_processes',
            params: {},
        };

        const response = await sendRequest(serverProcess!, request);

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        const resultPayload = JSON.parse(response.result.payload.content);

        expect(resultPayload).toBeInstanceOf(Array);
        // Process might still be listed but as stopped, or removed depending on implementation
        const processInfo = resultPayload.find((p: any) => p.label === TEST_PROCESS_LABEL);
        expect(processInfo).toBeDefined();
        expect(processInfo.status).toBe('stopped');
    }, TEST_TIMEOUT);
    ```

**Step 16: Add Tests for Other Tools and Edge Cases**

*   Follow the same pattern to add tests for:
    *   `restart_process`
    *   `wait_for_process` (wait for 'running', wait for 'stopped')
    *   `get_all_loglines`
    *   `stop_all_processes`
    *   `send_input` (requires starting an interactive process)
*   Add tests for error conditions:
    *   `start_process` with non-existent `workingDirectory`.
    *   `start_process` reusing an active label/cwd/command combo.
    *   `check_process_status`/`stop_process`/etc. with a non-existent label.
    *   `start_process` that crashes immediately.

---

### **Phase 3: Refinement and CI Integration**

**Step 17: Run Tests**

*   Make sure the project is built (`pnpm build`).
*   Run the tests:
    ```bash
    pnpm test # Single run
    # or
    pnpm test:watch # During development
    ```
*   Debug any failures by examining the console output (including `[Server STDERR]`) and adjusting timeouts or assertions.

**Step 18: Refactor and Improve**

*   Extract common request patterns or setup logic into helper functions if needed.
*   Ensure test labels are unique to avoid collisions if tests run in parallel (Vitest defaults to serial unless configured otherwise).
*   Consider using `beforeEach`/`afterEach` if tests need *absolute* isolation, but be mindful of the performance cost of restarting the server repeatedly. Cleaning up *test-specific processes* within `afterEach` using `stop_process` might be a good middle ground if needed.

**Step 19: CI Integration**

*   Modify the `.github/workflows/ci.yml` file.
*   Add a step to run the tests after the build step. Ensure the `build/` artifact is available to the test job (e.g., by running build and test in the same job, or using artifacts).

    ```yaml
    # .github/workflows/ci.yml (Example addition)
    # ... (previous steps: checkout, setup-node, install, build) ...

      - name: Run Integration Tests
        run: pnpm test
        # Ensure build artifacts are present if testing in a separate job
        # Add environment variables if tests need them
        # env:
        #   CI: true
    ```

---

This plan provides a structured approach to adding robust integration tests for the `mcp-pm` server based on the provided guide and the project's specifics. Remember to adapt commands, paths, and assertions as needed during implementation.