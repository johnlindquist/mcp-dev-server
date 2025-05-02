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
export type MCPResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

export type CallToolResult = {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	payload: Array<{ type: "text"; content: string }>;
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
	log_hint?: string;
	message?: string;
};

// --- sendRequest Function ---
export async function sendRequest(
	process: ChildProcessWithoutNullStreams,
	request: Record<string, unknown>,
	timeoutMs = 15000,
): Promise<MCPResponse> {
	const requestId = request.id as string;
	if (!requestId) {
		throw new Error('Request must have an "id" property');
	}
	const requestString = `${JSON.stringify(request)}\n`;
	logVerbose(
		`[sendRequest] Sending request (ID ${requestId}): ${requestString.trim()}`,
	);

	return new Promise<MCPResponse>((resolve, reject) => {
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
				`[sendRequest] Received raw STDOUT chunk for ${requestId}: ${rawChunk.substring(0, 200)}${rawChunk.length > 200 ? "..." : ""}`,
			);
			responseBuffer += rawChunk;
			let newlineIndex: number;
			while (true) {
				newlineIndex = responseBuffer.indexOf("\n");
				if (newlineIndex === -1) break;
				const line = responseBuffer.substring(0, newlineIndex).trim();
				responseBuffer = responseBuffer.substring(newlineIndex + 1);

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
						logVerbose(
							`[sendRequest] Full MATCHING response object for ${requestId}:`,
							JSON.stringify(parsedResponse),
						);
						responseReceived = true;
						cleanup();
						resolve(parsedResponse as MCPResponse);
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
				process.stderr.removeListener("data", logStderr);
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
			cleanup();
			reject(new Error(errorMsg));
		}
	});
}
