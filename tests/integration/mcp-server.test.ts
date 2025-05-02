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

describe("MCP Process Manager Server (Stdio Integration)", () => {
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
		"should list one running process after starting it",
		async () => {
			logVerbose("[TEST][listOne] Starting test...");
			const uniqueLabel = `test-list-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Process for listing test'); setInterval(() => {}, 1000);",
			];
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

			await sendRequest(serverProcess, startRequest);
			logVerbose(`[TEST][listOne] Process ${uniqueLabel} started.`);

			await new Promise((resolve) => setTimeout(resolve, 500));
			logVerbose("[TEST][listOne] Added 500ms delay after start.");

			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_processes",
					arguments: { log_lines: 5 },
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

			const result = response.result as CallToolResult;
			expect(result?.payload?.[0]?.content).toBeDefined();

			let listResult: ProcessStatusResult[] | null = null;
			try {
				listResult = JSON.parse(result.payload[0].content);
			} catch (e) {
				throw new Error(`Failed to parse list_processes result payload: ${e}`);
			}

			expect(listResult).toBeInstanceOf(Array);

			expect(listResult?.length).toBeGreaterThanOrEqual(1);

			const processInfo = listResult?.find((p) => p.label === uniqueLabel);
			expect(
				processInfo,
				`Process with label ${uniqueLabel} not found in list`,
			).toBeDefined();

			expect(processInfo?.label).toBe(uniqueLabel);
			expect(processInfo?.status).toBe("running");
			expect(processInfo?.command).toBe(command);
			expect(processInfo?.pid).toBeGreaterThan(0);
			expect(processInfo?.logs?.length).toBeGreaterThanOrEqual(1);
			console.log("[TEST][listOne] Assertions passed.");

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
		},
		TEST_TIMEOUT,
	);
});
