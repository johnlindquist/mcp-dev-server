import * as fs from "node:fs";
import * as osModule from "node:os";
import * as path from "node:path";
import type { IPty } from "node-pty";
import type { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cfg } from "../constants/index.js";
import {
	COMPOSITE_LABEL_CONFLICT,
	CURSOR_TAIL_INSTRUCTION,
	DID_NOT_TERMINATE_GRACEFULLY_SIGKILL,
	PROCESS_ALREADY_TERMINAL,
	PROCESS_ALREADY_TERMINAL_NO_ACTION,
	PROCESS_NO_ACTIVE_HANDLE,
	TERMINATED_GRACEFULLY_AFTER_SIGTERM,
	WORKING_DIRECTORY_NOT_FOUND,
} from "../constants/messages.js";
import { fail, ok, textPayload } from "../mcpUtils.js";
import { checkAndUpdateProcessStatus } from "../processSupervisor.js";
import { killPtyProcess } from "../ptyManager.js";
import {
	addLogEntry,
	getShellInfo,
	managedShells,
	updateProcessStatus,
} from "../state.js";
import type {
	HostEnumType,
	OperatingSystemEnumType,
	ShellInfo,
	ShellStatus,
} from "../types/process.js";
import type * as schemas from "../types/schemas.js";
import { formatLogsForResponse, getTailCommand, log } from "../utils.js";

