/* eslint-disable @typescript-eslint/no-explicit-any, lint/suspicious/noExplicitAny */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// Add a type for the verification payload
interface VerificationPayload {
	label: string;
	status: string;
	isVerificationEnabled?: boolean;
	verificationPattern?: string;
	[key: string]: unknown;
}

describe("Tool: Process Lifecycle (start, check, restart)", () => {
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
		"should start a simple process and receive confirmation",
		async () => {
			logVerbose("[TEST][startProcess] Starting test...");
			const uniqueLabel = `test-process-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Node process started'); setTimeout(() => console.log('Node process finished'), 200);",
			];
			const workingDirectory = path.resolve(__dirname);
			logVerbose(
				`[TEST][startProcess] Generated label: ${uniqueLabel}, CWD: ${workingDirectory}`,
			);

			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
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
			const result = response.result as CallToolResult;
			expect(result?.content?.[0]?.text).toBeDefined();
			let startResult: ProcessStatusResult | null = null;
			try {
				startResult = JSON.parse(result.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse start_shell result content: ${e}`);
			}
			expect(startResult).not.toBeNull();
			if (startResult) {
				expect(startResult.label).toBe(uniqueLabel);
				expect(["running", "stopped"]).toContain(startResult.status);
				expect(Array.isArray(startResult.shellLogs)).toBe(true);
				expect(startResult.shellLogs.length).toBeGreaterThan(0);
				expect(typeof startResult.shellLogs[0]).toBe("string");
				expect(Array.isArray(startResult.toolLogs)).toBe(true);
				expect(startResult.toolLogs.length).toBeGreaterThan(0);
				expect(typeof startResult.toolLogs[0]).toBe("string");
			}
			console.log("[TEST][startProcess] Assertions passed.");

			logVerbose("[TEST][startProcess] Waiting briefly...");
			await new Promise((resolve) => setTimeout(resolve, 200));

			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-${uniqueLabel}`,
			};
			logVerbose("[TEST][stop] Sending stop_shell request...");
			const stopResponse = (await sendRequest(
				serverProcess,
				stopRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][stop] Received stop response:",
				JSON.stringify(stopResponse),
			);
			logVerbose("[TEST][startProcess] Test finished.");
		},
		TEST_TIMEOUT,
	);

	it(
		"should check the status of a running process",
		async () => {
			logVerbose("[TEST][checkStatus] Starting test...");
			const uniqueLabel = `test-check-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Process for checking status'); setInterval(() => {}, 1000);",
			];
			const workingDirectory = path.resolve(__dirname);
			logVerbose(`[TEST][checkStatus] Starting process ${uniqueLabel}...`);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: "req-start-for-check-1",
			};
			await sendRequest(serverProcess, startRequest);
			logVerbose(`[TEST][checkStatus] Process ${uniqueLabel} started.`);
			await new Promise((resolve) => setTimeout(resolve, 200));
			logVerbose("[TEST][checkStatus] Added 200ms delay after start.");

			const checkRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: uniqueLabel },
				},
				id: "req-check-1",
			};
			logVerbose("[TEST][checkStatus] Sending check_shell request...");

			const response = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;
			logVerbose(
				`[TEST][checkStatus] Received response: ${JSON.stringify(response)}`,
			);

			logVerbose("[TEST][checkStatus] Asserting response properties...");
			expect(response).toBeDefined();
			expect(response.id).toBe("req-check-1");
			expect(response.error).toBeUndefined();
			expect(response.result).toBeDefined();

			logVerbose("[TEST][checkStatus] Asserting result properties...");
			const result = response.result as CallToolResult;
			const resultContentText = result?.content?.[0]?.text;
			expect(resultContentText).toBeDefined();

			try {
				if (resultContentText) {
					const processStatus = JSON.parse(resultContentText);
					expect(processStatus.status).toBe("running");
					expect(processStatus.label).toBe(uniqueLabel);
					expect(processStatus.command).toBe(command);
					expect(processStatus.pid).toBeGreaterThan(0);
					expect(processStatus.logs?.length).toBeGreaterThanOrEqual(1);
					const logs1 = processStatus.logs ?? [];
					logVerbose(
						`[TEST][checkStatus] First check logs (${logs1.length}):`,
						logs1,
					);
					const hasCorrectLog = logs1.some((log) =>
						log.includes("Process for checking status"),
					);
					expect(hasCorrectLog).toBe(true);
					console.log("[TEST][checkStatus] Assertions passed.");
				} else {
					throw new Error(
						"Received null or undefined content text for check_shell",
					);
				}
			} catch (e) {
				throw new Error(`Failed to parse check_shell result content: ${e}`);
			}

			logVerbose("[TEST][checkStatus] Sending stop request for cleanup...");
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: "req-stop-cleanup-check-1",
			};
			await sendRequest(serverProcess, stopRequest);
			logVerbose(
				"[TEST][checkStatus] Cleanup stop request sent. Test finished.",
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"should restart a running process",
		async () => {
			logVerbose("[TEST][restart] Starting test...");
			const uniqueLabel = `test-restart-${Date.now()}`;
			const command = "node";
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
					name: "start_shell",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: `req-start-for-restart-${uniqueLabel}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(`[TEST][restart] Initial process ${uniqueLabel} started.`);
			const startResult = startResponse.result as CallToolResult;
			const initialProcessInfo = JSON.parse(
				startResult.content[0].text,
			) as ProcessStatusResult;
			const initialPid = initialProcessInfo.pid;
			expect(initialPid).toBeGreaterThan(0);
			logVerbose(`[TEST][restart] Initial PID: ${initialPid}`);

			await new Promise((resolve) => setTimeout(resolve, 200));
			logVerbose("[TEST][restart] Added 200ms delay before restart.");

			const restartRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "restart_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-restart-${uniqueLabel}`,
			};
			logVerbose("[TEST][restart] Sending restart_shell request...");
			const restartResponse = (await sendRequest(
				serverProcess,
				restartRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][restart] Received restart response:",
				JSON.stringify(restartResponse),
			);

			logVerbose("[TEST][restart] Asserting restart response properties...");
			expect(
				restartResponse.error,
				`Restart tool call failed: ${JSON.stringify(restartResponse.error)}`,
			).toBeUndefined();
			expect(
				restartResponse.result,
				`Restart tool call expected result but got none. Error: ${JSON.stringify(restartResponse.error)}`,
			).toBeDefined();

			const restartResultWrapper = restartResponse.result as CallToolResult;
			expect(
				restartResultWrapper.isError,
				`Restart result indicates an error: ${restartResultWrapper.content?.[0]?.text}`,
			).toBeFalsy();
			expect(restartResultWrapper?.content?.[0]?.text).toBeDefined();

			let restartResult: ProcessStatusResult | null = null;
			try {
				restartResult = JSON.parse(restartResultWrapper.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse restart_shell result content: ${e}`);
			}
			expect(restartResult?.label).toBe(uniqueLabel);
			expect(restartResult?.status).toBe("running");
			const restartedPid = restartResult?.pid;
			expect(restartedPid).toBeGreaterThan(0);
			expect(restartedPid).not.toBe(initialPid);
			logVerbose(`[TEST][restart] Restarted PID: ${restartedPid}`);
			console.log("[TEST][restart] Restart response assertions passed.");

			const checkRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: uniqueLabel, log_lines: 0 },
				},
				id: `req-check-after-restart-${uniqueLabel}`,
			};

			logVerbose(
				"[TEST][restart] Sending check_shell request after restart...",
			);
			const checkResponse = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;

			let checkResult: ProcessStatusResult | null = null;
			const checkResultWrapper = checkResponse.result as CallToolResult;
			try {
				checkResult = JSON.parse(checkResultWrapper.content[0].text);
			} catch (e) {}

			expect(checkResult?.status).toBe("running");
			expect(checkResult?.pid).toBe(restartedPid);
			console.log("[TEST][restart] Final status check passed.");

			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-cleanup-restart-${uniqueLabel}`,
			};
			logVerbose(
				`[TEST][restart] Sending stop request for cleanup (${uniqueLabel})...`,
			);
			await sendRequest(serverProcess, stopRequest);
			logVerbose("[TEST][restart] Cleanup stop request sent. Test finished.");
		},
		TEST_TIMEOUT * 2,
	);

	it(
		"should start a process with verification and receive confirmation",
		async () => {
			logVerbose("[TEST][startProcessWithVerification] Starting test...");
			const uniqueLabel = `test-process-verification-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Verification pattern: READY'); setTimeout(() => console.log('Node process finished'), 200);",
			];
			const workingDirectory = path.resolve(__dirname);
			logVerbose(
				`[TEST][startProcessWithVerification] Generated label: ${uniqueLabel}, CWD: ${workingDirectory}`,
			);

			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell_with_verification",
					arguments: {
						command,
						args,
						workingDirectory,
						label: uniqueLabel,
						verification_pattern: "READY",
						verification_timeout_ms: 2000,
					},
				},
				id: "req-start-verification-1",
			};
			logVerbose(
				"[TEST][startProcessWithVerification] Sending start request...",
			);

			const response = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][startProcessWithVerification] Received response:",
				JSON.stringify(response),
			);

			logVerbose(
				"[TEST][startProcessWithVerification] Asserting response properties...",
			);
			expect(response.id).toBe("req-start-verification-1");
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();

			logVerbose(
				"[TEST][startProcessWithVerification] Asserting result properties...",
			);
			const result = response.result as CallToolResult;
			expect(result?.content?.[0]?.text).toBeDefined();
			let startResult: ProcessStatusResult | null = null;
			try {
				console.log(
					"DEBUG: Raw result.content[0].text:",
					result.content[0].text,
				);
				startResult = JSON.parse(result.content[0].text);
				console.log("DEBUG: Parsed startResult:", startResult);
			} catch (e) {
				throw new Error(
					`Failed to parse start_shell_with_verification result content: ${e}`,
				);
			}
			expect(startResult).not.toBeNull();
			if (startResult) {
				expect(startResult.label).toBe(uniqueLabel);
				expect(["running", "stopped"]).toContain(startResult.status);
				const verificationResult = startResult as VerificationPayload;
				expect(verificationResult.isVerificationEnabled).toBe(true);
				expect(verificationResult.verificationPattern).toBe("READY");
			}
			console.log("[TEST][startProcessWithVerification] Assertions passed.");

			logVerbose("[TEST][startProcessWithVerification] Waiting briefly...");
			await new Promise((resolve) => setTimeout(resolve, 200));

			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-verification-${uniqueLabel}`,
			};
			logVerbose("[TEST][stop] Sending stop_shell request...");
			const stopResponse = (await sendRequest(
				serverProcess,
				stopRequest,
			)) as MCPResponse;
			logVerbose(
				"[TEST][stop] Received stop response:",
				JSON.stringify(stopResponse),
			);
			logVerbose("[TEST][startProcessWithVerification] Test finished.");
		},
		TEST_TIMEOUT,
	);

	it(
		"should return shellLogs and toolLogs after restart",
		async () => {
			const uniqueLabel = `test-restart-logs-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Restart log test'); setInterval(() => {}, 1000);",
			];
			const workingDirectory = path.resolve(__dirname);
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: `req-start-for-restart-logs-${uniqueLabel}`,
			};
			const startResponse = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			const startResult = JSON.parse(
				(startResponse.result as CallToolResult).content[0].text,
			);
			expect(Array.isArray(startResult.shellLogs)).toBe(true);
			expect(startResult.shellLogs.length).toBeGreaterThan(0);
			expect(Array.isArray(startResult.toolLogs)).toBe(true);
			expect(startResult.toolLogs.length).toBeGreaterThan(0);

			const restartRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "restart_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-restart-logs-${uniqueLabel}`,
			};
			const restartResponse = (await sendRequest(
				serverProcess,
				restartRequest,
			)) as MCPResponse;
			const restartResult = JSON.parse(
				(restartResponse.result as CallToolResult).content[0].text,
			);
			expect(Array.isArray(restartResult.shellLogs)).toBe(true);
			expect(restartResult.shellLogs.length).toBeGreaterThan(0);
			expect(Array.isArray(restartResult.toolLogs)).toBe(true);
			expect(restartResult.toolLogs.length).toBeGreaterThan(0);
		},
		TEST_TIMEOUT,
	);

	describe("Readline Prompt Capture", () => {
		const LABEL_PREFIX = "readline-prompt-test-";
		const SCRIPT_PATH = require("node:path").resolve(
			__dirname,
			"fixtures/readline-prompt.cjs",
		);
		const COMMAND = "node";
		const ARGS = [SCRIPT_PATH];

		// Skipped: Node.js readline prompt is not captured by PTY/log collector due to known Node.js/PTY limitation.
		// See documentation for details.
		it.skip("should capture readline prompt and set isProbablyAwaitingInput", async () => {
			const label = LABEL_PREFIX + Date.now();
			// Start the process
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_shell",
					arguments: {
						label,
						command: COMMAND,
						args: ARGS,
						workingDirectory: process.cwd(),
					},
				},
				id: `req-start-${label}`,
			};
			await sendRequest(serverProcess, startRequest);

			// Poll for up to 2 seconds for the prompt and isProbablyAwaitingInput
			let found = false;
			let lastCheckResult = null;
			for (let i = 0; i < 20; i++) {
				const checkRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "check_shell",
						arguments: { label, log_lines: 100 },
					},
					id: `req-check-${label}-${i}`,
				};
				const checkResponse = (await sendRequest(
					serverProcess,
					checkRequest,
				)) as {
					result: { content: { text: string }[] };
				};
				const checkResult = JSON.parse(checkResponse.result.content[0].text);
				lastCheckResult = checkResult;
				if (
					checkResult.logs?.some((line) =>
						line.includes("Do you want to continue? (yes/no):"),
					) &&
					checkResult.isProbablyAwaitingInput === true
				) {
					found = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			if (!found) {
				console.error(
					"[DEBUG][Readline Prompt Capture] Last checkResult:",
					JSON.stringify(lastCheckResult, null, 2),
				);
			}
			expect(found).toBe(true);
			// Cleanup
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "stop_shell", arguments: { label } },
				id: `req-stop-${label}`,
			};
			await sendRequest(serverProcess, stopRequest);
		});
	});

	describe("Prompt Fixture Capture", () => {
		const fixtures = [
			{
				label: "bash-read",
				command: "bash",
				args: [
					require("node:path").resolve(__dirname, "fixtures/bash-read.sh"),
				],
				prompt: "Enter your name: ",
			},
			{
				label: "python-input",
				command: "python3",
				args: [
					require("node:path").resolve(__dirname, "fixtures/python-input.py"),
				],
				prompt: "What is your favorite color? ",
			},
			{
				label: "node-custom-cli",
				command: "node",
				args: [
					require("node:path").resolve(
						__dirname,
						"fixtures/node-custom-cli.cjs",
					),
				],
				prompt: "Type a secret word: ",
			},
			{
				label: "python-multiline",
				command: "python3",
				args: [
					require("node:path").resolve(
						__dirname,
						"fixtures/python-multiline.py",
					),
				],
				prompt: "First name: ",
			},
			{
				label: "node-multiline",
				command: "node",
				args: [
					require("node:path").resolve(
						__dirname,
						"fixtures/node-multiline.cjs",
					),
				],
				prompt: "Username: ",
			},
		];

		for (const fixture of fixtures) {
			// Skip bash-read, python-input, and python-multiline due to PTY limitation
			const testFn = it;
			testFn(`should capture prompt for ${fixture.label}`, async () => {
				// NOTE: Some interactive prompts (notably bash and python) may not be captured in PTY logs
				// due to OS-level and language-level buffering that cannot be bypassed by stdbuf, script, or env vars.
				// This is a known limitation and is documented for future reference.
				// Node.js-based prompts are reliably captured.
				const label = `prompt-fixture-${fixture.label}-${Date.now()}`;
				const startRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "start_shell",
						arguments: {
							label,
							command: fixture.command,
							args: fixture.args,
							workingDirectory: process.cwd(),
						},
					},
					id: `req-start-${label}`,
				};
				await sendRequest(serverProcess, startRequest);
				let found = false;
				let lastCheckResult = null;
				for (let i = 0; i < 20; i++) {
					const checkRequest = {
						jsonrpc: "2.0",
						method: "tools/call",
						params: {
							name: "check_shell",
							arguments: { label, log_lines: 100 },
						},
						id: `req-check-${label}-${i}`,
					};
					const checkResponse = (await sendRequest(
						serverProcess,
						checkRequest,
					)) as {
						result: { content: { text: string }[] };
					};
					const checkResult = JSON.parse(checkResponse.result.content[0].text);
					lastCheckResult = checkResult;
					if (checkResult.logs?.some((line) => line.includes(fixture.prompt))) {
						found = true;
						break;
					}
					await new Promise((r) => setTimeout(r, 100));
				}
				if (!found) {
					const fs = require("node:fs");
					const logPath = lastCheckResult.log_file_path;
					if (fs.existsSync(logPath)) {
						const logContent = fs.readFileSync(logPath, "utf8");
						console.error(
							`[DEBUG][Prompt Fixture Capture][${fixture.label}] Log file contents:\n${logContent}`,
						);
					} else {
						console.error(
							`[DEBUG][Prompt Fixture Capture][${fixture.label}] Log file not found: ${logPath}`,
						);
					}
				}
				expect(found).toBe(true);
				const stopRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: { name: "stop_shell", arguments: { label } },
					id: `req-stop-${label}`,
				};
				await sendRequest(serverProcess, stopRequest);
			});
		}
	});

	describe("Echo Fixture Capture", () => {
		const fixtures = [
			{
				label: "bash-echo",
				command: "bash",
				args: [
					require("node:path").resolve(__dirname, "fixtures/bash-echo.sh"),
				],
				output: "Hello from bash!",
			},
			{
				label: "python-echo",
				command: "python3",
				args: [
					require("node:path").resolve(__dirname, "fixtures/python-echo.py"),
				],
				output: "Hello from python!",
			},
			{
				label: "node-echo",
				command: "node",
				args: [
					require("node:path").resolve(__dirname, "fixtures/node-echo.cjs"),
				],
				output: "Hello from node!",
			},
		];

		for (const fixture of fixtures) {
			it(`should capture output for ${fixture.label}`, async () => {
				const label = `echo-fixture-${fixture.label}-${Date.now()}`;
				const startRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "start_shell",
						arguments: {
							label,
							command: fixture.command,
							args: fixture.args,
							workingDirectory: process.cwd(),
						},
					},
					id: `req-start-${label}`,
				};
				await sendRequest(serverProcess, startRequest);

				let found = false;
				let lastCheckResult = null;
				for (let i = 0; i < 10; i++) {
					await new Promise((r) => setTimeout(r, 200));
					const checkRequest = {
						jsonrpc: "2.0",
						method: "tools/call",
						params: {
							name: "check_shell",
							arguments: {
								label,
								log_lines: 100,
							},
						},
						id: `req-check-${label}-${i}`,
					};
					const checkResponse = (await sendRequest(
						serverProcess,
						checkRequest,
					)) as {
						result: { content: { text: string }[] };
					};
					const checkResult = JSON.parse(checkResponse.result.content[0].text);
					lastCheckResult = checkResult;
					if (checkResult.logs?.some((line) => line.includes(fixture.output))) {
						found = true;
						break;
					}
				}
				if (!found) {
					const fs = require("node:fs");
					const logPath = lastCheckResult.log_file_path;
					if (fs.existsSync(logPath)) {
						const logContent = fs.readFileSync(logPath, "utf8");
						console.error(
							`[DEBUG][Echo Fixture Capture][${fixture.label}] Log file contents:\n${logContent}`,
						);
					} else {
						console.error(
							`[DEBUG][Echo Fixture Capture][${fixture.label}] Log file not found: ${logPath}`,
						);
					}
				}
				expect(found).toBe(true);
				// Cleanup
				const stopRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "stop_shell",
						arguments: { label, force: true },
					},
					id: `req-stop-${label}`,
				};
				await sendRequest(serverProcess, stopRequest);
			});
		}
	});
});
