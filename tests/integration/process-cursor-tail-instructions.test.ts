import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

let serverProcess: ChildProcessWithoutNullStreams;

// Setup/teardown copied from process-lifecycle.test.ts
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
	return new Promise((resolve, reject) => {
		let responseBuffer = "";
		let responseReceived = false;
		let responseListenersAttached = false;
		const timeoutTimer = setTimeout(() => {
			if (!responseReceived) {
				cleanup();
				reject(
					new Error(
						`Timeout waiting for response ID ${requestId} after ${timeoutMs}ms.`,
					),
				);
			}
		}, timeoutMs);
		const onData = (data: Buffer) => {
			responseBuffer += data.toString();
			const lines = responseBuffer.split("\n");
			responseBuffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim() === "") continue;
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
				reject(
					new Error(
						`Server process emitted error while waiting for ID ${requestId}: ${err.message}`,
					),
				);
			}
		};
		const onExit = (code: number | null, signal: string | null) => {
			if (!responseReceived) {
				cleanup();
				reject(
					new Error(
						`Server process exited (code ${code}, signal ${signal}) before response ID ${requestId} was received.`,
					),
				);
			}
		};
		const cleanup = () => {
			clearTimeout(timeoutTimer);
			if (responseListenersAttached) {
				process.stdout.removeListener("data", onData);
				process.removeListener("error", onError);
				process.removeListener("exit", onExit);
				responseListenersAttached = false;
			}
		};
		if (!responseListenersAttached) {
			process.stdout.on("data", onData);
			process.once("error", onError);
			process.once("exit", onExit);
			responseListenersAttached = true;
		}
		process.stdin.write(requestString, (err) => {
			if (err && !responseReceived) {
				cleanup();
				reject(
					new Error(
						`Failed to write to server stdin for ID ${requestId}: ${err.message}`,
					),
				);
			}
		});
	});
}

describe("Process: Cursor Tail Instructions", () => {
	it(
		"should start a process with host 'cursor' and include tail instruction message",
		async () => {
			const uniqueLabel = `test-cursor-host-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Cursor host process started'); setTimeout(() => console.log('done'), 100);",
			];
			const workingDirectory = path.resolve(__dirname);
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
						host: "cursor",
					},
				},
				id: `req-cursor-host-${uniqueLabel}`,
			};
			const response = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			const result = response.result as CallToolResult;
			expect(result.content.length).toBe(1);
			const mainPayload = result.content[0].text;
			expect(mainPayload).toMatch(/tail_command/);
			await sendRequest(serverProcess, {
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "stop_shell", arguments: { label: uniqueLabel } },
				id: `req-stop-cursor-${uniqueLabel}`,
			});
		},
		TEST_TIMEOUT,
	);

	it(
		"should start a process with host 'unknown' and NOT include tail instruction message",
		async () => {
			const uniqueLabel = `test-unknown-host-${Date.now()}`;
			const command = "node";
			const args = [
				"-e",
				"console.log('Unknown host process started'); setTimeout(() => console.log('done'), 100);",
			];
			const workingDirectory = path.resolve(__dirname);
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
						host: "unknown",
					},
				},
				id: `req-unknown-host-${uniqueLabel}`,
			};
			const response = (await sendRequest(
				serverProcess,
				startRequest,
			)) as MCPResponse;
			expect(
				response.result,
				`Expected result to be defined, error: ${JSON.stringify(response.error)}`,
			).toBeDefined();
			expect(
				response.error,
				`Expected error to be undefined, got: ${JSON.stringify(response.error)}`,
			).toBeUndefined();
			const result = response.result as CallToolResult;
			expect(result.content.length).toBe(1);
			const mainPayload = result.content[0].text;
			const parsed = JSON.parse(mainPayload);
			expect(parsed.label).toBe(uniqueLabel);
			expect(["running", "stopped"]).toContain(parsed.status);
			await sendRequest(serverProcess, {
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "stop_shell", arguments: { label: uniqueLabel } },
				id: `req-stop-unknown-${uniqueLabel}`,
			});
		},
		TEST_TIMEOUT,
	);
});
