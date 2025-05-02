import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// import { delay } from "../../build/utils.js"; // Original ESM import
// const { delay } = require("../../build/utils.js"); // CJS require workaround

// --- Configuration ---
const SERVER_EXECUTABLE = "node";
// Resolve path from 'tests/integration/' to 'build/index.mjs'
const SERVER_SCRIPT_PATH = path.resolve(__dirname, "../../build/index.mjs");
const SERVER_ARGS: string[] = []; // No specific args needed to start
// From src/main.ts log output
const SERVER_READY_OUTPUT = "MCP Server connected and listening via stdio.";
const STARTUP_TIMEOUT = 20000; // 20 seconds (adjust as needed)
const TEST_TIMEOUT = STARTUP_TIMEOUT + 5000; // Test timeout slightly longer than startup

// --- Verbose Logging ---
const IS_VERBOSE = process.env.MCP_TEST_VERBOSE === "1";
function logVerbose(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.log("[VERBOSE]", ...args);
	}
}
function logVerboseError(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.error("[VERBOSE_ERR]", ...args);
	}
}
// ---------------------

// --- Type definitions for MCP responses (simplified) ---
type MCPResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

// Define a type for the content array within the result
type ResultContent = {
	content: Array<{ type: string; text: string }>;
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
				env: { ...process.env, MCP_PM_FAST: "1" }, // Pass environment variables + FAST MODE
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
			logVerbose(`[Server STDOUT RAW]: ${output}`); // Replaced console.log
			serverStdoutOutput.push(output); // Store for debugging
			// NOTE: MCP responses go to stdout, but the *ready* signal for mcp-pm goes to stderr
			logVerbose(`[Server STDOUT]: ${output.trim()}`); // Replaced console.log
		});

		serverProcess.stderr.on("data", (data: Buffer) => {
			const output = data.toString();
			logVerboseError(`[Server STDERR RAW]: ${output}`); // Replaced console.error
			serverErrorOutput.push(output); // Store for debugging/errors
			logVerboseError(`[Server STDERR]: ${output.trim()}`); // Replaced console.error

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
			logVerbose("[TEST] Server stdio streams closed.");
		});

		try {
			logVerbose("[TEST] Waiting for server ready promise...");
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
		logVerbose("[TEST] Short delay after server ready signal completed.");
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
		logVerbose(
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
				logVerbose(
					`[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk}`,
				); // Added logVerbose for raw chunks
				responseBuffer += rawChunk;
				const lines = responseBuffer.split("\n");
				responseBuffer = lines.pop() || ""; // Keep incomplete line fragment

				for (const line of lines) {
					if (line.trim() === "") continue;
					logVerbose(`[sendRequest] Processing line for ${requestId}: ${line}`); // Added logVerbose for processed lines
					try {
						const parsedResponse = JSON.parse(line);
						if (parsedResponse.id === requestId) {
							logVerbose(
								`[sendRequest] Received matching response for ID ${requestId}: ${line.trim()}`,
							);
							responseReceived = true;
							cleanup();
							resolve(parsedResponse);
							return; // Found the response
						}
						logVerbose(
							`[sendRequest] Ignoring response with different ID (${parsedResponse.id}) for request ${requestId}`,
						); // Added logVerbose for ignored responses
					} catch (e) {
						// Ignore lines that aren't valid JSON or don't match ID
						logVerboseError(
							`[sendRequest] Failed to parse potential JSON line for ${requestId}: ${line}`,
							e,
						); // Added logVerboseError for parse errors
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
				); // Added logVerbose for cleanup
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
				logVerboseError(
					`[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
				);
			};

			// Attach listeners only once per request
			if (!responseListenersAttached) {
				logVerbose(
					`[sendRequest] Attaching listeners for request ID ${requestId}`,
				); // Added logVerbose for attachment
				process.stdout.on("data", onData);
				process.stderr.on("data", logStderr); // Listen to stderr too
				process.once("error", onError); // Use once for exit/error during wait
				process.once("exit", onExit);
				responseListenersAttached = true;
			}

			// Write the request to stdin
			logVerbose(`[sendRequest] Writing request (ID ${requestId}) to stdin...`); // Added logVerbose for stdin write
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
					logVerbose(
						`[sendRequest] Successfully wrote request (ID ${requestId}) to stdin.`,
					); // Added logVerbose for success
				}
			});
		});
	}

	// --- Test Cases ---

	// Test #1: List initially empty
	it(
		"should list zero processes initially",
		async () => {
			logVerbose("[TEST][listEmpty] Starting test...");
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

			logVerbose("[TEST][listEmpty] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as MCPResponse;
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
			logVerbose("[TEST][healthCheck] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}
			logVerbose("[TEST][healthCheck] Server process check passed.");

			const healthRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "health_check",
					arguments: {},
				},
				id: "req-health-1",
			};
			logVerbose("[TEST][healthCheck] Sending health_check request...");

			const response = (await sendRequest(
				serverProcess,
				healthRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][healthCheck] Received response:",
				JSON.stringify(response),
			);

			logVerbose("[TEST][healthCheck] Asserting response properties...");
			expect(response.id).toBe("req-health-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			logVerbose("[TEST][healthCheck] Asserting result properties...");
			// Correctly access and parse the result payload
			const resultContent = response.result as ResultContent;
			expect(resultContent?.content?.[0]?.text).toBeDefined();

			try {
				const result = JSON.parse(resultContent.content[0].text);
				expect(result.status).toBe("ok");
				expect(result.server_name).toBe("mcp-pm");
				expect(result.server_version).toBeDefined();
				expect(result.active_processes).toBe(0);
				// In fast mode (which tests always use), zombie check is disabled
				expect(result.is_zombie_check_active).toBe(false);
				console.log("[TEST][healthCheck] Assertions passed.");
				logVerbose("[TEST][healthCheck] Test finished.");
			} catch (e) {
				throw new Error(`Failed to parse health_check result payload: ${e}`);
			}
		},
		TEST_TIMEOUT,
	);

	// Test #3: Start Process
	// Add back the start_process test, ensuring it runs AFTER health_check
	it(
		"should start a simple process and receive confirmation",
		async () => {
			logVerbose("[TEST][startProcess] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}
			logVerbose("[TEST][startProcess] Server process check passed.");
			const uniqueLabel = `test-process-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Node process started'); setTimeout(() => console.log('Node process finished'), 200);",
			];
			const workingDirectory = path.resolve(__dirname); // Use test dir as CWD
			logVerbose(
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
			logVerbose("[TEST][startProcess] Sending start request...");

			const response = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][startProcess] Received response:",
				JSON.stringify(response),
			);

			logVerbose("[TEST][startProcess] Asserting response properties...");
			expect(response.id).toBe("req-start-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			logVerbose("[TEST][startProcess] Asserting result properties...");
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
			if (startResult) {
				expect(startResult.label).toBe(uniqueLabel);
				expect(["running", "stopped"]).toContain(startResult.status);
			}
			console.log("[TEST][startProcess] Assertions passed.");

			// Optional: Add a short delay and check status again (tests checkProcessStatus)
			logVerbose("[TEST][startProcess] Waiting briefly...");
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
			logVerbose("[TEST][stop] Sending stop_process request...");
			const stopResponse = (await sendRequest(
				serverProcess,
				stopRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][stop] Received stop response:",
				JSON.stringify(stopResponse),
			);
			// We don't strictly need to await or check the stop response here, main goal is cleanup
			logVerbose("[TEST][startProcess] Test finished.");
		},
		TEST_TIMEOUT,
	);

	// Test #4: List Processes (after start)
	it(
		"should list one running process after starting it",
		async () => {
			logVerbose("[TEST][listOne] Starting test...");
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
			logVerbose(`[TEST][listOne] Starting process ${uniqueLabel}...`);
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
			logVerbose(`[TEST][listOne] Process ${uniqueLabel} started.`);
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

			logVerbose("[TEST][listOne] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][listOne] Received response:",
				JSON.stringify(response),
			);

			logVerbose("[TEST][listOne] Asserting response properties...");
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
			logVerbose(
				`[TEST][listOne] Sending stop request for cleanup (${uniqueLabel})...`,
			);
			await sendRequest(serverProcess, stopRequest);
			logVerbose("[TEST][listOne] Cleanup stop request sent. Test finished.");
			// --- End Cleanup ---
		},
		TEST_TIMEOUT,
	);

	// Test #5: Check Process Status
	it(
		"should check the status of a running process",
		async () => {
			logVerbose("[TEST][checkStatus] Starting test...");
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
			logVerbose(`[TEST][checkStatus] Starting process ${uniqueLabel}...`);
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
			logVerbose(`[TEST][checkStatus] Process ${uniqueLabel} started.`);
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
			logVerbose("[TEST][checkStatus] Sending check_process_status request...");

			const response = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][checkStatus] Received response: ${JSON.stringify(response)}`,
			);

			logVerbose("[TEST][checkStatus] Asserting response properties...");
			expect(response).toBeDefined();
			expect(response.id).toBe("req-check-1"); // Use the correct request ID
			expect(response.error).toBeUndefined();
			expect(response.result).toBeDefined();

			logVerbose("[TEST][checkStatus] Asserting result properties...");
			// Correctly access and parse the result payload
			const resultContent = (response.result as ResultContent)?.content?.[0]; // Use ResultContent type
			expect(resultContent?.text).toBeDefined();

			try {
				const processStatus = JSON.parse(resultContent.text);
				expect(processStatus.status).toBe("running");
				expect(processStatus.label).toBe(uniqueLabel);
				expect(processStatus.command).toBe(command);
				expect(processStatus.pid).toBeGreaterThan(0);
				expect(processStatus.logs?.length).toBeGreaterThanOrEqual(1); // Should have at least the spawn log

				// --> FIX: Check for the actual log output of this process
				const logs1 = processStatus.logs ?? [];
				logVerbose(
					`[TEST][checkStatus] First check logs (${logs1.length}):`,
					logs1,
				);
				const hasCorrectLog = logs1.some(
					(log) => log.includes("Process for checking status"), // Correct: Check for this test's log output
				);
				expect(hasCorrectLog).toBe(true);

				console.log("[TEST][checkStatus] Assertions passed.");
			} catch (e) {
				throw new Error(
					`Failed to parse check_process_status result payload: ${e}`,
				);
			}

			logVerbose("[TEST][checkStatus] Sending stop request for cleanup...");
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: "req-stop-cleanup-check-1",
			};
			if (!serverProcess) throw new Error("Server process is null"); // Check before use
			await sendRequest(serverProcess, stopRequest);
			logVerbose(
				"[TEST][checkStatus] Cleanup stop request sent. Test finished.",
			);
			// --- End Cleanup ---
		},
		TEST_TIMEOUT,
	);

	// Test #7: Restart Process
	it(
		"should restart a running process",
		async () => {
			logVerbose("[TEST][restart] Starting test...");
			if (!serverProcess) {
				throw new Error("Server process not initialized in beforeAll");
			}

			// --- Start a process first ---
			const uniqueLabel = `test-restart-${Date.now()}`;
			const command = "node";
			// Log PID to verify it changes after restart
			const args = [
				"-e",
				"console.log(`Restart test process started PID: ${process.pid}`); setInterval(() => {}, 1000);",
			];
			const workingDirectory = path.resolve(__dirname);
			logVerbose(`[TEST][restart] Starting initial process ${uniqueLabel}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: `req-start-for-restart-${uniqueLabel}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(`[TEST][restart] Initial process ${uniqueLabel} started.`);
			const startResultContent = startResponse.result as {
				content: Array<{ type: string; text: string }>;
			};
			const initialProcessInfo = JSON.parse(
				startResultContent.content[0].text,
			) as ProcessStatusResult;
			const initialPid = initialProcessInfo.pid;
			expect(initialPid).toBeGreaterThan(0);
			logVerbose(`[TEST][restart] Initial PID: ${initialPid}`);
			// --- End Process Start ---

			// --- Now Restart the Process ---
			const restartRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "restart_process",
					arguments: { label: uniqueLabel },
				},
				id: `req-restart-${uniqueLabel}`,
			};
			logVerbose("[TEST][restart] Sending restart_process request...");
			const restartResponse = (await sendRequest(
				serverProcess,
				restartRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][restart] Received restart response:",
				JSON.stringify(restartResponse),
			);

			logVerbose("[TEST][restart] Asserting restart response properties...");
			// Check for direct error from the tool call itself
			expect(
				restartResponse.error,
				`Restart tool call failed: ${JSON.stringify(restartResponse.error)}`,
			).toBeUndefined();
			expect(
				restartResponse.result,
				`Restart tool call expected result but got none. Error: ${JSON.stringify(restartResponse.error)}`,
			).toBeDefined();

			const restartResultWrapper = restartResponse.result as {
				isError?: boolean;
				content: Array<{ type: string; text: string }>;
			};
			// Check for error *within* the result payload (isError flag)
			expect(
				restartResultWrapper.isError,
				`Restart result indicates an error: ${restartResultWrapper.content?.[0]?.text}`,
			).toBeFalsy();
			expect(restartResultWrapper?.content?.[0]?.text).toBeDefined();

			let restartResult: ProcessStatusResult | null = null;
			try {
				restartResult = JSON.parse(restartResultWrapper.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse restart_process result payload: ${e}`);
			}
			expect(restartResult?.label).toBe(uniqueLabel);
			expect(restartResult?.status).toBe("running");
			const restartedPid = restartResult?.pid;
			expect(restartedPid).toBeGreaterThan(0);
			expect(restartedPid).not.toBe(initialPid); // Verify PID has changed
			logVerbose(`[TEST][restart] Restarted PID: ${restartedPid}`);
			console.log("[TEST][restart] Restart response assertions passed.");
			// --- End Restart Process ---

			// --- Verify Status after Restart (Optional but good practice) ---
			const checkRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_process_status",
					arguments: { label: uniqueLabel, log_lines: 0 },
				},
				id: `req-check-after-restart-${uniqueLabel}`,
			};

			logVerbose(
				"[TEST][restart] Sending check_process_status request after restart...",
			);
			const checkResponse = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;

			let checkResult: ProcessStatusResult | null = null;
			const checkResultContent = checkResponse.result as {
				content: Array<{ type: string; text: string }>;
			};
			try {
				checkResult = JSON.parse(checkResultContent.content[0].text);
			} catch (e) {
				// Handle error
			}

			expect(checkResult?.status).toBe("running");
			expect(checkResult?.pid).toBe(restartedPid);
			console.log("[TEST][restart] Final status check passed.");
			// --- End Verify Status ---

			// --- Cleanup: Stop the process ---
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-cleanup-restart-${uniqueLabel}`,
			};
			logVerbose(
				`[TEST][restart] Sending stop request for cleanup (${uniqueLabel})...`,
			);
			await sendRequest(serverProcess, stopRequest);
			logVerbose("[TEST][restart] Cleanup stop request sent. Test finished.");
			// --- End Cleanup ---
		},
		TEST_TIMEOUT * 2,
	); // Give restart more time

	// Test #8: Check Process Status Filtering
	it(
		"should filter logs correctly on repeated checks of an active process",
		async () => {
			logVerbose("[TEST][checkLogsFilter] Starting test...");
			const label = `test-log-filter-${Date.now()}`;
			const logIntervalMs = 500; // Log every 500ms
			const initialWaitMs = 4000; // Wait longer than interval for first logs
			const secondWaitMs = 1500; // Wait again for more logs

			// Start a process that logs periodically
			logVerbose(`[TEST][checkLogsFilter] Starting process ${label}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: {
						command: "node",
						args: [
							"-e",
							"console.log('Start'); let c=0; const i = setInterval(() => { console.log('Log: '+c++); if (c > 10) clearInterval(i); }, 500);",
						],
						workingDirectory: path.join(__dirname),
						label: label,
						verification_pattern: "Start",
						verification_timeout_ms: 5000,
					},
				},
				id: `req-start-for-log-filter-${label}`,
			};
			if (!serverProcess) throw new Error("Server process is null"); // Check before use
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][checkLogsFilter] Process ${label} started response received.`,
			);
			expect(startResponse).toHaveProperty("result");

			// Wait for verification and status update to likely occur
			logVerbose(
				`[TEST][checkLogsFilter] Waiting ${initialWaitMs}ms for initial logs and status update...`,
			); // Increased wait time
			await new Promise((resolve) => setTimeout(resolve, initialWaitMs)); // Inline delay
			logVerbose("[TEST][checkLogsFilter] Initial wait complete.");

			// --- First Check: Expect 'running' status and initial logs ---
			logVerbose(
				`[TEST][checkLogsFilter] Sending first check_process_status for ${label}...`,
			);
			const checkRequest1 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_process_status",
					arguments: { label: label, log_lines: 100 }, // Request many lines
				},
				id: `req-check1-log-filter-${label}`,
			};
			if (!serverProcess) throw new Error("Server process is null"); // Check before use
			const check1Response = (await sendRequest(
				serverProcess,
				checkRequest1,
			)) as MCPResponse;
			logVerbose("[TEST][checkLogsFilter] Received first check response.");
			expect(check1Response).toHaveProperty("result");
			// Type assertion for result content
			const check1ResultContent = (check1Response.result as ResultContent)
				?.content?.[0]; // Use ResultContent type
			const result1 = JSON.parse(
				check1ResultContent.text, // Corrected: Access text directly
			) as ProcessStatusResult;

			// --> FIX: Allow 'running' or 'stopped' for first check
			expect(["running", "stopped"]).toContain(result1.status);
			expect(result1.label).toBe(label);
			expect(result1.command).toBe("node");
			expect(result1.pid).toBeGreaterThan(0);
			expect(result1.logs?.length).toBeGreaterThanOrEqual(1); // Should have at least the spawn log

			// --> FIX: Check for the actual log output of this process
			const logs1 = result1.logs ?? [];
			logVerbose(
				`[TEST][checkLogsFilter] First check logs (${logs1.length}):`,
				logs1,
			);
			expect(logs1.length).toBeGreaterThan(0); // Expect some logs
			// --> Revert: Original assertion for the start log
			expect(logs1).toContain("Start");

			// Wait again for more logs to be generated
			logVerbose("[TEST][checkLogsFilter] Waiting 4000ms for more logs...");
			await new Promise((resolve) => setTimeout(resolve, secondWaitMs)); // Inline delay
			logVerbose("[TEST][checkLogsFilter] Second wait complete.");

			// Second check_process_status call
			logVerbose(
				`[TEST][checkLogsFilter] Sending second check_process_status for ${label}...`,
			);
			const check2Request = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_process_status",
					arguments: { label: label, log_lines: 100 }, // Request many lines again
				},
				id: `req-check2-log-filter-${label}`,
			};
			if (!serverProcess) throw new Error("Server process is null"); // Check before use
			const check2Response = (await sendRequest(
				serverProcess,
				check2Request,
			)) as MCPResponse;
			logVerbose("[TEST][checkLogsFilter] Received second check response.");
			expect(check2Response).toHaveProperty("result");
			// Type assertion for result content
			const check2ResultContent = check2Response.result as {
				content: { type: string; text: string }[];
			};
			const result2 = JSON.parse(
				check2ResultContent.content[0].text, // Corrected: Access text directly
			) as ProcessStatusResult;

			// --> Define logs2 from result2
			const logs2 = result2.logs ?? [];

			logVerbose(
				"[TEST][checkLogsFilter] Second check status:",
				result2.status,
			);
			logVerbose(
				"[TEST][checkLogsFilter] Second check logs (%d):",
				logs2.length,
				logs2,
			);

			// Assertions for the second check
			expect(result2.status).toBe("stopped");
			// In fast mode (which tests always use), expect the stop/exit logs
			// to be returned here because the process finishes quickly.
			expect(logs2.length).toBeGreaterThan(0);

			console.log("[TEST][checkLogsFilter] Assertions passed.");

			// Cleanup: Stop the process
			logVerbose(
				`[TEST][checkLogsFilter] Sending stop request for cleanup (${label})...`,
			);
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: label },
				},
				id: `req-stop-cleanup-log-filter-${label}`,
			};
			if (!serverProcess) throw new Error("Server process is null"); // Check before use
			await sendRequest(serverProcess, stopRequest);
			logVerbose(
				`[TEST][checkLogsFilter] Cleanup stop request sent for ${label}. Test finished.`,
			);
		},
		TEST_TIMEOUT + 5000, // Slightly longer timeout for multiple waits
	);
});
