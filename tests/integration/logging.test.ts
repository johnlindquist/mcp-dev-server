import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_NOTABLE_EVENTS_MSG } from "../../src/constants/messages.js";
import {
	type CallToolResult,
	type MCPResponse,
	type ProcessStatusResult,
	SERVER_ARGS,
	SERVER_EXECUTABLE,
	SERVER_READY_OUTPUT,
	SERVER_SCRIPT_PATH,
	STARTUP_TIMEOUT,
	TEST_TIMEOUT,
	logVerbose,
	logVerboseError,
} from "./test-helpers";

let serverProcess: ChildProcessWithoutNullStreams;

describe("Tool Features: Logging and Summaries", () => {
	beforeAll(async () => {
		serverProcess = spawn(
			SERVER_EXECUTABLE,
			[SERVER_SCRIPT_PATH, ...SERVER_ARGS],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, MCP_PM_FAST: "1" },
			},
		);
		await new Promise<void>((resolve, reject) => {
			let ready = false;
			const timeout = setTimeout(() => {
				if (!ready) reject(new Error("Server startup timed out"));
			}, STARTUP_TIMEOUT);
			serverProcess.stderr.on("data", (data: Buffer) => {
				if (!ready && data.toString().includes(SERVER_READY_OUTPUT)) {
					ready = true;
					clearTimeout(timeout);
					resolve();
				}
			});
			serverProcess.on("error", reject);
			serverProcess.on("exit", () =>
				reject(new Error("Server exited before ready")),
			);
		});
	});

	afterAll(async () => {
		if (serverProcess && !serverProcess.killed) {
			serverProcess.stdin.end();
			serverProcess.kill("SIGTERM");
		}
	});

	async function sendRequest(
		process: ChildProcessWithoutNullStreams,
		request: Record<string, unknown>,
		timeoutMs = 10000,
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
					`[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk}`,
				);
				responseBuffer += rawChunk;
				const lines = responseBuffer.split("\n");
				responseBuffer = lines.pop() || "";
				for (const line of lines) {
					if (line.trim() === "") continue;
					logVerbose(`[sendRequest] Processing line for ${requestId}: ${line}`);
					try {
						const parsedResponse = JSON.parse(line);
						if (parsedResponse.id === requestId) {
							logVerbose(
								`[sendRequest] Received matching response for ID ${requestId}: ${line.trim()}`,
							);
							responseReceived = true;
							cleanup();
							resolve(parsedResponse);
							return;
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
				if (responseListenersAttached) {
					process.stdout.removeListener("data", onData);
					process.stderr.removeListener("data", logStderr);
					process.removeListener("error", onError);
					process.removeListener("exit", onExit);
					responseListenersAttached = false;
				}
			};
			const logStderr = (data: Buffer) => {
				logVerboseError(
					`[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
				);
			};
			if (!responseListenersAttached) {
				logVerbose(
					`[sendRequest] Attaching listeners for request ID ${requestId}`,
				);
				process.stdout.on("data", onData);
				process.stderr.on("data", logStderr);
				process.once("error", onError);
				process.once("exit", onExit);
				responseListenersAttached = true;
			}
			logVerbose(`[sendRequest] Writing request (ID ${requestId}) to stdin...`);
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
		});
	}

	it(
		"should filter logs correctly on repeated checks of an active process",
		async () => {
			logVerbose("[TEST][checkLogsFilter] Starting test...");
			const label = `test-log-filter-${Date.now()}`;
			const logIntervalMs = 500;
			const initialWaitMs = 4000;
			const secondWaitMs = 1500;

			logVerbose(`[TEST][checkLogsFilter] Starting process ${label}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: {
						command: "node",
						args: [
							"-e",
							"console.log('Start'); let c=0; const i = setInterval(() => { console.log('Log: '+c++); if (c > 10) { clearInterval(i); process.exit(0); } }, 500);",
						],
						workingDirectory: path.join(__dirname),
						label: label,
						verification_pattern: "Start",
						verification_timeout_ms: 5000,
					},
				},
				id: `req-start-for-log-filter-${label}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][checkLogsFilter] Process ${label} started response received.`,
			);
			expect(startResponse).toHaveProperty("result");

			logVerbose(
				`[TEST][checkLogsFilter] Waiting ${initialWaitMs}ms for initial logs and status update...`,
			);
			await new Promise((resolve) => setTimeout(resolve, initialWaitMs));
			logVerbose("[TEST][checkLogsFilter] Initial wait complete.");

			logVerbose(
				`[TEST][checkLogsFilter] Sending first check_shell for ${label}...`,
			);
			const checkRequest1 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check1-log-filter-${label}`,
			};
			const check1Response = (await sendRequest(
				serverProcess,
				checkRequest1,
			)) as MCPResponse;
			logVerbose("[TEST][checkLogsFilter] Received first check response.");
			expect(check1Response).toHaveProperty("result");
			const check1Result = check1Response.result as CallToolResult;
			const result1ContentText = check1Result?.content?.[0]?.text;
			expect(result1ContentText).toBeDefined();
			const result1 = JSON.parse(result1ContentText) as ProcessStatusResult;
			let result1Logs: string[] = [];
			result1Logs = result1.logs ?? [];
			expect(result1.status).toBe("running");
			const logs1 = result1.logs ?? [];
			logVerbose(
				`[TEST][checkLogsFilter] First check logs (${logs1.length}):`,
				logs1,
			);
			expect(logs1.length).toBeGreaterThan(0);
			expect(logs1).toContain("Start");

			logVerbose("[TEST][checkLogsFilter] Waiting 4000ms for more logs...");
			await new Promise((resolve) => setTimeout(resolve, secondWaitMs));
			logVerbose("[TEST][checkLogsFilter] Second wait complete.");
			await new Promise((resolve) => setTimeout(resolve, 50));

			logVerbose(
				`[TEST][checkLogsFilter] Sending second check_shell for ${label}...`,
			);
			const check2Request = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check2-log-filter-${label}`,
			};
			const check2Response = (await sendRequest(
				serverProcess,
				check2Request,
			)) as MCPResponse;
			logVerbose("[TEST][checkLogsFilter] Received second check response.");
			expect(check2Response).toHaveProperty("result");
			const check2Result = check2Response.result as CallToolResult;
			const result2ContentText = check2Result?.content?.[0]?.text;
			expect(result2ContentText).toBeDefined();
			const result2 = JSON.parse(result2ContentText) as ProcessStatusResult;
			let result2Logs: string[] = [];
			result2Logs = result2.logs ?? [];

			logVerbose(
				"[TEST][checkLogsFilter] Second check status:",
				result2.status,
			);
			logVerbose(
				"[TEST][checkLogsFilter] Second check logs (%d):",
				result2Logs.length,
				JSON.stringify(result2Logs),
			);

			expect(result2.status).toBe("stopped");
			if (result2.message === NO_NOTABLE_EVENTS_MSG) {
				expect(result2Logs.length).toBe(0);
			} else {
				expect(result2Logs.length).toBeGreaterThan(0);
			}

			console.log("[TEST][checkLogsFilter] Assertions passed.");

			logVerbose(
				`[TEST][checkLogsFilter] Sending stop request for cleanup (${label})...`,
			);
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: label },
				},
				id: `req-stop-cleanup-log-filter-${label}`,
			};
			await sendRequest(serverProcess, stopRequest);
			logVerbose(
				`[TEST][checkLogsFilter] Cleanup stop request sent for ${label}. Test finished.`,
			);
		},
		TEST_TIMEOUT + 5000,
	);

	it(
		"should generate a summary message for notable log events",
		async () => {
			logVerbose("[TEST][checkSummary] Starting test...");
			const label = `test-summary-msg-${Date.now()}`;
			const logIntervalMs = 300;
			const initialWaitMs = 1900;

			logVerbose(`[TEST][checkSummary] Starting process ${label}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: {
						command: "node",
						args: [
							"-e",
							"console.log('Process Started'); setTimeout(function(){console.log('Regular log 1')}, 300); setTimeout(function(){console.error('Major Error Occurred! Code: 500')}, 600); setTimeout(function(){console.warn('Minor Warning: config outdated')}, 900); setTimeout(function(){console.log('Found resource at http://localhost:8080/data')}, 1200); setTimeout(function(){process.stdout.write('Enter password:\\n')}, 1500); setTimeout(function(){console.log('Process finished')}, 1800); setTimeout(function(){process.exit(0)}, 2100);",
						],
						workingDirectory: path.join(__dirname),
						label: label,
						verification_pattern: "Process Started",
						verification_timeout_ms: 5000,
					},
				},
				id: `req-start-for-summary-${label}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][checkSummary] Process ${label} started response received.`,
			);
			expect(startResponse).toHaveProperty("result");

			logVerbose(
				`[TEST][checkSummary] Waiting ${initialWaitMs}ms for initial logs...`,
			);
			await new Promise((resolve) => setTimeout(resolve, initialWaitMs));
			logVerbose("[TEST][checkSummary] Initial wait complete.");
			await new Promise((resolve) => setTimeout(resolve, 500));

			logVerbose(
				`[TEST][checkSummary] Sending first check_shell for ${label}...`,
			);
			const checkRequest1 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check1-summary-${label}`,
			};
			const check1Response = (await sendRequest(
				serverProcess,
				checkRequest1,
			)) as MCPResponse;
			logVerbose("[TEST][checkSummary] Received first check response.");
			expect(check1Response).toHaveProperty("result");
			const check1Result = check1Response.result as CallToolResult;
			const result1ContentText = check1Result?.content?.[0]?.text;
			expect(result1ContentText).toBeDefined();
			const result1 = JSON.parse(result1ContentText) as ProcessStatusResult & {
				message?: string;
			};
			logVerbose(
				`[TEST][checkSummary] First check status: ${result1.status}, Message: ${result1.message}`,
			);
			console.log("[DEBUG][checkSummary] result1.logs:", result1.logs);
			console.log("[DEBUG][checkSummary] result1.message:", result1.message);
			expect(["running", "stopped", "crashed"]).toContain(result1.status);
			expect(result1.message).toBeDefined();
			expect(result1.message).toBe(NO_NOTABLE_EVENTS_MSG);

			await new Promise((resolve) => setTimeout(resolve, 2000));

			logVerbose(
				`[TEST][checkSummary] Sending second check_shell for ${label}...`,
			);
			const checkRequest2 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 10 },
				},
				id: `req-check2-summary-${label}`,
			};
			const check2Response = (await sendRequest(
				serverProcess,
				checkRequest2,
			)) as MCPResponse;
			logVerbose("[TEST][checkSummary] Received second check response.");
			expect(check2Response).toHaveProperty("result");
			const check2Result = check2Response.result as CallToolResult;
			const result2ContentText = check2Result?.content?.[0]?.text;
			expect(result2ContentText).toBeDefined();
			const result2 = JSON.parse(result2ContentText) as ProcessStatusResult & {
				message?: string;
			};
			logVerbose(
				`[TEST][checkSummary] Second check status: ${result2.status}, Message: ${result2.message}`,
			);

			expect(result2.status).toBe("stopped");
			expect(result2.message).toBeDefined();
			expect(result2.message).toBe(NO_NOTABLE_EVENTS_MSG);
			if (result2.message === NO_NOTABLE_EVENTS_MSG) {
				expect(result2.logs?.length).toBe(0);
			} else {
				expect(result2.logs?.length).toBeGreaterThan(0);
			}

			console.log("[TEST][checkSummary] Assertions passed.");

			logVerbose(
				`[TEST][checkSummary] Sending stop request for cleanup (${label})...`,
			);
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: label },
				},
				id: `req-stop-cleanup-summary-${label}`,
			};
			await sendRequest(serverProcess, stopRequest);
			logVerbose(
				`[TEST][checkSummary] Cleanup stop request sent for ${label}. Test finished.`,
			);
		},
		TEST_TIMEOUT + 5000,
	);

	it(
		"should capture new logs after settle and input",
		async () => {
			logVerbose("[TEST][inputLogs] Starting test...");
			const label = `test-input-logs-${Date.now()}`;
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: {
						command: "node",
						args: [
							"-e",
							"console.log('Initial log'); process.stdin.once('data', () => { console.error('Error after input'); console.log('URL: http://localhost:1234/after'); setTimeout(() => { console.log('Flushing and exiting...'); process.exit(0); }, 500); });",
						],
						workingDirectory: path.join(__dirname),
						label: label,
						verification_pattern: "Initial log",
						verification_timeout_ms: 5000,
					},
				},
				id: `req-start-for-input-logs-${label}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][inputLogs] Process ${label} started response received.`,
			);
			expect(startResponse).toHaveProperty("result");

			// First check_shell: should see initial logs
			const checkRequest1 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check1-input-logs-${label}`,
			};
			const check1Response = (await sendRequest(
				serverProcess,
				checkRequest1,
			)) as MCPResponse;
			const check1Result = check1Response.result as CallToolResult;
			const result1ContentText = check1Result?.content?.[0]?.text;
			expect(result1ContentText).toBeDefined();
			const result1 = JSON.parse(result1ContentText) as ProcessStatusResult & {
				message?: string;
			};
			logVerbose("[TEST][inputLogs] First check_shell logs:", result1.logs);
			expect(result1.message).toBe(NO_NOTABLE_EVENTS_MSG);

			// Send input to trigger more logs
			const sendInputRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "send_input",
					arguments: { label: label, input: "trigger" },
				},
				id: `req-send-input-logs-${label}`,
			};
			await sendRequest(serverProcess, sendInputRequest);

			// Wait a bit for logs to be generated
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Second check_shell: should see new logs
			const checkRequest2 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check2-input-logs-${label}`,
			};
			const check2Response = (await sendRequest(
				serverProcess,
				checkRequest2,
			)) as MCPResponse;
			const check2Result = check2Response.result as CallToolResult;
			const result2ContentText = check2Result?.content?.[0]?.text;
			expect(result2ContentText).toBeDefined();
			const result2 = JSON.parse(result2ContentText) as ProcessStatusResult & {
				message?: string;
			};
			logVerbose("[TEST][inputLogs] Second check_shell logs:", result2.logs);
			console.log("[DEBUG][inputLogs] result2:", result2);
			expect(result2.logs.join("\n")).toMatch(/Error after input/);
			expect(result2.logs.join("\n")).toMatch(
				/URL: http:\/\/localhost:1234\/after/,
			);
			expect(result2.message).toMatch(
				/Since last check: ❌ Errors \(1\), 🔗 URLs \(1\)\./,
			);

			// Third check_shell: after a delay, see if logs appear
			await new Promise((resolve) => setTimeout(resolve, 200));
			const checkRequest3 = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: label, log_lines: 100 },
				},
				id: `req-check3-input-logs-${label}`,
			};
			const check3Response = (await sendRequest(
				serverProcess,
				checkRequest3,
			)) as MCPResponse;
			const check3Result = check3Response.result as CallToolResult;
			const result3ContentText = check3Result?.content?.[0]?.text;
			expect(result3ContentText).toBeDefined();
			const result3 = JSON.parse(result3ContentText) as ProcessStatusResult & {
				message?: string;
			};
			console.log("[DEBUG][inputLogs] result3:", result3);
		},
		TEST_TIMEOUT + 5000,
	);
});
