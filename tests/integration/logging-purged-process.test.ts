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
} from "./test-helpers";

async function sendRequest(
	process: ChildProcessWithoutNullStreams,
	request: Record<string, unknown>,
	timeoutMs = 15000,
) {
	const requestId = request.id as string;
	if (!requestId) throw new Error('Request must have an "id" property');
	const requestString = `${JSON.stringify(request)}\n`;
	return new Promise((resolve, reject) => {
		let responseBuffer = "";
		let responseReceived = false;
		const timeoutTimer = setTimeout(() => {
			if (!responseReceived) {
				cleanup();
				reject(new Error(`Timeout waiting for response ID ${requestId}`));
			}
		}, timeoutMs);
		const onData = (data: Buffer) => {
			responseBuffer += data.toString();
			let newlineIndex: number;
			while (true) {
				newlineIndex = responseBuffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = responseBuffer.substring(0, newlineIndex).trim();
				responseBuffer = responseBuffer.substring(newlineIndex + 1);
				if (line === "") continue;
				try {
					const parsedResponse = JSON.parse(line);
					if (parsedResponse.id === requestId) {
						responseReceived = true;
						cleanup();
						resolve(parsedResponse);
						return;
					}
				} catch {}
			}
		};
		const onError = (err: Error) => {
			if (!responseReceived) {
				cleanup();
				reject(err);
			}
		};
		const onExit = () => {
			if (!responseReceived) {
				cleanup();
				reject(
					new Error(
						`Server exited before response ID ${requestId} was received.`,
					),
				);
			}
		};
		const cleanup = () => {
			clearTimeout(timeoutTimer);
			process.stdout.removeListener("data", onData);
			process.removeListener("error", onError);
			process.removeListener("exit", onExit);
		};
		process.stdout.on("data", onData);
		process.once("error", onError);
		process.once("exit", onExit);
		process.stdin.write(requestString);
	});
}

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
