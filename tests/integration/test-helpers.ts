import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

// --- Configuration ---
export const SERVER_EXECUTABLE = "node";
export const SERVER_SCRIPT_PATH = path.resolve(
	__dirname,
	"../../build/index.mjs",
);
export const SERVER_ARGS: string[] = [];
export const SERVER_READY_OUTPUT =
	"MCP Server connected and listening via stdio.";
export const STARTUP_TIMEOUT = 20000; // 20 seconds
export const TEST_TIMEOUT = STARTUP_TIMEOUT + 10000; // Increase slightly for overhead

// --- Verbose Logging ---
export const IS_VERBOSE = process.env.MCP_TEST_VERBOSE === "1";
export function logVerbose(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.log("[VERBOSE]", ...args);
	}
}
export function logVerboseError(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.error("[VERBOSE_ERR]", ...args);
	}
}

// --- Type definitions ---
// (Keep these simplified or import from src if preferred and stable)
export type MCPResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

// Adjusted based on usage in tests
export type CallToolResult = {
	toolCallId?: string; // Optional based on MCP spec/impl
	toolName?: string; // Optional
	isError?: boolean; // Common pattern
	payload: Array<{ type: "text"; content: string }>; // Assuming text content holds JSON string
};

export type ProcessStatusResult = {
	label: string;
	status: "running" | "stopped" | "starting" | "error" | "crashed";
	pid?: number;
	command?: string;
	args?: string[];
	cwd?: string;
	exitCode?: number | null;
	signal?: string | null;
	logs?: string[];
	log_hint?: string; // Add log_hint here
	message?: string; // Added for summary test
	// Other fields omitted for simplicity
};

// --- sendRequest Function ---
// Note: We will modify this later to accept the process from global setup
export async function sendRequest(
	process: ChildProcessWithoutNullStreams, // Keep process as argument for now
	request: Record<string, unknown>,
	timeoutMs = 15000, // Slightly increased default timeout
): Promise<MCPResponse> {
	// Return MCPResponse directly
	const requestId = request.id as string;
	if (!requestId) {
		throw new Error('Request must have an "id" property');
	}
	const requestString = `${JSON.stringify(request)}\n`;
	logVerbose(
		`[sendRequest] Sending request (ID ${requestId}): ${requestString.trim()}`,
	);

	// Wrap the existing logic in a promise
	return new Promise<MCPResponse>((resolve, reject) => {
		let responseBuffer = "";
		let responseReceived = false;
		let responseListenersAttached = false;
		let newlineIndex: number; // Explicitly type newlineIndex

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
			// Process buffer line by line
			while (true) {
				// Loop indefinitely, break inside
				newlineIndex = responseBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break; // No more complete lines in the buffer
				}
				const line = responseBuffer.substring(0, newlineIndex).trim();
				responseBuffer = responseBuffer.substring(newlineIndex + 1); // Remove processed line + newline

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
						// Log the full received result object when ID matches, before resolving
						logVerbose(
							`[sendRequest] Full MATCHING response object for ${requestId}:`,
							JSON.stringify(parsedResponse),
						);
						responseReceived = true;
						cleanup();
						resolve(parsedResponse as MCPResponse); // Resolve with the parsed response
						return; // Found the response, exit handler
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
			// Check if process exists and streams are readable/writable before removing listeners
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
				process.stderr.removeListener("data", logStderr); // Also remove stderr listener if added
			}
			if (responseListenersAttached && process && !process.killed) {
				process.removeListener("error", onError);
				process.removeListener("exit", onExit);
			}
			responseListenersAttached = false;
		};

		const logStderr = (data: Buffer) => {
			logVerboseError(
				`[sendRequest][Server STDERR during request ${requestId}]: ${data.toString().trim()}`,
			);
		};

		// Attach listeners only if process streams are available
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
		// Check if stdin is writable before writing
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
			cleanup(); // Cleanup listeners if attach failed
			reject(new Error(errorMsg));
		}
	});
}
