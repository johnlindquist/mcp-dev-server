import * as fs from "node:fs";
import * as path from "node:path";
import type { IPty } from "node-pty";
import type { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { cfg } from "../constants/index.js";
import { fail, ok, textPayload } from "../mcpUtils.js";
import { checkAndUpdateProcessStatus } from "../processSupervisor.js";
import { killPtyProcess } from "../ptyManager.js";
import {
	addLogEntry,
	getProcessInfo,
	managedProcesses,
	updateProcessStatus,
} from "../state.js";
import type {
	HostEnumType,
	ProcessInfo,
	ProcessStatus,
} from "../types/process.js";
import type * as schemas from "../types/schemas.js";
import { formatLogsForResponse, getTailCommand, log } from "../utils.js";

// Import newly created functions
import { setupLogFileStream } from "./logging.js";
import { handleProcessExit } from "./retry.js"; // Assuming retry logic helper is named this
import { spawnPtyProcess } from "./spawn.js"; // <-- Import spawnPtyProcess
import { verifyProcessStartup } from "./verify.js";

/**
 * Handles incoming data chunks from a PTY process (stdout/stderr).
 * Logs the data to the process's state.
 *
 * @param label The label of the process.
 * @param data The data chunk received (should be a single line, trimmed).
 * @param source Indicates if the data came from stdout or stderr.
 */
export function handleData(
	label: string,
	data: string,
	source: "stdout" | "stderr",
): void {
	const processInfo = getProcessInfo(label);
	if (!processInfo) {
		log.warn(label, `[handleData] Received data for unknown process: ${label}`);
		return; // Exit if process not found
	}

	// Add the log entry to the managed process state
	// Use addLogEntry which also handles file logging
	addLogEntry(label, data);
}

/**
 * Internal function to stop a background process.
 * Handles both graceful termination (SIGTERM with fallback to SIGKILL) and forceful kill (SIGKILL).
 */
export async function stopProcess(
	label: string,
	force = false,
): Promise<CallToolResult> {
	log.info(label, `Stop requested for process "${label}". Force: ${force}`);
	addLogEntry(label, `Stop requested. Force: ${force}`);

	// Refresh status before proceeding
	const initialProcessInfo = await checkAndUpdateProcessStatus(label);

	if (!initialProcessInfo) {
		return fail(
			textPayload(JSON.stringify({ error: `Process "${label}" not found.` })),
		);
	}

	// If already in a terminal state, report success
	if (
		initialProcessInfo.status === "stopped" ||
		initialProcessInfo.status === "crashed" ||
		initialProcessInfo.status === "error"
	) {
		log.info(
			label,
			`Process already in terminal state: ${initialProcessInfo.status}. No action needed.`,
		);
		const payload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
			label,
			status: initialProcessInfo.status,
			message: `Process already in terminal state: ${initialProcessInfo.status}.`,
			// pid: initialProcessInfo.pid, // PID might not be in the schema, check schemas.ts
		};
		return ok(textPayload(JSON.stringify(payload)));
	}

	// Check if we have a process handle and PID to work with
	if (
		!initialProcessInfo.process ||
		typeof initialProcessInfo.pid !== "number"
	) {
		log.warn(
			label,
			`Process "${label}" found but has no active process handle or PID. Cannot send signals. Marking as error.`,
		);
		updateProcessStatus(label, "error"); // Update status to error
		const payload: z.infer<typeof schemas.StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: "Process found but has no active process handle or PID.",
			// pid: initialProcessInfo.pid,
		};
		// Return failure as we couldn't perform the stop action
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Mark that we initiated the stop and update status
	// TODO: Check if ProcessInfo type allows stopRequested property
	// initialProcessInfo.stopRequested = true;
	updateProcessStatus(label, "stopping");

	let finalMessage = "";
	let finalStatus: ProcessStatus = initialProcessInfo.status; // Use ProcessStatus type
	const processToKill = initialProcessInfo.process; // Store reference
	const pidToKill = initialProcessInfo.pid; // Store PID

	try {
		if (force) {
			// --- Force Kill Logic (SIGKILL immediately) ---
			log.info(
				label,
				`Force stop requested. Sending SIGKILL to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGKILL...");
			await killPtyProcess(processToKill, label, "SIGKILL");
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
			await killPtyProcess(processToKill, label, "SIGTERM");

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
					`Process ${pidToKill} did not terminate after SIGTERM and ${cfg.stopWaitDurationMs}ms wait. Sending SIGKILL.`,
				);
				addLogEntry(label, "Graceful shutdown timed out. Sending SIGKILL...");
				await killPtyProcess(processToKill, label, "SIGKILL");
				finalMessage = `Process ${pidToKill} did not terminate gracefully. SIGKILL sent.`;
				finalStatus = "stopping"; // Assume stopping until exit confirms
			} else {
				finalMessage = `Process ${pidToKill} terminated gracefully after SIGTERM.`;
				log.info(label, finalMessage);
				addLogEntry(label, "Process terminated gracefully.");
				finalStatus = infoAfterWait?.status ?? "stopped"; // Use status after wait
			}
		}
	} catch (error) {
		const errorMsg = `Error stopping process ${label} (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error stopping process: ${errorMsg}`);
		finalMessage = `Error stopping process: ${errorMsg}`;
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
		`Returning result for stop_process. Final status: ${payload.status}.`,
	);
	return ok(textPayload(JSON.stringify(payload)));
}

/**
 * Main function to start and manage a background process.
 * Orchestrates spawning, logging, verification, and listener setup.
 */
export async function startProcess(
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
		`Starting process... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", Host: ${host}, isRestart: ${isRestart}`,
	);

	// 1. Verify working directory
	log.debug(label, `Verifying working directory: ${effectiveWorkingDirectory}`);
	if (!fs.existsSync(effectiveWorkingDirectory)) {
		const errorMsg = `Working directory does not exist: ${effectiveWorkingDirectory}`;
		log.error(label, errorMsg);
		// Ensure state exists for error
		if (!managedProcesses.has(label)) {
			// Create minimal error state
			managedProcesses.set(label, {
				label,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				process: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
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

	const existingProcess = managedProcesses.get(label);

	// 2. Check for active conflict (only if not restarting)
	if (!isRestart) {
		// ... (conflict check logic from _startProcess) ...
		for (const existing of managedProcesses.values()) {
			if (
				existing.label === label &&
				existing.cwd === effectiveWorkingDirectory &&
				existing.command === command &&
				["starting", "running", "verifying", "restarting", "stopping"].includes(
					existing.status,
				)
			) {
				const errorMsg = `An active process with the same label ('${label}'), working directory ('${effectiveWorkingDirectory}'), and command ('${command}') already exists with status '${existing.status}' (PID: ${existing.pid}). Stop the existing process or use a different label.`;
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
		ptyProcess = spawnPtyProcess(
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
		if (!managedProcesses.has(label)) {
			managedProcesses.set(label, {
				label,
				command,
				args,
				host,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				process: null,
				exitCode: null,
				signal: null,
				logFilePath: null,
				logFileStream: null,
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

	// 4. Create/Update ProcessInfo State
	const processInfo: ProcessInfo = {
		label,
		pid: ptyProcess.pid,
		process: ptyProcess,
		command,
		args,
		cwd: effectiveWorkingDirectory,
		host,
		logs: existingProcess && isRestart ? existingProcess.logs : [],
		status: "starting",
		exitCode: null,
		signal: null,
		lastExitTimestamp: existingProcess?.lastExitTimestamp,
		restartAttempts: isRestart ? (existingProcess?.restartAttempts ?? 0) : 0, // Reset on fresh start
		// Removed verificationPattern, verificationTimeoutMs, etc.
		retryDelayMs: undefined,
		maxRetries: undefined,
		logFilePath: null,
		logFileStream: null,
		mainDataListenerDisposable: undefined,
		mainExitListenerDisposable: undefined,
		partialLineBuffer: "",
		// verificationFailureReason: undefined, // Add if needed by schema
		// stopRequested: false, // Add if needed by schema
	};
	managedProcesses.set(label, processInfo);
	updateProcessStatus(label, "starting");
	log.debug(label, "ProcessInfo created/updated in state.");

	// 5. Setup Log File Streaming (call helper)
	setupLogFileStream(processInfo); // Mutates processInfo
	addLogEntry(
		label,
		`Process spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// 6. Attach Persistent Listeners (if not failed/exited)
	const currentProcessState = getProcessInfo(label);
	if (
		currentProcessState?.process &&
		!["error", "crashed", "stopped"].includes(currentProcessState.status)
	) {
		log.debug(
			label,
			`Attaching persistent listeners. Status: ${currentProcessState.status}`,
		);

		// Data Listener
		const dataListener = (data: string): void => {
			const currentInfo = getProcessInfo(label);
			if (!currentInfo) return;
			// Buffer logic from original onData handler
			currentInfo.partialLineBuffer =
				(currentInfo.partialLineBuffer || "") + data;
			let newlineIndex: number;
			newlineIndex = currentInfo.partialLineBuffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = currentInfo.partialLineBuffer.substring(
					0,
					newlineIndex + 1,
				);
				currentInfo.partialLineBuffer = currentInfo.partialLineBuffer.substring(
					newlineIndex + 1,
				);
				const trimmedLine = line.replace(/\r?\n$/, "");
				if (trimmedLine) {
					try {
						handleData(label, trimmedLine, "stdout");
					} catch (e: unknown) {
						log.error(label, "Error processing PTY data", (e as Error).message);
					}
				}
				newlineIndex = currentInfo.partialLineBuffer.indexOf("\n");
			}
		};
		processInfo.mainDataListenerDisposable = ptyProcess.onData(dataListener);

		// Exit Listener (Calls retry logic)
		const exitListener = ({
			exitCode,
			signal,
		}: { exitCode: number; signal?: number }) => {
			handleProcessExit(
				label,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		};
		processInfo.mainExitListenerDisposable = ptyProcess.onExit(exitListener);
		log.debug(label, "Persistent listeners attached.");
		// Immediately set status to 'running' for non-verification processes
		updateProcessStatus(label, "running");
		addLogEntry(label, "Status: running (no verification specified).");
	} else {
		log.warn(
			label,
			`Skipping persistent listener attachment. Process state: ${currentProcessState?.status}, process exists: ${!!currentProcessState?.process}`,
		);
	}

	// 7. Construct Final Payload
	const finalProcessInfo = getProcessInfo(label);
	if (!finalProcessInfo) {
		// ... (error handling from _startProcess) ...
		log.error(label, "Process info unexpectedly missing after start.");
		return fail(
			textPayload(
				JSON.stringify({ error: "Internal error: Process info lost" }),
			),
		);
	}

	if (finalProcessInfo.status === "error") {
		// ... (error payload construction from _startProcess) ...
		const errorMsg = "Process failed to start. Final status: error.";
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
		status: ProcessStatus;
		logs?: string[];
		monitoring_hint?: string;
	} = {
		label: finalProcessInfo.label,
		command: finalProcessInfo.command,
		args: finalProcessInfo.args,
		pid: finalProcessInfo.pid as number,
		workingDirectory: finalProcessInfo.cwd,
		status: finalProcessInfo.status,
		host: finalProcessInfo.host,
		message: `Process '${label}' started successfully. Current status: ${finalProcessInfo.status}.`,
		logs: formatLogsForResponse(
			finalProcessInfo.logs.map((l) => l.content),
			cfg.defaultReturnLogLines,
		),
		monitoring_hint:
			"Use check_process_status periodically to get status updates and new logs.",
		tail_command: getTailCommand(finalProcessInfo.logFilePath) || undefined,
	};
	log.info(label, successPayload.message);

	if (host === "cursor") {
		const logFile = finalProcessInfo.logFilePath || "<logfile>";
		const strongMsg = `You must invoke a tail -f ${logFile} command in a background terminal named after the process label ('${label}') to monitor this process.`;
		return ok(
			textPayload(JSON.stringify(successPayload)),
			textPayload(strongMsg),
		);
	}

	return ok(textPayload(JSON.stringify(successPayload)));
}

export async function startProcessWithVerification(
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
	// Start the process without verification logic
	const startResult = await startProcess(
		label,
		command,
		args,
		workingDirectoryInput,
		host,
		isRestart,
	);

	// If process failed to start, return immediately
	if (startResult.isError) {
		return startResult;
	}

	// Attach verification parameters to processInfo
	const processInfo = getProcessInfo(label);
	if (!processInfo) {
		return startResult;
	}
	processInfo.verificationPattern = verificationPattern;
	processInfo.verificationTimeoutMs = verificationTimeoutMs;
	processInfo.retryDelayMs = retryDelayMs;
	processInfo.maxRetries = maxRetries;

	// Perform verification
	const { verificationFailed, failureReason } =
		await verifyProcessStartup(processInfo);

	const finalProcessInfo = getProcessInfo(label);
	if (!finalProcessInfo) {
		return startResult;
	}

	if (finalProcessInfo.status === "error") {
		const errorMsg = `Process failed to start or verify. Final status: error. ${failureReason || "Unknown reason"}`;
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
		status: ProcessStatus;
		logs?: string[];
		monitoring_hint?: string;
		isVerificationEnabled?: boolean;
		verificationPattern?: string;
		verificationTimeoutMs?: number;
	} = {
		label: finalProcessInfo.label,
		command: finalProcessInfo.command,
		args: finalProcessInfo.args,
		pid: finalProcessInfo.pid as number,
		workingDirectory: finalProcessInfo.cwd,
		status: finalProcessInfo.status,
		host: finalProcessInfo.host,
		message: `Process '${label}' started successfully. Current status: ${finalProcessInfo.status}.`,
		logs: formatLogsForResponse(
			finalProcessInfo.logs.map((l) => l.content),
			cfg.defaultReturnLogLines,
		),
		monitoring_hint:
			"Use check_process_status periodically to get status updates and new logs.",
		tail_command: getTailCommand(finalProcessInfo.logFilePath) || undefined,
		isVerificationEnabled: !!finalProcessInfo.verificationPattern,
		verificationPattern:
			finalProcessInfo.verificationPattern?.source ?? undefined,
		verificationTimeoutMs: finalProcessInfo.verificationTimeoutMs,
	};
	log.info(label, successPayload.message);
	return ok(textPayload(JSON.stringify(successPayload)));
}

// TODO: Move retry logic from processLifecycle.ts to retry.ts
// TODO: Move handleExit from processLifecycle.ts here (or rename to handleProcessExit)
// TODO: Delete processLogic.ts and processLifecycle.ts
// TODO: Update imports everywhere
