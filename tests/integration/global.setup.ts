import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import {
	SERVER_ARGS,
	SERVER_EXECUTABLE,
	SERVER_READY_OUTPUT,
	SERVER_SCRIPT_PATH,
	STARTUP_TIMEOUT,
	logVerbose,
	logVerboseError,
} from "./test-helpers";

declare global {
	// eslint-disable-next-line no-var
	var __MCP_TEST_SERVER_PROCESS__: ChildProcessWithoutNullStreams | null;
}

export async function setup() {
	console.log("[GlobalSetup] Starting MCP server for integration tests...");

	let serverProcess: ChildProcessWithoutNullStreams | null = null;
	const serverErrorOutput: string[] = [];
	let serverWasKilled = false;

	const serverReadyPromise = new Promise<ChildProcessWithoutNullStreams>(
		(resolve, reject) => {
			const rejectTimeout = setTimeout(() => {
				const errMsg = `[GlobalSetup] Server startup timed out after ${STARTUP_TIMEOUT}ms. Stderr: ${serverErrorOutput.join("")}`;
				console.error(errMsg);
				if (serverProcess && !serverProcess.killed) {
					serverProcess.kill("SIGKILL");
				}
				reject(new Error(errMsg));
			}, STARTUP_TIMEOUT);

			logVerbose(
				`[GlobalSetup] Spawning: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(" ")}`,
			);

			serverProcess = spawn(
				SERVER_EXECUTABLE,
				[SERVER_SCRIPT_PATH, ...SERVER_ARGS],
				{
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, MCP_PM_FAST: "1" },
				},
			);
			logVerbose(`[GlobalSetup] Spawned PID: ${serverProcess.pid}`);

			let serverReady = false;

			serverProcess.stdout.on("data", (data: Buffer) => {
				logVerbose(`[GlobalSetup][Server STDOUT]: ${data.toString().trim()}`);
			});

			serverProcess.stderr.on("data", (data: Buffer) => {
				const output = data.toString();
				serverErrorOutput.push(output);
				logVerboseError(`[GlobalSetup][Server STDERR]: ${output.trim()}`);
				if (!serverReady && output.includes(SERVER_READY_OUTPUT)) {
					logVerbose("[GlobalSetup] Server ready signal detected.");
					serverReady = true;
					clearTimeout(rejectTimeout);
					resolve(serverProcess as ChildProcessWithoutNullStreams);
				}
			});

			serverProcess.on("error", (err) => {
				console.error("[GlobalSetup] Failed to start server process:", err);
				clearTimeout(rejectTimeout);
				reject(err);
			});

			serverProcess.on("exit", (code, signal) => {
				logVerbose(
					`[GlobalSetup] Server process exited unexpectedly during setup. Code: ${code}, Signal: ${signal}`,
				);
				if (!serverReady) {
					clearTimeout(rejectTimeout);
					const errMsg = `[GlobalSetup] Server process exited prematurely (code ${code}, signal ${signal}) before ready signal. Stderr: ${serverErrorOutput.join("")}`;
					console.error(errMsg);
					reject(new Error(errMsg));
				} else if (!serverWasKilled) {
					console.warn(
						`[GlobalSetup] Server process exited unexpectedly AFTER setup completed (code ${code}, signal ${signal}). Tests might fail.`,
					);
				}
				if (globalThis.__MCP_TEST_SERVER_PROCESS__ === serverProcess) {
					globalThis.__MCP_TEST_SERVER_PROCESS__ = null;
				}
			});
		},
	);

	try {
		const readyProcess = await serverReadyPromise;
		console.log(`[GlobalSetup] Server ready (PID: ${readyProcess.pid}).`);
		globalThis.__MCP_TEST_SERVER_PROCESS__ = readyProcess;
	} catch (error) {
		console.error("[GlobalSetup] Failed to start server:", error);
		if (serverProcess && !serverProcess.killed) {
			serverProcess.kill("SIGKILL");
		}
		throw error;
	}

	return async () => {
		console.log("[GlobalTeardown] Tearing down MCP server...");
		const currentProcess = globalThis.__MCP_TEST_SERVER_PROCESS__;
		if (currentProcess && !currentProcess.killed) {
			serverWasKilled = true;
			logVerbose("[GlobalTeardown] Closing stdin and sending SIGTERM...");
			currentProcess.stdin.end();
			const killed = currentProcess.kill("SIGTERM");
			if (killed) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				if (!currentProcess.killed) {
					logVerbose("[GlobalTeardown] SIGTERM failed, sending SIGKILL.");
					currentProcess.kill("SIGKILL");
				} else {
					logVerbose("[GlobalTeardown] Server terminated gracefully.");
				}
			} else {
				logVerbose("[GlobalTeardown] Failed to send SIGTERM, sending SIGKILL.");
				currentProcess.kill("SIGKILL");
			}
		} else {
			logVerbose(
				"[GlobalTeardown] Server process already terminated or not started.",
			);
		}
		globalThis.__MCP_TEST_SERVER_PROCESS__ = null;
		console.log("[GlobalTeardown] Teardown complete.");
	};
}
