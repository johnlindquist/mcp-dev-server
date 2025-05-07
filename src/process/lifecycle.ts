import * as fs from "node:fs";
import * as osModule from "node:os";
import * as path from "node:path";
import type { IPty } from "node-pty";
import type { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cfg } from "../constants/index.js";
import {
	COMPOSITE_LABEL_CONFLICT,
	DID_NOT_TERMINATE_GRACEFULLY_SIGKILL,
	PROCESS_ALREADY_TERMINAL,
	PROCESS_ALREADY_TERMINAL_NO_ACTION,
	PROCESS_NO_ACTIVE_HANDLE,
	TERMINATED_GRACEFULLY_AFTER_SIGTERM,
	WORKING_DIRECTORY_NOT_FOUND,
} from "../constants/messages.js";
import { createShellOperationResult } from "../mcpUtils.js";
import { checkAndUpdateProcessStatus } from "../processSupervisor.js";
import { killPtyProcess } from "../ptyManager.js";
import {
	addLogEntry,
	getShellInfo,
	managedShells,
	updateProcessStatus,
} from "../state.js";
import { removeShell } from "../state.js";
import type {
	HostEnumType,
	LogBufferType,
	LogEntry,
	OperatingSystemEnumType,
	ShellInfo,
	ShellStatus,
} from "../types/process.js";
import type * as schemas from "../types/schemas.js";
import { getTailCommand, log, normalizeLabel } from "../utils.js";

import { LogRingBuffer } from "./LogRingBuffer.js";
// Import newly created functions
import { setupLogFileStream } from "./logging.js";
import { handleShellExit } from "./retry.js"; // Assuming retry logic helper is named this
import { spawnPtyShell } from "./spawn.js"; // <-- Import spawnPtyProcess

// Max length for rolling OSC 133 buffer
const OSC133_BUFFER_MAXLEN = 40;

/**
 * Handles incoming data chunks from a PTY shell (stdout/stderr).
 * Logs the data to the shell's state.
 *
 * @param label The label of the shell.
 * @param data The data chunk received (should be a single line, trimmed).
 * @param source Indicates if the data came from stdout or stderr.
 */
export function handleData(
	label: string,
	data: string,
	source: "stdout" | "stderr",
): void {
	const shellInfo = getShellInfo(label);
	if (!shellInfo) {
		log.warn(label, `[handleData] Received data for unknown shell: ${label}`);
		return; // Exit if shell not found
	}

	// Add the log entry to the managed shell state
	// Use addLogEntry which also handles file logging
	addLogEntry(label, data, "shell");

	log.debug(label, `handleData received: ${JSON.stringify(data)}`);
	log.debug(
		label,
		`char codes: ${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}`,
	);
	log.debug(label, `ALL DATA: ${JSON.stringify(data)}`);
	log.debug(label, `${JSON.stringify(data)}`);
	log.debug(
		label,
		`CHAR_CODES: ${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}`,
	);

	if (label.startsWith("prompt-detect-test-")) {
		log.debug(label, `${JSON.stringify(data)}`);
	}

	// Heuristic: If the line looks like a prompt, set isProbablyAwaitingInput (never sets to false)
	// Common prompt endings: ': ', '? ', '> ', '): ', etc.
	const promptLike = /([:>?] ?|\)?: ?)$/.test(data);
	if (promptLike && data.trim().length > 0) {
		shellInfo.isProbablyAwaitingInput = true;
	}

	// DEBUG: Log every PTY data chunk and buffer state
	log.debug(label, `PTY chunk: ${JSON.stringify(data)}`);
	log.debug(label, `osc133Buffer: ${JSON.stringify(shellInfo.osc133Buffer)}`);

	// TEST-ONLY: Write raw char codes and buffer to /tmp for prompt-detect-test- labels
	if (label.startsWith("prompt-detect-test-")) {
		const out = `CHUNK: [${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}]
BUFFER: [${typeof shellInfo.osc133Buffer === "string"
				? Array.from(shellInfo.osc133Buffer)
					.map((c) => c.charCodeAt(0))
					.join(",")
				: ""
			}]
`;
		fs.appendFileSync(`/tmp/osc133-debug-${label}.log`, out);
	}
}