// Import newly created functions
import { setupLogFileStream } from "./logging.js";
import { handleShellExit } from "./retry.js"; // Assuming retry logic helper is named this
import { spawnPtyShell } from "./spawn.js"; // <-- Import spawnPtyProcess
import { verifyProcessStartup } from "./verify.js";

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
	addLogEntry(label, data);

	log.info(label, `[DEBUG] handleData received: ${JSON.stringify(data)}`);
	log.error(
		label,
		`[DEBUG] char codes: ${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}`,
	);
	log.error(label, `[DEBUG] ALL DATA: ${JSON.stringify(data)}`);
	log.error(label, `[HANDLE_DATA] ${JSON.stringify(data)}`);
	log.error(
		label,
		`[CHAR_CODES] ${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}`,
	);

	if (label.startsWith("prompt-detect-test-")) {
		log.error(label, `[TEST ALL DATA] ${JSON.stringify(data)}`);
	}

	// Heuristic: If the line looks like a prompt, set isProbablyAwaitingInput (never sets to false)
	// Common prompt endings: ': ', '? ', '> ', '): ', etc.
	const promptLike = /([:>?] ?|\)?: ?)$/.test(data);
	if (promptLike && data.trim().length > 0) {
		shellInfo.isProbablyAwaitingInput = true;
	}

	// DEBUG: Log every PTY data chunk and buffer state
	log.error(label, `[OSC133 DEBUG] PTY chunk: ${JSON.stringify(data)}`);
	log.error(
		label,
		`[OSC133 DEBUG] osc133Buffer: ${JSON.stringify(shellInfo.osc133Buffer)}`,
	);

	// TEST-ONLY: Write raw char codes and buffer to /tmp for prompt-detect-test- labels
	if (label.startsWith("prompt-detect-test-")) {
		const out = `CHUNK: [${Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(",")}]
BUFFER: [${
			typeof shellInfo.osc133Buffer === "string"
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
	addLogEntry(label, `Stop requested. Force: ${force}`);

	// Refresh status before proceeding
	const initialShellInfo = await checkAndUpdateProcessStatus(label);

	if (!initialShellInfo) {
		return fail(
			textPayload(JSON.stringify({ error: `Shell "${label}" not found.` })),
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
		const payload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
			label,
			status: initialShellInfo.status,
			message: PROCESS_ALREADY_TERMINAL(initialShellInfo.status),
			// pid: initialShellInfo.pid, // PID might not be in the schema, check schemas.ts
		};
		return ok(textPayload(JSON.stringify(payload)));
	}

	// Check if we have a shell handle and PID to work with
	if (!initialShellInfo.shell || typeof initialShellInfo.pid !== "number") {
		log.warn(
			label,
			`Shell "${label}" found but has no active shell handle or PID. Cannot send signals. Marking as error.`,
		);
		updateProcessStatus(label, "error"); // Update status to error
		const payload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: PROCESS_NO_ACTIVE_HANDLE,
			// pid: initialShellInfo.pid,
		};
		// Return failure as we couldn't perform the stop action
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Mark that we initiated the stop and update status
	// TODO: Check if ProcessInfo type allows stopRequested property
	// initialShellInfo.stopRequested = true;
	updateProcessStatus(label, "stopping");

	let finalMessage = "";
	let finalStatus: ShellStatus = initialShellInfo.status; // Use ProcessStatus type
	const shellToKill = initialShellInfo.shell; // Store reference
	const pidToKill = initialShellInfo.pid; // Store PID

	try {
		if (force) {
			// --- Force Kill Logic (SIGKILL immediately) ---
			log.info(
				label,
				`Force stop requested. Sending SIGKILL to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGKILL...");
			await killPtyProcess(shellToKill, label, "SIGKILL");
			// Note: The onExit handler will update the status.
			finalMessage = `Force stop requested. SIGKILL sent to PID ${pidToKill}.`;
			finalStatus = "stopping"; // Assume stopping until exit confirms
			log.info(label, finalMessage);
		} else {
			// --- Graceful Shutdown Logic (SIGTERM -> Wait -> SIGKILL) ---
			log.info(
				label,
				`Attempting graceful shutdown. Sending SIGTERM to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGTERM...");
			await killPtyProcess(shellToKill, label, "SIGTERM");

			log.debug(
				label,
				`Waiting ${cfg.stopWaitDurationMs}ms for graceful shutdown...`,
			);
			await new Promise((resolve) =>
				setTimeout(resolve, cfg.stopWaitDurationMs),
			);

			// Check status *after* the wait
			const infoAfterWait = await checkAndUpdateProcessStatus(label);
			finalStatus = infoAfterWait?.status ?? "error"; // Get potentially updated status

			// Check if still running
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
				addLogEntry(label, "Graceful shutdown timed out. Sending SIGKILL...");
				await killPtyProcess(shellToKill, label, "SIGKILL");
				finalMessage = DID_NOT_TERMINATE_GRACEFULLY_SIGKILL(pidToKill);
				finalStatus = "stopping"; // Assume stopping until exit confirms
			} else {
				finalMessage = TERMINATED_GRACEFULLY_AFTER_SIGTERM(pidToKill);
				log.info(label, finalMessage);
				addLogEntry(label, "Shell terminated gracefully.");
				finalStatus = infoAfterWait?.status ?? "stopped"; // Use status after wait
			}
		}
	} catch (error) {
		const errorMsg = `Error stopping shell ${label} (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error stopping shell: ${errorMsg}`);
		finalMessage = `Error stopping shell: ${errorMsg}`;
		updateProcessStatus(label, "error"); // Ensure status is error
		finalStatus = "error";

		const errorPayload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
			label,
			status: finalStatus,
			message: finalMessage,
			// pid: pidToKill, // Check schema
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}

	// Construct success payload
	const payload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
		label,
		status: finalStatus, // Use the determined final status
		message: finalMessage,
		// pid: pidToKill, // Check schema
	};
	log.info(
		label,
		`Returning result for stop_shell. Final status: ${payload.status}.`,
	);
	return ok(textPayload(JSON.stringify(payload)));
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
	const effectiveWorkingDirectory = workingDirectoryInput
		? path.resolve(workingDirectoryInput)
		: process.env.MCP_WORKSPACE_ROOT || process.cwd();

	log.info(
		label,
		`Starting shell... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", Host: ${host}, isRestart: ${isRestart}`,
	);

	// 1. Verify working directory
	log.debug(label, `Verifying working directory: ${effectiveWorkingDirectory}`);
	if (!fs.existsSync(effectiveWorkingDirectory)) {
		const errorMsg = WORKING_DIRECTORY_NOT_FOUND(effectiveWorkingDirectory);
		log.error(label, errorMsg);
		// Ensure state exists for error
		if (!managedShells.has(label)) {
			// Create minimal error state
			managedShells.set(label, {
				label,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				shell: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
				os: "linux",
			});
		}
		updateProcessStatus(label, "error");
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			cwd: effectiveWorkingDirectory,
			error_type: "working_directory_not_found",
		};
		return fail(textPayload(JSON.stringify(payload)));
	}
	log.debug(label, "Working directory verified.");

	const existingShell = managedShells.get(label);

	// 2. Check for active conflict (only if not restarting)
	if (!isRestart) {
		// ... (conflict check logic from _startProcess) ...
		for (const existing of managedShells.values()) {
			if (
				existing.label === label &&
				existing.cwd === effectiveWorkingDirectory &&
				existing.command === command &&
				["starting", "running", "verifying", "restarting", "stopping"].includes(
					existing.status,
				)
			) {
				const errorMsg = COMPOSITE_LABEL_CONFLICT(
					label,
					effectiveWorkingDirectory,
					command,
					existing.status,
					existing.pid,
				);
				log.error(label, errorMsg);
				const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
					error: errorMsg,
					status: existing.status,
					error_type: "composite_label_conflict",
				};
				return fail(textPayload(JSON.stringify(payload)));
			}
		}
	}

	// 3. Spawn PTY Process (use imported function)
	let ptyProcess: IPty;
	try {
		log.debug(label, `Attempting to spawn PTY with command: ${command}`);
		ptyProcess = spawnPtyShell(
			// <-- Use imported function
			command,
			args,
			effectiveWorkingDirectory,
			{ ...process.env },
			label,
		);
		log.info(label, `PTY process created successfully, PID: ${ptyProcess.pid}`);
	} catch (error) {
		// ... (pty spawn error handling from _startProcess) ...
		const errorMsg = `PTY process spawn failed: ${error instanceof Error ? error.message : String(error)}`;
		if (!managedShells.has(label)) {
			managedShells.set(label, {
				label,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				shell: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
				os: "linux",
			});
		}
		updateProcessStatus(label, "error");
		addLogEntry(label, `Error: ${errorMsg}`);
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			error_type: "pty_spawn_failed",
		};
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Detect OS
	let detectedOS: OperatingSystemEnumType = "linux";
	const platform = osModule.platform();
	if (platform === "win32") detectedOS = "windows";
	else if (platform === "darwin") detectedOS = "mac";
	else detectedOS = "linux";

	// 4. Create/Update ShellInfo State
	const shellInfo: ShellInfo = {
		label,
		pid: ptyProcess.pid,
		shell: ptyProcess,
		command,
		args,
		cwd: effectiveWorkingDirectory,
		host,
		logs: existingShell && isRestart ? existingShell.logs : [],
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
	};
	managedShells.set(label, shellInfo);
	updateProcessStatus(label, "starting");
	log.debug(label, "ShellInfo created/updated in state.");

	// 5. Setup Log File Streaming (call helper)
	setupLogFileStream(shellInfo); // Mutates shellInfo
	addLogEntry(
		label,
		`Shell spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// 6. Attach Persistent Listeners (if not failed/exited)
	const currentShellState = getShellInfo(label);
	if (
		currentShellState?.shell &&
		!["error", "crashed", "stopped"].includes(currentShellState.status)
	) {
		log.debug(
			label,
			`Attaching persistent listeners. Status: ${currentShellState.status}`,
		);

		// Data Listener
		const FLUSH_IDLE_MS = 50;
		const dataListener = (data: string): void => {
			const currentInfo = getShellInfo(label);
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
						handleData(label, currentInfo.partialLineBuffer, "stdout");
					} catch (e: unknown) {
						log.error(
							label,
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
						handleData(label, trimmedLine, "stdout");
					} catch (e: unknown) {
						log.error(label, "Error processing PTY data", (e as Error).message);
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
					label,
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
			const currentInfo = getShellInfo(label);
			if (currentInfo) {
				if (currentInfo.idleFlushTimer) {
					clearTimeout(currentInfo.idleFlushTimer);
					currentInfo.idleFlushTimer = undefined;
				}
				if (
					currentInfo.partialLineBuffer &&
					currentInfo.partialLineBuffer.length > 0
				) {
					try {
						handleData(label, currentInfo.partialLineBuffer, "stdout");
					} catch (e: unknown) {
						log.error(
							label,
							"Error processing PTY data (exit flush)",
							(e as Error).message,
						);
					}
					currentInfo.partialLineBuffer = "";
				}
			}
			handleShellExit(
				label,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		};
		shellInfo.mainExitListenerDisposable = ptyProcess.onExit(exitListener);
		log.debug(label, "Persistent listeners attached.");
		// Immediately set status to 'running' for non-verification processes
		updateProcessStatus(label, "running");
		addLogEntry(label, "Status: running (no verification specified).");
	} else {
		log.warn(
			label,
			`Skipping persistent listener attachment. Shell state: ${currentShellState?.status}, shell exists: ${!!currentShellState?.shell}`,
		);
	}

	// 7. Construct Final Payload
	const finalShellInfo = getShellInfo(label);
	if (!finalShellInfo) {
		// ... (error handling from _startProcess) ...
		log.error(label, "Shell info unexpectedly missing after start.");
		return fail(
			textPayload(JSON.stringify({ error: "Internal error: Shell info lost" })),
		);
	}

	if (finalShellInfo.status === "error") {
		// ... (error payload construction from _startProcess) ...
		const errorMsg = "Shell failed to start. Final status: error.";
		log.error(label, errorMsg);
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			error_type: "start_failed",
		};
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Success case
	const successPayload: z.infer<typeof schemas.StartSuccessPayloadSchema> & {
		status: ShellStatus;
		logs?: string[];
		monitoring_hint?: string;
	} = {
		label: finalShellInfo.label,
		command: finalShellInfo.command,
		args: finalShellInfo.args,
		pid: finalShellInfo.pid as number,
		workingDirectory: finalShellInfo.cwd,
		status: finalShellInfo.status,
		host: finalShellInfo.host,
		message: `Shell '${label}' started successfully. Current status: ${finalShellInfo.status}.`,
		logs: formatLogsForResponse(
			finalShellInfo.logs.map((l) => l.content),
			cfg.defaultReturnLogLines,
		),
		monitoring_hint:
			"Use check_shell periodically to get status updates and new logs.",
		tail_command: getTailCommand(finalShellInfo.logFilePath) || undefined,
	};
	log.info(label, successPayload.message);

	if (host === "cursor") {
		const logFile = finalShellInfo.logFilePath || "<logfile>";
		const strongMsg = CURSOR_TAIL_INSTRUCTION(
			logFile,
			label,
			finalShellInfo.os,
		);
		return ok(
			textPayload(JSON.stringify(successPayload)),
			textPayload(strongMsg),
		);
	}

	return ok(textPayload(JSON.stringify(successPayload)));
}

export async function startShellWithVerification(
	label: string,
	command: string,
	args: string[],
	workingDirectoryInput: string | undefined,
	host: HostEnumType,
	verificationPattern: RegExp | undefined,
	verificationTimeoutMs: number | undefined,
	retryDelayMs: number | undefined,
	maxRetries: number | undefined,
	isRestart = false,
): Promise<CallToolResult> {
	// Start the shell without verification logic
	const startResult = await startShell(
		label,
		command,
		args,
		workingDirectoryInput,
		host,
		isRestart,
	);

	// If shell failed to start, return immediately
	if (startResult.isError) {
		return startResult;
	}

	// Attach verification parameters to shellInfo
	const shellInfo = getShellInfo(label);
	if (!shellInfo) {
		return startResult;
	}
	shellInfo.verificationPattern = verificationPattern;
	shellInfo.verificationTimeoutMs = verificationTimeoutMs;
	shellInfo.retryDelayMs = retryDelayMs;
	shellInfo.maxRetries = maxRetries;

	// Perform verification
	const { verificationFailed, failureReason } =
		await verifyProcessStartup(shellInfo);

	const finalShellInfo = getShellInfo(label);
	if (!finalShellInfo) {
		return startResult;
	}

	if (finalShellInfo.status === "error") {
		const errorMsg = `Shell failed to start or verify. Final status: error. ${failureReason || "Unknown reason"}`;
		log.error(label, errorMsg);
		const payload: z.infer<typeof schemas.StartErrorPayloadSchema> = {
			error: errorMsg,
			status: "error",
			error_type: "start_or_verification_failed",
		};
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Success case (reuse the same payload as startProcess)
	const successPayload: z.infer<typeof schemas.StartSuccessPayloadSchema> & {
		status: ShellStatus;
		logs?: string[];
		monitoring_hint?: string;
		isVerificationEnabled?: boolean;
		verificationPattern?: string;
		verificationTimeoutMs?: number;
	} = {
		label: finalShellInfo.label,
		command: finalShellInfo.command,
		args: finalShellInfo.args,
		pid: finalShellInfo.pid as number,
		workingDirectory: finalShellInfo.cwd,
		status: finalShellInfo.status,
		host: finalShellInfo.host,
		message: `Shell '${label}' started successfully. Current status: ${finalShellInfo.status}.`,
		logs: formatLogsForResponse(
			finalShellInfo.logs.map((l) => l.content),
			cfg.defaultReturnLogLines,
		),
		monitoring_hint:
			"Use check_shell periodically to get status updates and new logs.",
		tail_command: getTailCommand(finalShellInfo.logFilePath) || undefined,
		isVerificationEnabled: !!finalShellInfo.verificationPattern,
		verificationPattern:
			finalShellInfo.verificationPattern?.source ?? undefined,
		verificationTimeoutMs: finalShellInfo.verificationTimeoutMs,
	};
	log.info(label, successPayload.message);
	return ok(textPayload(JSON.stringify(successPayload)));
}

// TODO: Move retry logic from processLifecycle.ts to retry.ts
// TODO: Move handleExit from processLifecycle.ts here (or rename to handleProcessExit)
// TODO: Delete processLogic.ts and processLifecycle.ts
// TODO: Update imports everywhere
