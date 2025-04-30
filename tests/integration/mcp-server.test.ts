import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// --- Configuration ---
const SERVER_EXECUTABLE = "node";
// Resolve path from 'tests/integration/' to 'build/index.mjs'
const SERVER_SCRIPT_PATH = path.resolve(__dirname, "../../build/index.mjs");
const SERVER_ARGS: string[] = []; // No specific args needed to start
// From src/main.ts log output
const SERVER_READY_OUTPUT = "MCP Server connected and listening via stdio.";
const STARTUP_TIMEOUT = 20000; // 20 seconds (adjust as needed)
const TEST_TIMEOUT = STARTUP_TIMEOUT + 5000; // Test timeout slightly longer than startup

// --- Type definitions for MCP responses (simplified) ---
type MCPResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

type ProcessStatusResult = {
	label: string;
	status: "running" | "stopped" | "starting" | "error" | "crashed";
	pid?: number;
	command?: string;
	args?: string[];
	cwd?: string;
	exitCode?: number | null;
	signal?: string | null;
	logs?: string[];
	log_hint?: string;
	// Other fields omitted for simplicity
};

describe("MCP Process Manager Server (Stdio Integration)", () => {
	let serverProcess: ChildProcessWithoutNullStreams | null = null;
	let serverReadyPromise: Promise<void>;
	let resolveServerReady: () => void;
	let rejectServerReady: (reason?: Error | string | undefined) => void;
	let serverErrorOutput: string[] = []; // Store stderr output
	let serverStdoutOutput: string[] = []; // Store stdout output (mostly for debugging)
	let serverExitCode: number | null = null;
	let serverWasKilled = false; // Flag to check if we killed it intentionally

	beforeAll(async () => {
		console.log("[TEST] BeforeAll: Setting up server...");
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

		console.log(
			`[TEST] Spawning MCP server: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(" ")}`,
		);
		serverProcess = spawn(
			SERVER_EXECUTABLE,
			[SERVER_SCRIPT_PATH, ...SERVER_ARGS],
			{
				stdio: ["pipe", "pipe", "pipe"], // pipe stdin, stdout, stderr
				env: { ...process.env }, // Pass environment variables
				// cwd: path.dirname(SERVER_SCRIPT_PATH), // Usually not needed if script path is absolute
			},
		);
		console.log(`[TEST] Server process spawned with PID: ${serverProcess.pid}`);

		let serverReady = false; // Flag to prevent double resolution

		const startupTimeoutTimer = setTimeout(() => {
			if (!serverReady) {
				const err = new Error(
					`[TEST] Server startup timed out after ${STARTUP_TIMEOUT}ms. Stderr: ${serverErrorOutput.join("")}`,
				);
				console.error(err.message);
				serverWasKilled = true;
				serverProcess?.kill("SIGKILL"); // Force kill on timeout
				rejectServerReady(err);
			}
		}, STARTUP_TIMEOUT);

		serverProcess.stdout.on("data", (data: Buffer) => {
			const output = data.toString();
			// console.log(`[Server STDOUT RAW]: ${output}`); // Log raw stdout data
			serverStdoutOutput.push(output); // Store for debugging
			// NOTE: MCP responses go to stdout, but the *ready* signal for mcp-pm goes to stderr
			// console.log(`[Server STDOUT]: ${output.trim()}`);
		});

		serverProcess.stderr.on("data", (data: Buffer) => {
			const output = data.toString();
			console.error(`[Server STDERR RAW]: ${output}`); // Log raw stderr data
			serverErrorOutput.push(output); // Store for debugging/errors
			console.error(`[Server STDERR]: ${output.trim()}`); // Log stderr for visibility

			// Check for the ready signal in stderr
			if (!serverReady && output.includes(SERVER_READY_OUTPUT)) {
				console.log("[TEST] MCP server ready signal detected in stderr.");
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

		serverProcess.on("error", (err) => {
			console.error("[TEST] Failed to start server process:", err);
			if (!serverReady) {
				clearTimeout(startupTimeoutTimer);
				rejectServerReady(err);
			}
		});

		serverProcess.on("exit", (code, signal) => {
			serverExitCode = code;
			console.log(
				`[TEST] Server process exited. Code: ${code}, Signal: ${signal}`,
			);
			if (!serverReady) {
				clearTimeout(startupTimeoutTimer);
				const errMsg = `Server process exited prematurely (code ${code}, signal ${signal}) before ready signal. Stderr: ${serverErrorOutput.join("")}`;
				console.error(`[TEST] ${errMsg}`);
				rejectServerReady(new Error(errMsg));
			}
			// If it exits *after* being ready but *before* we killed it, it might be an issue
			else if (!serverWasKilled) {
				console.warn(
					`[TEST] Server process exited unexpectedly after being ready (code ${code}, signal ${signal}).`,
				);
				// We might want to fail ongoing tests if this happens, but that's complex.
				// For now, just log it. The tests relying on the process will fail anyway.
			}
		});

		serverProcess.on("close", () => {
			console.log("[TEST] Server stdio streams closed.");
		});

		try {
			console.log("[TEST] Waiting for server ready promise...");
			await serverReadyPromise;
			console.log("[TEST] Server startup successful.");
		} catch (err) {
			console.error("[TEST] Server startup failed:", err);
			// Ensure process is killed if startup failed partway
			if (serverProcess && !serverProcess.killed) {
				console.log("[TEST] Killing server process after startup failure...");
				serverWasKilled = true;
				serverProcess.kill("SIGKILL");
			}
			throw err; // Re-throw to fail the test setup
		}

		// Add a small delay after server is ready before proceeding
		await new Promise((resolve) => setTimeout(resolve, 200));
		console.log("[TEST] Short delay after server ready signal completed.");
	}, TEST_TIMEOUT); // Vitest timeout for the hook

	afterAll(async () => {
		console.log("[TEST] AfterAll: Tearing down server...");
		if (serverProcess && !serverProcess.killed) {
			console.log("[TEST] Terminating server process...");
			serverWasKilled = true; // Signal that we initiated the kill
			serverProcess.stdin.end(); // Close stdin first
			const killed = serverProcess.kill("SIGTERM"); // Attempt graceful shutdown
			if (killed) {
				console.log("[TEST] Sent SIGTERM to server process.");
				// Wait briefly for graceful exit
				await new Promise((resolve) => setTimeout(resolve, 500));
				if (!serverProcess.killed) {
					console.warn(
						"[TEST] Server did not exit after SIGTERM, sending SIGKILL.",
					);
					serverProcess.kill("SIGKILL");
				} else {
					console.log(
						"[TEST] Server process terminated gracefully after SIGTERM.",
					);
				}
			} else {
				console.warn(
					"[TEST] Failed to send SIGTERM, attempting SIGKILL directly.",
				);
				serverProcess.kill("SIGKILL");
			}
		} else {
			console.log("[TEST] Server process already terminated or not started.");
		}
		// Optional: Cleanup temporary directories/files if created by tests
		console.log("[TEST] AfterAll: Teardown complete.");
	});

	// Can be placed inside the describe block or outside (if exported from a helper module)
	// Using the guide's version directly, ensure it's adapted for TypeScript/Vitest context
	async function sendRequest(
		process: ChildProcessWithoutNullStreams,
		request: Record<string, unknown>,
		timeoutMs = 10000, // 10 second timeout
	): Promise<unknown> {
		const requestId = request.id as string;
		if (!requestId) {
			throw new Error('Request must have an "id" property');
		}
		const requestString = `${JSON.stringify(request)}\n`;
		console.log(
			`[sendRequest] Sending request (ID ${requestId}): ${requestString.trim()}`,
		);

		return new Promise((resolve, reject) => {
			let responseBuffer = "";
			let responseReceived = false;
			let responseListenersAttached = false; // Flag to prevent attaching multiple listeners

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
				// console.log(`[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk}`); // Verbose: Log raw chunks
				responseBuffer += rawChunk;
				const lines = responseBuffer.split("\n");
				responseBuffer = lines.pop() || ""; // Keep incomplete line fragment

				for (const line of lines) {
					if (line.trim() === "") continue;
					// console.log(`[sendRequest] Processing line for ${requestId}: ${line}`); // Verbose: Log processed lines
					try {
						const parsedResponse = JSON.parse(line);
						if (parsedResponse.id === requestId) {
							console.log(
								`[sendRequest] Received matching response for ID ${requestId}: ${line.trim()}`,
							);
							responseReceived = true;
							cleanup();
							resolve(parsedResponse);
							return; // Found the response
						}
						// console.log(`[sendRequest] Ignoring response with different ID (${parsedResponse.id}) for request ${requestId}`); // Verbose: Log ignored responses
					} catch (e) {
						// Ignore lines that aren't valid JSON or don't match ID
						// console.warn(`[sendRequest] Failed to parse potential JSON line for ${requestId}: ${line}`, e); // Verbose: Log parse errors
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
				// console.log(`[sendRequest] Cleaning up listeners for request ID ${requestId}`); // Verbose: Log listener cleanup
				clearTimeout(timeoutTimer);
				if (responseListenersAttached) {
					process.stdout.removeListener("data", onData);
					process.stderr.removeListener("data", logStderr); // Also remove stderr listener if added
					process.removeListener("error", onError);
					process.removeListener("exit", onExit);
					responseListenersAttached = false; // Mark as removed
				}
			};

			// Temporary stderr listener during request wait (optional, for debugging)
			const logStderr = (data: Buffer) => {
				console.error(
					`[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
				);
			};

			// Attach listeners only once per request
			if (!responseListenersAttached) {
				// console.log(`[sendRequest] Attaching listeners for request ID ${requestId}`); // Verbose: Log listener attachment
				process.stdout.on("data", onData);
				process.stderr.on("data", logStderr); // Listen to stderr too
				process.once("error", onError); // Use once for exit/error during wait
				process.once("exit", onExit);
				responseListenersAttached = true;
			}

			// Write the request to stdin
			// console.log(`[sendRequest] Writing request (ID ${requestId}) to stdin...`); // Verbose: Log stdin write
			process.stdin.write(requestString, (err) => {
				if (err) {
					if (!responseReceived) {
						// Check if already resolved/rejected
						cleanup();
						const errorMsg = `Failed to write to server stdin for ID ${requestId}: ${err.message}`;
						console.error(`[sendRequest] ${errorMsg}`);
						reject(new Error(errorMsg));
					}
				} else {
					// console.log(`[sendRequest] Successfully wrote request (ID ${requestId}) to stdin.`); // Verbose: Log successful stdin write
				}
			});
		});
	}

	// --- Test Cases ---

	// Test #1: List initially empty
	it(
		"should list zero processes initially",
		async () => {
			console.log("[TEST][listEmpty] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}

			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_processes",
					arguments: { log_lines: 0 }, // Default log_lines = 0
				},
				id: "req-list-empty-1",
			};

			console.log("[TEST][listEmpty] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][listEmpty] Received response:",
				JSON.stringify(response),
			);

			console.log("[TEST][listEmpty] Asserting response properties...");
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();

			const resultContent = response.result as {
				content: Array<{ type: string; text: string }>;
			};
			expect(resultContent?.content?.[0]?.text).toBeDefined();

			let listResult: ProcessStatusResult[] | null = null;
			try {
				listResult = JSON.parse(resultContent.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse list_processes result payload: ${e}`);
			}

			expect(listResult).toBeInstanceOf(Array);
			expect(listResult?.length).toBe(0);
			console.log("[TEST][listEmpty] Assertions passed. Test finished.");
		},
		TEST_TIMEOUT,
	);

	// Test #2: Health Check
	it(
		"should respond successfully to health_check",
		async () => {
			console.log("[TEST][healthCheck] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}
			console.log("[TEST][healthCheck] Server process check passed.");

			const healthRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "health_check",
					arguments: {},
				},
				id: "req-health-1",
			};
			console.log("[TEST][healthCheck] Sending health_check request...");

			const response = (await sendRequest(
				serverProcess,
				healthRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][healthCheck] Received response:",
				JSON.stringify(response),
			);

			console.log("[TEST][healthCheck] Asserting response properties...");
			expect(response.id).toBe("req-health-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			console.log("[TEST][healthCheck] Asserting result properties...");
			// Correctly access and parse the result payload
			const resultContent = response.result as {
				content: Array<{ type: string; text: string }>;
			};
			expect(resultContent?.content?.[0]?.text).toBeDefined();

			try {
				const healthStatus = JSON.parse(resultContent.content[0].text);
				expect(healthStatus.status).toBe("ok");
				expect(healthStatus.server_name).toBe("mcp-pm");
			} catch (e) {
				throw new Error(`Failed to parse health_check result payload: ${e}`);
			}

			console.log("[TEST][healthCheck] Assertions passed.");
			console.log("[TEST][healthCheck] Test finished.");
		},
		TEST_TIMEOUT,
	);

	// Test #3: Start Process
	// Add back the start_process test, ensuring it runs AFTER health_check
	it(
		"should start a simple process and receive confirmation",
		async () => {
			console.log("[TEST][startProcess] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}
			console.log("[TEST][startProcess] Server process check passed.");
			const uniqueLabel = `test-process-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Node process started'); setTimeout(() => console.log('Node process finished'), 200);",
			];
			const workingDirectory = path.resolve(__dirname); // Use test dir as CWD
			console.log(
				`[TEST][startProcess] Generated label: ${uniqueLabel}, CWD: ${workingDirectory}`,
			);

			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: {
						command,
						args,
						workingDirectory,
						label: uniqueLabel,
					},
				},
				id: "req-start-1",
			};
			console.log("[TEST][startProcess] Sending start request...");

			const response = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][startProcess] Received response:",
				JSON.stringify(response),
			);

			console.log("[TEST][startProcess] Asserting response properties...");
			expect(response.id).toBe("req-start-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			console.log("[TEST][startProcess] Asserting result properties...");
			// Correctly access and parse the result payload
			const startResultContent = response.result as {
				content: Array<{ type: string; text: string }>;
			};
			expect(startResultContent?.content?.[0]?.text).toBeDefined();
			let startResult: ProcessStatusResult | null = null;
			try {
				startResult = JSON.parse(startResultContent.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse start_process result payload: ${e}`);
			}
			expect(startResult).not.toBeNull();
			expect(startResult.label).toBe(uniqueLabel);
			expect(startResult.status).toBe("running"); // Or 'starting' if verification is used
			console.log("[TEST][startProcess] Assertions passed.");

			// Optional: Add a short delay and check status again (tests checkProcessStatus)
			console.log("[TEST][startProcess] Waiting briefly...");
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Cleanup: Stop the process (tests stopProcess)
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-${uniqueLabel}`,
			};
			console.log("[TEST][stop] Sending stop_process request...");
			const stopResponse = (await sendRequest(
				serverProcess,
				stopRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][stop] Received stop response:",
				JSON.stringify(stopResponse),
			);
			// We don't strictly need to await or check the stop response here, main goal is cleanup
			console.log("[TEST][startProcess] Test finished.");
		},
		TEST_TIMEOUT,
	);

	// Test #4: List Processes (after start)
	it(
		"should list one running process after starting it",
		async () => {
			console.log("[TEST][listOne] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}

			// --- Start a process first ---
			const uniqueLabel = `test-list-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Process for listing test'); setInterval(() => {}, 1000);",
			]; // Keep alive
			const workingDirectory = path.resolve(__dirname);
			console.log(`[TEST][listOne] Starting process ${uniqueLabel}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: "req-start-for-list-1",
			};
			// We need to wait for the start request to complete, but we don't need to assert its result here
			await sendRequest(serverProcess, startRequest);
			console.log(`[TEST][listOne] Process ${uniqueLabel} started.`);
			// --- End Process Start ---

			// --- Now List Processes ---
			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_processes",
					arguments: { log_lines: 5 }, // Get a few log lines
				},
				id: "req-list-one-1",
			};

			console.log("[TEST][listOne] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][listOne] Received response:",
				JSON.stringify(response),
			);

			console.log("[TEST][listOne] Asserting response properties...");
			expect(response.error).toBeUndefined();
			expect(response.result).toBeDefined();

			const resultContent = response.result as {
				content: Array<{ type: string; text: string }>;
			};
			expect(resultContent?.content?.[0]?.text).toBeDefined();

			let listResult: ProcessStatusResult[] | null = null;
			try {
				listResult = JSON.parse(resultContent.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse list_processes result payload: ${e}`);
			}

			expect(listResult).toBeInstanceOf(Array);
			// Check that the list contains at least the process we just started
			expect(listResult?.length).toBeGreaterThanOrEqual(1);

			// Find the specific running process we started in this test
			const processInfo = listResult?.find((p) => p.label === uniqueLabel);
			expect(
				processInfo,
				`Process with label ${uniqueLabel} not found in list`,
			).toBeDefined();

			// Now assert properties of the found process
			expect(processInfo?.label).toBe(uniqueLabel);
			expect(processInfo?.status).toBe("running");
			expect(processInfo?.command).toBe(command);
			expect(processInfo?.pid).toBeGreaterThan(0);
			expect(processInfo?.logs?.length).toBeGreaterThanOrEqual(1); // Should have at least the spawn log
			console.log("[TEST][listOne] Assertions passed.");
			// --- End List Processes ---

			// --- Cleanup: Stop the process ---
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: "req-stop-cleanup-list-1",
			};
			console.log(
				`[TEST][listOne] Sending stop request for cleanup (${uniqueLabel})...`,
			);
			await sendRequest(serverProcess, stopRequest);
			console.log("[TEST][listOne] Cleanup stop request sent. Test finished.");
			// --- End Cleanup ---
		},
		TEST_TIMEOUT,
	);

	// Test #5: Check Process Status
	it(
		"should check the status of a running process",
		async () => {
			console.log("[TEST][checkStatus] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}

			// --- Start a process first ---
			const uniqueLabel = `test-check-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Process for checking status'); setInterval(() => {}, 1000);",
			]; // Keep alive
			const workingDirectory = path.resolve(__dirname);
			console.log(`[TEST][checkStatus] Starting process ${uniqueLabel}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: "req-start-for-check-1",
			};
			// We need to wait for the start request to complete, but we don't need to assert its result here
			await sendRequest(serverProcess, startRequest);
			console.log(`[TEST][checkStatus] Process ${uniqueLabel} started.`);
			// --- End Process Start ---

			// --- Now Check Process Status ---
			const checkRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_process_status",
					arguments: { label: uniqueLabel },
				},
				id: "req-check-1",
			};
			console.log(
				"[TEST][checkStatus] Sending check_process_status request...",
			);

			const response = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;
			console.log(
				"[TEST][checkStatus] Received response:",
				JSON.stringify(response),
			);

			console.log("[TEST][checkStatus] Asserting response properties...");
			expect(response.id).toBe("req-check-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			console.log("[TEST][checkStatus] Asserting result properties...");
			// Correctly access and parse the result payload
			const resultContent = response.result as {
				content: Array<{ type: string; text: string }>;
			};
			expect(resultContent?.content?.[0]?.text).toBeDefined();

			try {
				const processStatus = JSON.parse(resultContent.content[0].text);
				expect(processStatus.status).toBe("running");
				expect(processStatus.label).toBe(uniqueLabel);
				expect(processStatus.command).toBe(command);
				expect(processStatus.pid).toBeGreaterThan(0);
				expect(processStatus.logs?.length).toBeGreaterThanOrEqual(1); // Should have at least the spawn log
			} catch (e) {
				throw new Error(
					`Failed to parse check_process_status result payload: ${e}`,
				);
			}

			console.log("[TEST][checkStatus] Assertions passed.");
			console.log("[TEST][checkStatus] Test finished.");

			// --- Cleanup: Stop the process ---
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: "req-stop-cleanup-check-1",
			};
			console.log(
				`[TEST][checkStatus] Sending stop request for cleanup (${uniqueLabel})...`,
			);
			await sendRequest(serverProcess, stopRequest);
			console.log(
				"[TEST][checkStatus] Cleanup stop request sent. Test finished.",
			);
			// --- End Cleanup ---
		},
		TEST_TIMEOUT,
	);
});
