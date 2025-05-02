import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
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

describe("Process Management: Memory and Resource Leak Checks", () => {
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
		"should not leak memory or processes after starting and stopping many processes",
		async () => {
			const NUM_PROCESSES = 50;
			const processLabels: string[] = [];
			const initialMemory = process.memoryUsage().rss;

			// Start and stop many processes in sequence
			for (let i = 0; i < NUM_PROCESSES; i++) {
				const label = `memleak-test-${Date.now()}-${i}`;
				processLabels.push(label);
				const startRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "start_process",
						arguments: {
							command: "node",
							args: ["-e", "setTimeout(() => {}, 100);"],
							workingDirectory: path.join(__dirname),
							label,
						},
					},
					id: `req-start-memleak-${label}`,
				};
				await sendRequest(serverProcess, startRequest);
				await new Promise((resolve) => setTimeout(resolve, 20));
				const stopRequest = {
					jsonrpc: "2.0",
					method: "tools/call",
					params: {
						name: "stop_process",
						arguments: { label },
					},
					id: `req-stop-memleak-${label}`,
				};
				await sendRequest(serverProcess, stopRequest);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			// List processes and ensure all are purged
			const listRequest = {
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "list_processes", arguments: {} },
				id: "req-list-memleak-final",
			};
			const listResponse = (await sendRequest(
				serverProcess,
				listRequest,
			)) as MCPResponse;
			const listResult = listResponse.result as CallToolResult;
			const listContentText = listResult?.content?.[0]?.text;
			expect(listContentText).toBeDefined();
			const processList = JSON.parse(listContentText);
			expect(Array.isArray(processList)).toBe(true);
			expect(processList.length).toBe(0);

			// Check memory usage
			const finalMemory = process.memoryUsage().rss;
			const memoryGrowth = finalMemory - initialMemory;
			// Allow up to 10MB growth for GC jitter, etc.
			expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
		},
		TEST_TIMEOUT * 2,
	);
});