/**
 * Internal function to stop a background shell.
 * Handles both graceful termination (SIGTERM with fallback to SIGKILL) and forceful kill (SIGKILL).
 */
export async function stopShell(
	label: string,
	force = false,
): Promise<CallToolResult> {
	log.info(label, `Stop requested for shell "${label}". Force: ${force}`);
	addLogEntry(label, `Stop requested. Force: ${force}`, "tool");

	// Refresh status before proceeding
	const initialShellInfo = await checkAndUpdateProcessStatus(label);

	if (!initialShellInfo) {
		return createShellOperationResult(
			label,
			"error", // Default status for not found
			`Shell "${label}" not found.`,
			undefined,
			true,
		);
	}

	// If already in a terminal state, report success
	if (
		initialShellInfo.status === "stopped" ||
		initialShellInfo.status === "crashed" ||
		initialShellInfo.status === "error"
	) {
		log.info(
			label,
			PROCESS_ALREADY_TERMINAL_NO_ACTION(initialShellInfo.status),
		);
		return createShellOperationResult(
			label,
			initialShellInfo.status,
			PROCESS_ALREADY_TERMINAL(initialShellInfo.status),
			// initialShellInfo.pid, // PID might not be in the schema, check schemas.ts
		);
	}

	// Check if we have a shell handle and PID to work with
	if (!initialShellInfo.shell || typeof initialShellInfo.pid !== "number") {
		log.warn(
			label,
			`Shell "${label}" found but has no active shell handle or PID. Cannot send signals. Marking as error.`,
		);
		updateProcessStatus(label, "error"); // Update status to error
		// Return failure as we couldn't perform the stop action
		return createShellOperationResult(
			label,
			"error",
			PROCESS_NO_ACTIVE_HANDLE,
			undefined,
			true,
		);
	}

	// Mark that we initiated the stop and update status
	updateProcessStatus(label, "stopping");

	let finalMessage = "";
	let finalStatus: ShellStatus = initialShellInfo.status;
	const shellToKill = initialShellInfo.shell;
	const pidToKill = initialShellInfo.pid;

	try {
		if (force) {
			// --- Force Kill Logic (SIGKILL immediately) ---
			log.info(
				label,
				`Force stop requested. Sending SIGKILL to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGKILL...", "tool");
			await killPtyProcess(shellToKill, label, "SIGKILL");
			finalMessage = `Force stop requested. SIGKILL sent to PID ${pidToKill}.`;
			finalStatus = "stopping"; // Assume stopping until exit confirms
			log.info(label, finalMessage);
		} else {
			// --- Graceful Shutdown Logic (SIGTERM -> Wait -> SIGKILL) ---
			log.info(
				label,
				`Attempting graceful shutdown. Sending SIGTERM to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGTERM...", "tool");
			await killPtyProcess(shellToKill, label, "SIGTERM");

			log.debug(
				label,
				`Waiting ${cfg.stopWaitDurationMs}ms for graceful shutdown...`,
			);
			await new Promise((resolve) =>
				setTimeout(resolve, cfg.stopWaitDurationMs),
			);

			const infoAfterWait = await checkAndUpdateProcessStatus(label);
			finalStatus = infoAfterWait?.status ?? "error";

			if (
				infoAfterWait &&
				["stopping", "running", "starting", "verifying", "restarting"].includes(
					infoAfterWait.status,
				)
			) {
				log.warn(
					label,
					`Shell ${pidToKill} did not terminate after SIGTERM and ${cfg.stopWaitDurationMs}ms wait. Sending SIGKILL.`,
				);
				addLogEntry(
					label,
					"Graceful shutdown timed out. Sending SIGKILL...",
					"tool",
				);
				await killPtyProcess(shellToKill, label, "SIGKILL");
				finalMessage = DID_NOT_TERMINATE_GRACEFULLY_SIGKILL(pidToKill);
				finalStatus = "stopping";
			} else {
				finalMessage = TERMINATED_GRACEFULLY_AFTER_SIGTERM(pidToKill);
				log.info(label, finalMessage);
				addLogEntry(label, "Shell terminated gracefully.", "tool");
				finalStatus = infoAfterWait?.status ?? "stopped";
			}
		}
	} catch (error) {
		const errorMsg = `Error stopping shell ${label} (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg, "tool");
		addLogEntry(label, `Error stopping shell: ${errorMsg}`, "tool");
		finalMessage = `Error stopping shell: ${errorMsg}`;
		finalStatus = "error"; // Update status to error on exception
		updateProcessStatus(label, "error"); // Persist error state
		return createShellOperationResult(
			label,
			finalStatus,
			finalMessage,
			undefined,
			true, // Explicitly setting isError to true
		);
	}

	// Wait for a short period to allow the exit handler to potentially update the status
	await new Promise((resolve) => setTimeout(resolve, 100)); // e.g., 100ms
	const latestShellInfo = getShellInfo(label); // Get the most up-to-date info

	return createShellOperationResult(
		label,
		latestShellInfo?.status ?? finalStatus, // Prefer latest status from state
		finalMessage,
		undefined,
		finalStatus === "error", // isError if the operation's final determined status is an error
	);
}

export { stopShell as stopProcess };

/**
 * Main function to start and manage a background shell.
 * Orchestrates spawning, logging, verification, and listener setup.
 */
export async function startShell(
	label: string,
	command: string,
	args: string[],
	workingDirectoryInput: string | undefined,
	host: HostEnumType,
	isRestart = false,
): Promise<CallToolResult> {
	// Normalize the label to enforce lowercase and dashes
	const normalizedLabel = normalizeLabel(label);
	const effectiveWorkingDirectory = workingDirectoryInput
		? path.resolve(workingDirectoryInput)
		: process.env.MCP_WORKSPACE_ROOT || process.cwd();

	// Only log in non-test/fast mode to avoid protocol-breaking output in tests
	if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
		log.info(
			normalizedLabel,
			`Starting shell... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", Host: ${host}, isRestart: ${isRestart}`,
			"tool",
		);
	}

	// 1. Verify working directory
	if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
		log.debug(
			normalizedLabel,
			`Verifying working directory: ${effectiveWorkingDirectory}`,
		);
	}
	if (!fs.existsSync(effectiveWorkingDirectory)) {
		const errorMsg = WORKING_DIRECTORY_NOT_FOUND(effectiveWorkingDirectory);
		log.error(normalizedLabel, errorMsg, "tool");
		// Ensure state exists for error
		if (!managedShells.has(normalizedLabel)) {
			// Create minimal error state
			managedShells.set(normalizedLabel, {
				label: normalizedLabel,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: new LogRingBuffer<LogEntry>(cfg.maxStoredLogLines),
				pid: undefined,
				shell: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
				os: "linux",
			});
		}
		updateProcessStatus(normalizedLabel, "error");
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			cwd: effectiveWorkingDirectory,
			error_type: "working_directory_not_found",
		};
		return createShellOperationResult(
			normalizedLabel,
			"error",
			errorMsg,
			undefined,
			true,
		);
	}
	if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
		log.debug(normalizedLabel, "Working directory verified.", "tool");
	}

	const existingShell = managedShells.get(normalizedLabel);

	// 2. Check for active conflict (only if not restarting)
	if (!isRestart) {
		// ... (conflict check logic from _startProcess) ...
		for (const existing of managedShells.values()) {
			if (
				existing.label === normalizedLabel &&
				existing.cwd === effectiveWorkingDirectory &&
				existing.command === command &&
				["starting", "running", "verifying", "restarting", "stopping"].includes(
					existing.status,
				)
			) {
				const errorMsg = COMPOSITE_LABEL_CONFLICT(
					normalizedLabel,
					effectiveWorkingDirectory,
					command,
					existing.status,
					existing.pid,
				);
				log.error(normalizedLabel, errorMsg, "tool");
				const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
					error: errorMsg,
					status: existing.status,
					error_type: "composite_label_conflict",
				};
				return createShellOperationResult(
					normalizedLabel,
					existing.status,
					errorMsg,
					existing.pid,
					true,
				);
			}
		}
	}

	// 3. Spawn PTY Process (use imported function)
	let ptyProcess: IPty;
	try {
		// Only log in non-test/fast mode to avoid protocol-breaking output in tests
		if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
			log.debug(
				normalizedLabel,
				`Attempting to spawn PTY with command: ${command}`,
			);
		}
		ptyProcess = spawnPtyShell(
			// <-- Use imported function
			command,
			args,
			effectiveWorkingDirectory,
			{ ...process.env },
			normalizedLabel,
		);
		// Only log in non-test/fast mode to avoid protocol-breaking output in tests
		if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
			log.debug(
				normalizedLabel,
				`PTY spawned: PID=${ptyProcess.pid}, Command='${command}', Args='${args.join(" ")}' `,
			);
		}
		// Only log in non-test/fast mode to avoid protocol-breaking output in tests
		if (process.env.NODE_ENV !== "test" && process.env.MCP_PM_FAST !== "1") {
			log.info(
				normalizedLabel,
				`PTY process created successfully, PID: ${ptyProcess.pid}`,
			);
		}
	} catch (error) {
		// ... (pty spawn error handling from _startProcess) ...
		const errorMsg = `PTY process spawn failed: ${error instanceof Error ? error.message : String(error)}`;
		if (!managedShells.has(normalizedLabel)) {
			managedShells.set(normalizedLabel, {
				label: normalizedLabel,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: new LogRingBuffer<LogEntry>(cfg.maxStoredLogLines),
				pid: undefined,
				shell: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
				os: "linux",
			});
		}
		updateProcessStatus(normalizedLabel, "error");
		addLogEntry(normalizedLabel, `Error: ${errorMsg}`, "tool");
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			error_type: "pty_spawn_failed",
		};
		return createShellOperationResult(
			normalizedLabel,
			"error",
			errorMsg,
			undefined,
			true,
		);
	}

	// Detect OS
	let detectedOS: OperatingSystemEnumType = "linux";
	const platform = osModule.platform();
	if (platform === "win32") detectedOS = "windows";
	else if (platform === "darwin") detectedOS = "mac";
	else detectedOS = "linux";

	// 4. Create/Update ShellInfo State
	// Always use a LogRingBuffer for logs
	let logsBuffer: LogBufferType;
	if (existingShell && isRestart && existingShell.logs) {
		const prevLogs = logsToArray(existingShell.logs);
		logsBuffer = new LogRingBuffer<LogEntry>(cfg.maxStoredLogLines);
		for (const entry of prevLogs.slice(-cfg.maxStoredLogLines)) {
			logsBuffer.push(entry);
		}
	} else {
		logsBuffer = new LogRingBuffer<LogEntry>(cfg.maxStoredLogLines);
	}
	const shellInfo: ShellInfo = {
		label: normalizedLabel,
		pid: ptyProcess.pid,
		shell: ptyProcess,
		command,
		args,
		cwd: effectiveWorkingDirectory,
		host,
		logs: logsBuffer,
		status: "starting",
		exitCode: null,
		signal: null,
		lastExitTimestamp: existingShell?.lastExitTimestamp,
		restartAttempts: isRestart ? (existingShell?.restartAttempts ?? 0) : 0, // Reset on fresh start
		retryDelayMs: undefined,
		maxRetries: undefined,
		logFilePath: null,
		logFileStream: null,
		mainDataListenerDisposable: undefined,
		mainExitListenerDisposable: undefined,
		partialLineBuffer: "",
		os: detectedOS,
		lastLogTimestampReturned: 0,
		finalizing: true,
	};
	log.error(
		normalizedLabel,
		`[DEBUG] About to set managedShells for label: ${normalizedLabel}`,
	);
	managedShells.set(normalizedLabel, shellInfo);
	log.error(
		normalizedLabel,
		`[DEBUG] After set managedShells for label: ${normalizedLabel}`,
	);
	updateProcessStatus(normalizedLabel, "starting");
	log.debug(normalizedLabel, "ShellInfo created/updated in state.", "tool");

	// 5. Setup Log File Streaming (call helper)
	setupLogFileStream(shellInfo); // Mutates shellInfo
	addLogEntry(
		normalizedLabel,
		`Shell spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
		"tool",
	);

	// 6. Attach Persistent Listeners (if not failed/exited)
	const currentShellState = getShellInfo(normalizedLabel);
	if (
		currentShellState?.shell &&
		!["error", "crashed", "stopped"].includes(currentShellState.status)
	) {
		log.debug(
			normalizedLabel,
			`Attaching persistent listeners. Status: ${currentShellState.status}`,
			"tool",
		);

		// Data Listener
		const FLUSH_IDLE_MS = 50;
		const dataListener = (data: string): void => {
			const currentInfo = getShellInfo(normalizedLabel);
			if (!currentInfo) return;

			// --- OSC 133 rolling buffer detection (on every data chunk) ---
			if (!currentInfo.osc133Buffer) currentInfo.osc133Buffer = "";
			currentInfo.osc133Buffer += data;
			if (currentInfo.osc133Buffer.length > OSC133_BUFFER_MAXLEN) {
				currentInfo.osc133Buffer = currentInfo.osc133Buffer.slice(
					-OSC133_BUFFER_MAXLEN,
				);
			}
			const PROMPT_END_SEQUENCE = "\x1b]133;B\x07";
			const COMMAND_START_SEQUENCE = "\x1b]133;C\x07";
			let idx: number;
			idx = currentInfo.osc133Buffer.indexOf(PROMPT_END_SEQUENCE);
			while (idx !== -1) {
				currentInfo.isProbablyAwaitingInput = true;
				// Trim buffer to just after the matched sequence
				currentInfo.osc133Buffer = currentInfo.osc133Buffer.slice(
					idx + PROMPT_END_SEQUENCE.length,
				);
				idx = currentInfo.osc133Buffer.indexOf(PROMPT_END_SEQUENCE);
			}
			idx = currentInfo.osc133Buffer.indexOf(COMMAND_START_SEQUENCE);
			while (idx !== -1) {
				currentInfo.isProbablyAwaitingInput = false;
				// Trim buffer to just after the matched sequence
				currentInfo.osc133Buffer = currentInfo.osc133Buffer.slice(
					idx + COMMAND_START_SEQUENCE.length,
				);
				idx = currentInfo.osc133Buffer.indexOf(COMMAND_START_SEQUENCE);
			}

			// Append new data to the buffer
			currentInfo.partialLineBuffer =
				(currentInfo.partialLineBuffer || "") + data;

			// Helper to flush the buffer as a log line
			const flushBuffer = () => {
				if (
					currentInfo?.partialLineBuffer &&
					currentInfo.partialLineBuffer.length > 0
				) {
					try {
						handleData(
							normalizedLabel,
							currentInfo.partialLineBuffer,
							"stdout",
						);
					} catch (e: unknown) {
						log.error(
							normalizedLabel,
							"Error processing PTY data (idle flush)",
							(e as Error).message,
						);
					}
					currentInfo.partialLineBuffer = "";
				}
			};

			// Split on both \n and \r
			const buffer = currentInfo.partialLineBuffer;
			const lineRegex = /([\r\n])/g;
			let lastIndex = 0;
			let match: RegExpExecArray | null = lineRegex.exec(buffer);
			while (match !== null) {
				const endIdx = match.index + 1;
				const line = buffer.substring(lastIndex, endIdx);
				const trimmedLine = line.replace(/[\r\n]+$/, "");
				if (trimmedLine) {
					try {
						handleData(normalizedLabel, trimmedLine, "stdout");
					} catch (e: unknown) {
						log.error(
							normalizedLabel,
							"Error processing PTY data",
							(e as Error).message,
						);
					}
				}
				lastIndex = endIdx;
				match = lineRegex.exec(buffer);
			}
			currentInfo.partialLineBuffer = buffer.substring(lastIndex);

			// Reset idle flush timer
			if (currentInfo.idleFlushTimer) {
				clearTimeout(currentInfo.idleFlushTimer);
			}
			currentInfo.idleFlushTimer = setTimeout(() => {
				flushBuffer();
			}, FLUSH_IDLE_MS);

			// DEBUG: Log when isProbablyAwaitingInput is set by OSC 133
			if (idx !== -1) {
				log.error(
					normalizedLabel,
					"[OSC133 DEBUG] Detected PROMPT_END_SEQUENCE, setting isProbablyAwaitingInput = true",
				);
			}
		};
		shellInfo.mainDataListenerDisposable = ptyProcess.onData(dataListener);

		// Exit Listener (Calls retry logic)
		const exitListener = ({
			exitCode,
			signal,
		}: { exitCode: number; signal?: number }) => {
			// On exit, flush any remaining buffer
			const currentInfo = getShellInfo(normalizedLabel);
			if (currentInfo) {
				log.info(
					"[DEBUG][exitListener] lastLogTimestampReturned before flush:",
					`${currentInfo.lastLogTimestampReturned}`,
				);
				if (currentInfo.idleFlushTimer) {
					clearTimeout(currentInfo.idleFlushTimer);
					currentInfo.idleFlushTimer = undefined;
				}
				if (
					currentInfo.partialLineBuffer &&
					currentInfo.partialLineBuffer.length > 0
				) {
					try {
						handleData(
							normalizedLabel,
							currentInfo.partialLineBuffer,
							"stdout",
						);
						log.info(
							"[DEBUG][exitListener] Flushed log on exit:",
							currentInfo.partialLineBuffer,
						);
					} catch (e: unknown) {
						log.error(
							normalizedLabel,
							"Error processing PTY data (exit flush)",
							(e as Error).message,
						);
					}
					currentInfo.partialLineBuffer = "";
				}
				log.info(
					"[DEBUG][exitListener] lastLogTimestampReturned after flush:",
					`${currentInfo.lastLogTimestampReturned}`,
				);
			}
			handleShellExit(
				normalizedLabel,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		};
		shellInfo.mainExitListenerDisposable = ptyProcess.onExit(exitListener);
		log.debug(normalizedLabel, "Persistent listeners attached.", "tool");
		// Immediately set status to 'running' for non-verification processes
		updateProcessStatus(normalizedLabel, "running");
		addLogEntry(
			normalizedLabel,
			"Status: running (no verification specified).",
			"tool",
		);
	} else {
		log.warn(
			normalizedLabel,
			`Skipping persistent listener attachment. Shell state: ${currentShellState?.status}, shell exists: ${!!currentShellState?.shell}`,
			"tool",
		);
	}

	// 6.5. Wait for logs to settle or timeout
	let settleStatus: "settled" | "timeout" = "timeout";
	let settleWaitMs = 0;
	const settleStart = Date.now();
	if (ptyProcess) {
		const settleResult = await waitForLogSettleOrTimeout(
			normalizedLabel,
			ptyProcess,
		);
		settleStatus = settleResult.settled ? "settled" : "timeout";
		settleWaitMs = Date.now() - settleStart;
	}

	// 7. Construct Final Payload
	log.error(
		normalizedLabel,
		`[DEBUG] About to getShellInfo for label: ${normalizedLabel}`,
	);
	const finalShellInfo = getShellInfo(normalizedLabel);
	if (!finalShellInfo) {
		log.error(
			normalizedLabel,
			"Shell info unexpectedly missing after start.",
			"tool",
		);
		log.error(
			normalizedLabel,
			`[DEBUG] getShellInfo returned undefined for label: ${normalizedLabel}. Stack: ${new Error().stack}`,
		);
		return createShellOperationResult(
			normalizedLabel,
			"error",
			"Internal error: Shell info lost",
			undefined,
			true,
		);
	}

	// --- Clear finalizing and cleanup if needed ---
	finalShellInfo.finalizing = false;
	if (["stopped", "crashed", "error"].includes(finalShellInfo.status)) {
		removeShell(normalizedLabel);
	}

	if (finalShellInfo.status === "error") {
		// ... (error payload construction from _startProcess) ...
		const errorMsg = "Shell failed to start. Final status: error.";
		log.error(normalizedLabel, errorMsg, "tool");
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			error_type: "start_failed",
		};
		return createShellOperationResult(
			normalizedLabel,
			"error",
			errorMsg,
			undefined,
			true,
		);
	}

	// Add shellLogs and toolLogs for the AI
	let shellLogs = Array.isArray(finalShellInfo.logs)
		? (finalShellInfo.logs as LogEntry[])
			.filter((l) => l.source === "shell")
			.map((l) => l.content)
		: [];
	let toolLogs = Array.isArray(finalShellInfo.logs)
		? (finalShellInfo.logs as LogEntry[])
			.filter((l) => l.source === "tool")
			.map((l) => l.content)
		: [];

	// If shellLogs is empty and logFilePath exists, read from log file
	if (
		shellLogs.length === 0 &&
		finalShellInfo.logFilePath &&
		fs.existsSync(finalShellInfo.logFilePath)
	) {
		try {
			const fileContent = fs.readFileSync(finalShellInfo.logFilePath, "utf8");
			shellLogs = fileContent.split("\n").filter(Boolean);
		} catch { }
	}

	// If toolLogs is empty and logFilePath exists, read from log file and extract tool lines
	if (
		toolLogs.length === 0 &&
		finalShellInfo.logFilePath &&
		fs.existsSync(finalShellInfo.logFilePath)
	) {
		try {
			const fileContent = fs.readFileSync(finalShellInfo.logFilePath, "utf8");
			toolLogs = fileContent
				.split("\n")
				.filter(
					(line: string) =>
						/tool/i.test(line) ||
						line.startsWith("Status:") ||
						line.startsWith("Shell spawned"),
				);
		} catch { }
	}

	// --- Extract URLs from shellLogs ---
	const urlRegex = /(https?:\/\/[^\s]+)/gi;
	const detectedUrls = Array.from(
		new Set(
			shellLogs.flatMap((line) => {
				const matches = line.match(urlRegex);
				return matches ? matches : [];
			}),
		),
	);

	// --- AI instructions string ---
	const tail_command = getTailCommand(finalShellInfo.logFilePath) || undefined;
	const aiInstructions =
		tail_command && detectedUrls.length > 0
			? "MANDATORY: Immediately run the tail_command using your run_terminal_cmd tool in a BACKGROUND terminal to monitor this shell's output (the command may be blocking). You MUST also display every detected_urls entry as a clickable markdown link to the user. Do not skip these steps."
			: tail_command
				? "MANDATORY: Immediately run the tail_command using your run_terminal_cmd tool in a BACKGROUND terminal to monitor this shell's output (the command may be blocking). Do not skip this step."
				: detectedUrls.length > 0
					? "MANDATORY: You MUST display every detected_urls entry as a clickable markdown link to the user. Do not skip this step."
					: "";

	// --- Build actions array ---
	const payload = _buildStartShellSuccessPayload(finalShellInfo, host, {
		isVerificationEnabled: false,
		verificationPattern: undefined,
		verificationTimeoutMs: undefined,
		detected_urls: detectedUrls.length > 0 ? detectedUrls : undefined,
	});
	log.info(normalizedLabel, payload.message, "tool");

	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: false,
	};
}

function logsToArray(logs: LogBufferType): LogEntry[] {
	return typeof (logs as { toArray?: unknown }).toArray === "function"
		? (logs as { toArray: () => LogEntry[] }).toArray()
		: (logs as LogEntry[]);
}

// Helper to build the success payload for startShell
interface StartShellPayloadOptions {
	isVerificationEnabled?: boolean;
	verificationPattern?: string;
	verificationTimeoutMs?: number;
	detected_urls?: string[];
	extra?: Record<string, unknown>;
}
function _buildStartShellSuccessPayload(
	finalShellInfo: ShellInfo,
	host: HostEnumType,
	options: StartShellPayloadOptions = {},
): z.infer<typeof schemas.StartSuccessPayloadSchema> {
	const {
		isVerificationEnabled = false,
		verificationPattern,
		verificationTimeoutMs,
		detected_urls,
		extra = {},
	} = options;

	// Extract logs
	let shellLogs = Array.isArray(finalShellInfo.logs)
		? (finalShellInfo.logs as LogEntry[])
			.filter((l) => l.source === "shell")
			.map((l) => l.content)
		: [];
	let toolLogs = Array.isArray(finalShellInfo.logs)
		? (finalShellInfo.logs as LogEntry[])
			.filter((l) => l.source === "tool")
			.map((l) => l.content)
		: [];

	// If shellLogs is empty and logFilePath exists, read from log file
	if (
		shellLogs.length === 0 &&
		finalShellInfo.logFilePath &&
		fs.existsSync(finalShellInfo.logFilePath)
	) {
		try {
			const fileContent = fs.readFileSync(finalShellInfo.logFilePath, "utf8");
			shellLogs = fileContent.split("\n").filter(Boolean);
		} catch { }
	}

	// If toolLogs is empty and logFilePath exists, read from log file and extract tool lines
	if (
		toolLogs.length === 0 &&
		finalShellInfo.logFilePath &&
		fs.existsSync(finalShellInfo.logFilePath)
	) {
		try {
			const fileContent = fs.readFileSync(finalShellInfo.logFilePath, "utf8");
			toolLogs = fileContent
				.split("\n")
				.filter(
					(line: string) =>
						/tool/i.test(line) ||
						line.startsWith("Status:") ||
						line.startsWith("Shell spawned"),
				);
		} catch { }
	}

	// Tail command and instructions
	const tail_command = getTailCommand(
		finalShellInfo.logFilePath || finalShellInfo.logFilePath,
	);
	const ai_instructions =
		host === "cursor"
			? `MANDATORY: Immediately run the tail_command using your run_terminal_cmd tool in a BACKGROUND terminal to monitor this shell's output (the command may be blocking). Do not skip this step.`
			: undefined;
	const user_hint =
		host === "cursor"
			? `You can monitor the shell output by running: ${tail_command} `
			: undefined;

	return {
		label: finalShellInfo.label,
		command: finalShellInfo.command,
		args: finalShellInfo.args,
		pid: typeof finalShellInfo.pid === "number" ? finalShellInfo.pid : -1,
		workingDirectory: finalShellInfo.cwd,
		status: finalShellInfo.status,
		message: `Shell '${finalShellInfo.label}' started successfully.Current status: ${finalShellInfo.status}.`,
		host: finalShellInfo.host,
		tail_command: tail_command || undefined,
		ai_instructions: ai_instructions || "",
		user_hint,
		detected_urls,
		isVerificationEnabled,
		verificationPattern,
		verificationTimeoutMs,
		shellLogs,
		toolLogs,
		...extra,
	};
}

// TODO: Move retry logic from processLifecycle.ts to retry.ts
// TODO: Move handleExit from processLifecycle.ts here (or rename to handleProcessExit)
// TODO: Delete processLogic.ts and processLifecycle.ts
// TODO: Update imports everywhere
