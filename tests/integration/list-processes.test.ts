import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CallToolResult,
	type ProcessStatusResult,
	SERVER_ARGS,
	SERVER_EXECUTABLE,
	SERVER_READY_OUTPUT,
	SERVER_SCRIPT_PATH,
	STARTUP_TIMEOUT,
	TEST_TIMEOUT,
	logVerbose,
} from "./test-helpers";

async function sendRequest(
	process: ChildProcessWithoutNullStreams,
	request: Record<string, unknown>,
	timeoutMs = 15000,
) {
	const requestId = request.id as string;
	if (!requestId) throw new Error('Request must have an "id" property');
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
				`[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk.substring(0, 200)}${rawChunk.length > 200 ? "..." : ""}`,
			);
			responseBuffer += rawChunk;
			let newlineIndex: number;
			while (true) {
				newlineIndex = responseBuffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = responseBuffer.substring(0, newlineIndex).trim();
				responseBuffer = responseBuffer.substring(newlineIndex + 1);
				if (line === "") continue;
				logVerbose(
					`[sendRequest] Processing line for ${requestId}: ${line.substring(0, 200)}${line.length > 200 ? "..." : ""}`,
				);
				try {
					const parsedResponse = JSON.parse(line);
					if (parsedResponse.id === requestId) {
						logVerbose(
							`[sendRequest] Received matching response for ID ${requestId}: ${line.trim()}`,
						);
						logVerbose(
							`[sendRequest] Full MATCHING response object for ${requestId}:`,
							JSON.stringify(parsedResponse),
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
					logVerbose(
						`[sendRequest] Failed to parse potential JSON line for ${requestId}: ${line}`,
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
			if (
				responseListenersAttached &&
				process &&
				process.stdout &&
				!process.stdout.destroyed
			) {
				process.stdout.removeListener("data", onData);
			}
			if (
				responseListenersAttached &&
				process &&
				process.stderr &&
				!process.stderr.destroyed
			) {
				process.stderr.removeListener("data", logStderr);
			}
			if (responseListenersAttached && process && !process.killed) {
				process.removeListener("error", onError);
				process.removeListener("exit", onExit);
			}
			responseListenersAttached = false;
		};
		const logStderr = (data: Buffer) => {
			logVerbose(
				`[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
			);
		};
		if (process?.stdout && process?.stderr) {
			logVerbose(
				`[sendRequest] Attaching listeners for request ID ${requestId}`,
			);
			process.stdout.on("data", onData);
			process.stderr.on("data", logStderr);
			process.once("error", onError);
			process.once("exit", onExit);
			responseListenersAttached = true;
		} else {
			reject(
				new Error(
					`Server process or stdio streams are not available for request ID ${requestId}`,
				),
			);
			return;
		}
		logVerbose(`[sendRequest] Writing request (ID ${requestId}) to stdin...`);
		if (process?.stdin?.writable) {
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
			cleanup();
			reject(new Error(errorMsg));
		}
	});
}

describe("Tool: list_processes", () => {
	let serverProcess: ChildProcessWithoutNullStreams;

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
				id: "req-list-empty-2",
			};
			logVerbose("[TEST][listEmpty] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as import("./test-helpers").MCPResponse;
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
			expect(result?.content?.[0]?.text).toBeDefined();
			let listResult: ProcessStatusResult[] | null = null;
			try {
				listResult = JSON.parse(result.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse list_processes result content: ${e}`);
			}
			expect(listResult).toBeInstanceOf(Array);
			expect(listResult?.length).toBe(0);
			console.log("[TEST][listEmpty] Assertions passed. Test finished.");
		},
		TEST_TIMEOUT,
	);

	it(
		"should purge stopped processes from the process list",
		async () => {
			logVerbose("[TEST][purgeStopped] Starting test...");
			const uniqueLabel = `test-purge-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Process for purge test'); setTimeout(() => {}, 1000);",
			];
			const workingDirectory = __dirname;

			// Start the process
			const startRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "start_process",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: `req-start-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending start_process request...");
			await sendRequest(serverProcess, startRequest);
			logVerbose("[TEST][purgeStopped] Process started.");

			// Wait briefly to ensure process is running
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Stop the process
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_process",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending stop_process request...");
			await sendRequest(serverProcess, stopRequest);
			logVerbose("[TEST][purgeStopped] Process stopped.");

			// Wait briefly to allow process manager to update
			await new Promise((resolve) => setTimeout(resolve, 500));

			// List processes and ensure the stopped process is not present
			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_processes",
					arguments: { log_lines: 0 },
				},
				id: `req-list-after-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending list_processes request...");
			const response = (await sendRequest(
				serverProcess,
				listRequest,
			)) as import("./test-helpers").MCPResponse;
			logVerbose(
				"[TEST][purgeStopped] Received response:",
				JSON.stringify(response),
			);
			const result = response.result as import("./test-helpers").CallToolResult;
			let listResult: import("./test-helpers").ProcessStatusResult[] | null =
				null;
			try {
				listResult = JSON.parse(result.content[0].text);
			} catch (e) {
				throw new Error(`Failed to parse list_processes result content: ${e}`);
			}
			const found = listResult.find((p) => p.label === uniqueLabel);
			expect(found).toBeUndefined();
			console.log("[TEST][purgeStopped] Assertions passed. Test finished.");
		},
		TEST_TIMEOUT,
	);
});
