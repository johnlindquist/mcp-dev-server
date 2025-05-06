import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_NOTABLE_EVENTS_MSG } from "../../src/constants/messages.js";
import {
	type CallToolResult,
	type MCPResponse,
	SERVER_ARGS,
	SERVER_EXECUTABLE,
	SERVER_READY_OUTPUT,
	SERVER_SCRIPT_PATH,
	STARTUP_TIMEOUT,
	TEST_TIMEOUT,
	sendRequest,
} from "./test-helpers";

describe("Process: Purged Process Status", () => {
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
		"should return stopped status and empty logs for a purged process",
		async () => {
			const uniqueLabel = `test-purged-${Date.now()}`;
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
				id: `req-start-purged-${uniqueLabel}`,
			};
			await sendRequest(serverProcess, startRequest);
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Stop the process
			const stopRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "stop_shell",
					arguments: { label: uniqueLabel },
				},
				id: `req-stop-purged-${uniqueLabel}`,
			};
			await sendRequest(serverProcess, stopRequest);
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Check process status after purge
			const checkRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "check_shell",
					arguments: { label: uniqueLabel, log_lines: 100 },
				},
				id: `req-check-purged-${uniqueLabel}`,
			};
			const response = (await sendRequest(
				serverProcess,
				checkRequest,
			)) as MCPResponse;
			const result = response.result as CallToolResult;
			const resultContentText = result?.content?.[0]?.text;
			expect(resultContentText).toBeDefined();
			const statusResult = JSON.parse(resultContentText);
			expect(statusResult.status).toBe("stopped");
			expect(statusResult.message).toBe(NO_NOTABLE_EVENTS_MSG);
			expect(Array.isArray(statusResult.logs)).toBe(true);
			expect(statusResult.logs.length).toBe(0);
		},
		TEST_TIMEOUT,
	);
});
