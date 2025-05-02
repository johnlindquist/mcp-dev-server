import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	SERVER_ARGS,
	SERVER_EXECUTABLE,
	SERVER_READY_OUTPUT,
	SERVER_SCRIPT_PATH,
	STARTUP_TIMEOUT,
} from "./test-helpers";

let serverProcess: ChildProcessWithoutNullStreams;

describe("OSC 133 Prompt Detection", () => {
	const LABEL_PREFIX = "prompt-detect-test-";
	const COMMAND = "bash";
	const ARGS = ["-i"]; // interactive shell
	const BASH_OSC133_CONFIG = `${`
function _osc133_prompt_start { printf "\x1b]133;A\a"; }
function _osc133_prompt_end { printf "\x1b]133;B\a"; }
function _osc133_command_start { printf "\x1b]133;C\a"; }
function _osc133_command_done { printf "\x1b]133;D;%s\a" "$?"; }

# Execute prompt start before each prompt display
PROMPT_COMMAND='_osc133_prompt_start'

# PS1 executes prompt end via command substitution so it runs when prompt is rendered
PS1="\\[\$(_osc133_prompt_end)\\]\\u@\\h:\\w\\$ "

echo "OSC 133 Configured"
`
		.trim()
		.replace(/\n\s*/g, "; ")}\r`;

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

	it("should detect OSC 133 prompt end sequence", async () => {
		const label = LABEL_PREFIX + Date.now();
		// Start bash -i
		const startRequest = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "start_process",
				arguments: {
					label,
					command: COMMAND,
					args: ARGS,
					workingDirectory: process.cwd(),
				},
			},
			id: `req-start-${label}`,
		};
		await sendRequest(serverProcess, startRequest);
		// Inject OSC 133 config
		const configRequest = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "send_input",
				arguments: {
					label,
					input: BASH_OSC133_CONFIG,
				},
			},
			id: `req-config-${label}`,
		};
		await sendRequest(serverProcess, configRequest);
		// Send echo of the sentinel
		const echoRequest = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "send_input",
				arguments: {
					label,
					input: 'echo "@@OSC133B@@"',
				},
			},
			id: `req-echo-${label}`,
		};
		await sendRequest(serverProcess, echoRequest);
		// Wait for shell to process config and echo
		await new Promise((resolve) => setTimeout(resolve, 2000));
		// Check process status and assert isAwaitingInput is true
		const checkRequest = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "check_process_status",
				arguments: { label, log_lines: 100 },
			},
			id: `req-check-${label}`,
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const checkResponse = (await sendRequest(serverProcess, checkRequest)) as {
			result: { content: { text: string }[] };
		};
		const checkResult = JSON.parse(checkResponse.result.content[0].text);
		// Print logs for debugging
		// eslint-disable-next-line no-console
		console.log("Process logs:", checkResult.logs);
		expect(checkResult.isAwaitingInput).toBe(true);
		// Cleanup
		const stopRequest = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "stop_process",
				arguments: { label },
			},
			id: `req-stop-${label}`,
		};
		await sendRequest(serverProcess, stopRequest);
	});
});
