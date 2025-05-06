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
	sendRequest,
} from "./test-helpers";

describe("Tool: list_shells", () => {
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

	it(
		"should list zero processes initially",
		async () => {
			logVerbose("[TEST][listEmpty] Starting test...");
			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_shells",
					arguments: { log_lines: 0 },
				},
				id: "req-list-empty-2",
			};
			logVerbose("[TEST][listEmpty] Sending list_shells request...");
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
				throw new Error(`Failed to parse list_shells result content: ${e}`);
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
					name: "start_shell",
					arguments: { command, args, workingDirectory, label: uniqueLabel },
				},
				id: `req-start-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending start_shell request...");
			await sendRequest(serverProcess, startRequest);
			logVerbose("[TEST][purgeStopped] Process started.");

			// Wait briefly to ensure process is running
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Stop the process
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending stop_shell request...");
			await sendRequest(serverProcess, stopRequest);
			logVerbose("[TEST][purgeStopped] Process stopped.");

			// Wait briefly to allow process manager to update
			await new Promise((resolve) => setTimeout(resolve, 200));

			// List processes and ensure the stopped process is not present
			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "list_shells",
					arguments: { log_lines: 0 },
				},
				id: `req-list-after-purge-${uniqueLabel}`,
			};
			logVerbose("[TEST][purgeStopped] Sending list_shells request...");
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
				throw new Error(`Failed to parse list_shells result content: ${e}`);
			}
			const found = listResult.find((p) => p.label === uniqueLabel);
			expect(found).toBeUndefined();
			console.log("[TEST][purgeStopped] Assertions passed. Test finished.");
		},
		TEST_TIMEOUT,
	);
});
