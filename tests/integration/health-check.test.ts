import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CallToolResult,
	type MCPResponse,
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

describe("Tool: health_check", () => {
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
			serverProcess.stdout.on("data", (data: Buffer) => {
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
				process.stdout.on("data", logStderr);
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
		"should respond successfully to health_check",
		async () => {
			logVerbose("[TEST][healthCheck] Starting test...");
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
			const result = response.result as CallToolResult;
			expect(result?.content?.[0]?.text).toBeDefined();

			try {
				const parsedContent = JSON.parse(result.content[0].text);
				expect(parsedContent.status).toBe("ok");
				expect(parsedContent.server_name).toBe("mcp-pm");
				expect(parsedContent.server_version).toBeDefined();
				expect(parsedContent.active_shelles).toBe(0);
				expect(parsedContent.is_zombie_check_active).toBe(false);
				console.log("[TEST][healthCheck] Assertions passed.");
				logVerbose("[TEST][healthCheck] Test finished.");
			} catch (e) {
				throw new Error(`Failed to parse health_check result content: ${e}`);
			}
		},
		TEST_TIMEOUT,
	);
});
