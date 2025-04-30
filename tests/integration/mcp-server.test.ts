import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// --- Configuration ---
const SERVER_EXECUTABLE = "node";
// Resolve path from 'tests/integration/' to 'build/index.mjs'
const SERVER_SCRIPT_PATH = path.resolve(__dirname, "../../build/index.mjs");
const SERVER_ARGS: string[] = []; // No specific args needed to start
// From src/main.ts log output
const SERVER_READY_OUTPUT = "MCP Server connected and listening via stdio.";
const STARTUP_TIMEOUT = 20000; // 20 seconds (adjust as needed)
const TEST_TIMEOUT = STARTUP_TIMEOUT + 5000; // Test timeout slightly longer than startup

describe("MCP Process Manager Server (Stdio Integration)", () => {
	let serverProcess: ChildProcessWithoutNullStreams | null = null;
	let serverReadyPromise: Promise<void>;
	let resolveServerReady: () => void;
	let rejectServerReady: (reason?: Error | string | undefined) => void;
	let serverErrorOutput: string[] = []; // Store stderr output
	let serverStdoutOutput: string[] = []; // Store stdout output (mostly for debugging)
	let serverExitCode: number | null = null;
	let serverWasKilled = false; // Flag to check if we killed it intentionally

	beforeAll(async () => {
		// Reset state for potentially retried tests
		serverProcess = null;
		serverErrorOutput = [];
		serverStdoutOutput = [];
		serverExitCode = null;
		serverWasKilled = false;

		// Setup the promise *before* spawning
		serverReadyPromise = new Promise((resolve, reject) => {
			resolveServerReady = resolve;
			rejectServerReady = reject;
		});

		console.log(
			`Spawning MCP server: ${SERVER_EXECUTABLE} ${SERVER_SCRIPT_PATH} ${SERVER_ARGS.join(" ")}`,
		);
		serverProcess = spawn(
			SERVER_EXECUTABLE,
			[SERVER_SCRIPT_PATH, ...SERVER_ARGS],
			{
				stdio: ["pipe", "pipe", "pipe"], // pipe stdin, stdout, stderr
				env: { ...process.env }, // Pass environment variables
				// cwd: path.dirname(SERVER_SCRIPT_PATH), // Usually not needed if script path is absolute
			},
		);

		let serverReady = false; // Flag to prevent double resolution

		const startupTimeoutTimer = setTimeout(() => {
			if (!serverReady) {
				const err = new Error(
					`Server startup timed out after ${STARTUP_TIMEOUT}ms. Stderr: ${serverErrorOutput.join("")}`,
				);
				console.error(err.message);
				serverWasKilled = true;
				serverProcess?.kill("SIGKILL"); // Force kill on timeout
				rejectServerReady(err);
			}
		}, STARTUP_TIMEOUT);

		serverProcess.stdout.on("data", (data: Buffer) => {
			const output = data.toString();
			serverStdoutOutput.push(output); // Store for debugging
			// NOTE: MCP responses go to stdout, but the *ready* signal for mcp-pm goes to stderr
			// console.log(`[Server STDOUT]: ${output.trim()}`);
		});

		serverProcess.stderr.on("data", (data: Buffer) => {
			const output = data.toString();
			serverErrorOutput.push(output); // Store for debugging/errors
			console.error(`[Server STDERR]: ${output.trim()}`); // Log stderr for visibility

			// Check for the ready signal in stderr
			if (!serverReady && output.includes(SERVER_READY_OUTPUT)) {
				console.log("MCP server ready signal detected.");
				serverReady = true;
				clearTimeout(startupTimeoutTimer);
				resolveServerReady();
			}
			// Optional: Check for specific fatal startup errors here if known
			// if (output.includes("FATAL ERROR")) {
			//   clearTimeout(startupTimeoutTimer);
			//   rejectServerReady(new Error(`Server emitted fatal error: ${output}`));
			// }
		});

		serverProcess.on("error", (err) => {
			console.error("Failed to start server process:", err);
			if (!serverReady) {
				clearTimeout(startupTimeoutTimer);
				rejectServerReady(err);
			}
		});

		serverProcess.on("exit", (code, signal) => {
			serverExitCode = code;
			console.log(
				`Server process exited with code: ${code}, signal: ${signal}`,
			);
			if (!serverReady) {
				clearTimeout(startupTimeoutTimer);
				rejectServerReady(
					new Error(
						`Server process exited prematurely (code ${code}, signal ${signal}) before ready signal. Stderr: ${serverErrorOutput.join("")}`,
					),
				);
			}
			// If it exits *after* being ready but *before* we killed it, it might be an issue
			else if (!serverWasKilled) {
				console.warn(
					`Server process exited unexpectedly after being ready (code ${code}, signal ${signal}).`,
				);
				// We might want to fail ongoing tests if this happens, but that's complex.
				// For now, just log it. The tests relying on the process will fail anyway.
			}
		});

		serverProcess.on("close", () => {
			console.log("Server stdio streams closed.");
		});

		try {
			await serverReadyPromise;
			console.log("Server startup successful.");
		} catch (err) {
			console.error("Server startup failed:", err);
			// Ensure process is killed if startup failed partway
			if (serverProcess && !serverProcess.killed) {
				serverWasKilled = true;
				serverProcess.kill("SIGKILL");
			}
			throw err; // Re-throw to fail the test setup
		}
	}, TEST_TIMEOUT); // Vitest timeout for the hook

	afterAll(async () => {
		if (serverProcess && !serverProcess.killed) {
			console.log("Terminating server process...");
			serverWasKilled = true; // Signal that we initiated the kill
			serverProcess.stdin.end(); // Close stdin first
			const killed = serverProcess.kill("SIGTERM"); // Attempt graceful shutdown
			if (killed) {
				console.log("Sent SIGTERM to server process.");
				// Wait briefly for graceful exit
				await new Promise((resolve) => setTimeout(resolve, 500));
				if (!serverProcess.killed) {
					console.warn("Server did not exit after SIGTERM, sending SIGKILL.");
					serverProcess.kill("SIGKILL");
				}
			} else {
				console.warn("Failed to send SIGTERM, attempting SIGKILL directly.");
				serverProcess.kill("SIGKILL");
			}
		} else {
			console.log("Server process already terminated or not started.");
		}
		// Optional: Cleanup temporary directories/files if created by tests
	});

	// Test cases will go here (Step 8 onwards)
	it("placeholder test", () => {
		expect(true).toBe(true);
	});
});
