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
	sendRequest,
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
				expect(parsedContent.server_name).toBe("mcp-shell-yeah");
				expect(parsedContent.server_version).toBeDefined();
				expect(parsedContent.active_shells).toBe(0);
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
