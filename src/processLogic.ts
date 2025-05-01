import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IDisposable, IPty } from "node-pty"; // Import only types if needed
import treeKill from "tree-kill";
import type { z } from "zod"; // Import zod
import {
	DEFAULT_RETURN_LOG_LINES,
	LOG_SETTLE_DURATION_MS,
	OVERALL_LOG_WAIT_TIMEOUT_MS,
	STOP_WAIT_DURATION,
} from "./constants.js";
import { serverLogDirectory } from "./main.js"; // Import the log dir path
import { fail, ok, textPayload } from "./mcpUtils.js";
import { handleExit } from "./processLifecycle.js"; // Import handleExit from new location
import { checkAndUpdateProcessStatus } from "./processSupervisor.js"; // Import from supervisor
import { killPtyProcess, spawnPtyProcess } from "./ptyManager.js"; // Import new functions
import {
	addLogEntry,
	getProcessInfo,
	managedProcesses,
	updateProcessStatus,
} from "./state.js";
import type {
	CallToolResult,
	HostEnumType, // <-- Import HostEnumType
	ProcessInfo,
	ProcessStatus, // Import ProcessStatus
	StartErrorPayloadSchema,
	StartSuccessPayloadSchema,
	StopProcessPayloadSchema,
} from "./types.ts"; // Renamed types
import { formatLogsForResponse, getTailCommand, log } from "./utils.js";
import { sanitizeLabelForFilename } from "./utils.js"; // Import sanitizer

const killProcessTree = promisify(treeKill);

/**
 * Waits until logs have settled (no new data for a duration) or an overall timeout is reached.
 * Listens temporarily to the PTY process data stream.
 *
 * @param label Process label for logging.
 * @param ptyProcess The node-pty process instance.
 * @returns A promise that resolves when logs settle or timeout occurs.
 */
async function _waitForLogSettleOrTimeout(
	label: string,
	ptyProcess: IPty,
): Promise<{ settled: boolean; timedOut: boolean }> {
	return new Promise((resolve) => {
		let settleTimerId: NodeJS.Timeout | null = null;
		let overallTimeoutId: NodeJS.Timeout | null = null;
		let settled = false;
		let timedOut = false;
		let dataListenerDisposable: IDisposable | null = null;
		let exitListenerDisposable: IDisposable | null = null; // Added exit listener

		const cleanup = () => {
			if (settleTimerId) clearTimeout(settleTimerId);
			if (overallTimeoutId) clearTimeout(overallTimeoutId);
			if (dataListenerDisposable) {
				log.debug(
					label,
					"[_waitForLogSettleOrTimeout] Disposing temporary data listener.",
				);
				dataListenerDisposable.dispose();
			}
			if (exitListenerDisposable) {
				log.debug(
					label,
					"[_waitForLogSettleOrTimeout] Disposing temporary exit listener.",
				);
				exitListenerDisposable.dispose();
			}
			settleTimerId = null;
			overallTimeoutId = null;
			dataListenerDisposable = null;
			exitListenerDisposable = null; // Clear exit listener
		};

		const onSettle = () => {
			if (timedOut) return; // Don't resolve if already timed out
			log.debug(label, `Logs settled after ${LOG_SETTLE_DURATION_MS}ms pause.`);
			settled = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const onOverallTimeout = () => {
			if (settled) return; // Don't resolve if already settled
			log.warn(
				label,
				`Overall log wait timeout (${OVERALL_LOG_WAIT_TIMEOUT_MS}ms) reached. Proceeding with captured logs.`,
			);
			timedOut = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const onProcessExit = ({
			exitCode,
			signal,
		}: { exitCode: number; signal?: number }) => {
			if (settled || timedOut) return; // Don't act if already resolved
			log.warn(
				label,
				`Process exited (code: ${exitCode}, signal: ${signal ?? "N/A"}) during log settle wait.`,
			);
			// Indicate timeout as the reason for stopping the wait, even though it was an exit
			timedOut = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const resetSettleTimer = () => {
			if (settled || timedOut) return; // Don't reset if already resolved
			if (settleTimerId) clearTimeout(settleTimerId);
			settleTimerId = setTimeout(onSettle, LOG_SETTLE_DURATION_MS);
		};

		// Attach temporary listeners
		// dataListenerDisposable = ptyProcess.onData(() => { // <-- Keep this commented out
		// 	log.debug(label, "[_waitForLogSettleOrTimeout.onData] Received data during settle wait.");
		// 	resetSettleTimer(); // Reset settle timer on any data
		// }); // <-- Keep this commented out
		exitListenerDisposable = ptyProcess.onExit(onProcessExit); // Handle exit during wait

		// Start timers
		resetSettleTimer(); // Initial settle timer
		overallTimeoutId = setTimeout(
			onOverallTimeout,
			OVERALL_LOG_WAIT_TIMEOUT_MS,
		);

		log.debug(
			label,
			`Waiting for logs to settle (Pause: ${LOG_SETTLE_DURATION_MS}ms, Timeout: ${OVERALL_LOG_WAIT_TIMEOUT_MS}ms)...`,
		);
	});
}

/**
 * Internal function to start a background process.
 * Handles process spawning, logging, status updates, verification, and retries.
 */
export async function _startProcess(
	label: string,
	command: string,
	args: string[], // Added args
	workingDirectoryInput: string | undefined,
	host: HostEnumType, // <-- Use HostEnumType
	verificationPattern: RegExp | undefined, // Added verification pattern
	verificationTimeoutMs: number | undefined, // Added verification timeout
	retryDelayMs: number | undefined, // Added retry delay
	maxRetries: number | undefined, // Added max retries
	isRestart = false, // Flag to indicate if this is a restart
): Promise<CallToolResult> {
	const effectiveWorkingDirectory = workingDirectoryInput
		? path.resolve(workingDirectoryInput)
		: process.env.MCP_WORKSPACE_ROOT || process.cwd();

	log.info(
		label,
		`Starting process... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", Host: ${host}, isRestart: ${isRestart}`, // Log host
	);

	// Verify working directory
	log.debug(label, `Verifying working directory: ${effectiveWorkingDirectory}`);
	if (!fs.existsSync(effectiveWorkingDirectory)) {
		const errorMsg = `Working directory does not exist: ${effectiveWorkingDirectory}`;
		log.error(label, errorMsg);
		// Ensure an entry exists if this is the first attempt
		if (!managedProcesses.has(label)) {
			managedProcesses.set(label, {
				label,
				command,
				args,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				process: null,
				exitCode: null,
				signal: null,
				verificationPattern,
				verificationTimeoutMs,
				retryDelayMs,
				maxRetries,
				logFilePath: null,
				logFileStream: null,
				host: host, // <-- ADD host
			});
		}
		updateProcessStatus(label, "error"); // Simplified update
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					cwd: effectiveWorkingDirectory,
					error_type: "working_directory_not_found",
				}),
			),
		);
	}
	log.debug(label, "Working directory verified.");

	const existingProcess = managedProcesses.get(label);

	// Check for active conflict based on label, cwd, and command
	if (!isRestart) {
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
				// Use StartErrorPayloadSchema for consistency
				const payload: z.infer<typeof StartErrorPayloadSchema> = {
					error: errorMsg,
					status: existing.status,
					error_type: "composite_label_conflict",
				};
				return fail(textPayload(JSON.stringify(payload)));
			}
		}
	}

	// If only label matches and not restarting, warn about reusing label but allow it if cwd/command differ
	if (
		!isRestart &&
		existingProcess &&
		existingProcess.label === label && // Check label again
		(existingProcess.cwd !== effectiveWorkingDirectory ||
			existingProcess.command !== command) &&
		["starting", "running", "verifying", "restarting", "stopping"].includes(
			existingProcess.status,
		)
	) {
		log.warn(
			label,
			`Reusing label "${label}" but with a different command/cwd. Previous instance (status: ${existingProcess.status}, cwd: ${existingProcess.cwd}, cmd: ${existingProcess.command}) will remain active. Ensure labels are distinct if managing truly different processes.`,
		);
		// No longer clearing old state here, as we allow multiple processes with same label if cwd/cmd differ
	} else if (isRestart) {
		log.info(label, `Restarting process "${label}".`);
	}

	const shell =
		process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "bash");
	let ptyProcess: IPty;
	const fullCommand = [command, ...args].join(" "); // Combine command and args for PTY

	// --- Log File Setup ---
	let logFilePath: string | null = null;
	let logFileStream: fs.WriteStream | null = null;

	if (serverLogDirectory) {
		try {
			const safeFilename = `${sanitizeLabelForFilename(label)}.log`; // Ensure .log extension
			logFilePath = path.join(serverLogDirectory, safeFilename);
			log.info(label, `Logging process output to: ${logFilePath} (mode: a)`);
			logFileStream = fs.createWriteStream(logFilePath, { flags: "a" });
			logFileStream.on("error", (err) => {
				log.error(label, `Error writing to log file ${logFilePath}:`, err);
				// Optionally try to close/nullify the stream here?
				if (managedProcesses.has(label)) {
					const info = managedProcesses.get(label);
					if (info) {
						info.logFileStream?.end(); // Attempt to close
						info.logFileStream = null; // Prevent further writes
						info.logFilePath = null; // Clear path as it's unusable
					}
				}
			});
			log.info(label, `Logging process output to: ${logFilePath} (mode: a)`);
			addLogEntry(
				label,
				`--- Process Started (${new Date().toISOString()}) ---`,
			); // Add start marker to file too
		} catch (error) {
			log.error(label, "Failed to create or open log file stream", error);
			logFilePath = null; // Ensure path is null if setup failed
			logFileStream = null;
		}
	} else {
		log.warn(
			label,
			"Log directory not configured, persistent file logging disabled.",
		);
	}
	// --- End Log File Setup ---

	try {
		log.debug(label, `Attempting to spawn PTY with command: ${command}`);
		ptyProcess = spawnPtyProcess(
			command,
			args,
			effectiveWorkingDirectory,
			{
				...process.env, // Pass environment variables
				// Add or override specific env vars if needed
			},
			label,
		);
		log.info(label, `PTY process created successfully, PID: ${ptyProcess.pid}`);
	} catch (error) {
		// Error already logged by spawnPtyProcess
		const errorMsg = `PTY process spawn failed: ${error instanceof Error ? error.message : String(error)}`;
		// Ensure state exists for error reporting
		if (!managedProcesses.has(label)) {
			managedProcesses.set(label, {
				label,
				command,
				args,
				cwd: effectiveWorkingDirectory,
				status: "error",
				logs: [],
				pid: undefined,
				process: null,
				exitCode: null,
				signal: null,
				verificationPattern,
				verificationTimeoutMs,
				retryDelayMs,
				maxRetries,
				logFilePath,
				logFileStream,
				host: host, // <-- ADD host
			});
		}
		updateProcessStatus(label, "error");
		addLogEntry(label, `Error: ${errorMsg}`);
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					error_type: "pty_spawn_failed",
				}),
			),
		);
	}

	// Create or update the process info entry
	const processInfo: ProcessInfo = {
		label,
		pid: ptyProcess.pid,
		process: ptyProcess,
		command,
		args,
		cwd: effectiveWorkingDirectory,
		logs: existingProcess && isRestart ? existingProcess.logs : [], // Preserve logs on restart
		status: "starting",
		exitCode: null,
		signal: null,
		lastExitTimestamp: existingProcess?.lastExitTimestamp, // Use lastExitTimestamp
		restartAttempts: existingProcess?.restartAttempts, // Preserve attempts on restart
		verificationPattern,
		verificationTimeoutMs: verificationTimeoutMs ?? undefined, // Use undefined, not null
		verificationTimer: undefined,
		retryDelayMs: retryDelayMs ?? undefined, // Use undefined, not null
		maxRetries: maxRetries ?? undefined, // Use undefined
		logFilePath: logFilePath, // <-- STORED
		logFileStream: logFileStream, // <-- STORED
		mainDataListenerDisposable: undefined,
		mainExitListenerDisposable: undefined,
		partialLineBuffer: "",
		host, // <-- Assign host of type HostEnumType
	};
	managedProcesses.set(label, processInfo);
	updateProcessStatus(label, "starting"); // Ensure status is set via the function
	addLogEntry(
		label,
		`Process spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// --- Verification Logic ---
	let isVerified = !verificationPattern;
	let patternMatched = false;
	let verificationPromiseResolved = false;
	let verificationCompletionResolver: (() => void) | null = null;
	const verificationCompletionPromise = new Promise<void>((resolve) => {
		verificationCompletionResolver = resolve;
	});
	let dataListenerDisposable: IDisposable | undefined;
	let exitListenerDisposable: IDisposable | undefined;

	if (verificationPattern) {
		isVerified = false;
		const timeoutMs = processInfo.verificationTimeoutMs;
		log.info(
			label,
			`Verification required: Pattern /${verificationPattern.source}/, Timeout: ${timeoutMs === undefined ? "disabled" : `${timeoutMs}ms`}`,
		);
		addLogEntry(label, "Status: verifying. Waiting for pattern or timeout.");
		updateProcessStatus(label, "verifying");

		const dataListener = (data: string): void => {
			if (verificationPromiseResolved) return;
			try {
				handleData(label, data.replace(/\r?\n$/, ""), "stdout"); // Log trimmed data

				if (verificationPattern.test(data)) {
					if (getProcessInfo(label)?.status === "verifying") {
						log.info(label, "Verification pattern matched.");
						patternMatched = true;
						verificationPromiseResolved = true;
						if (verificationCompletionResolver)
							verificationCompletionResolver();
					} else {
						log.warn(
							label,
							`Verification pattern matched, but status is now ${getProcessInfo(label)?.status}. Ignoring match.`,
						);
					}
				}
			} catch (e: unknown) {
				log.error(label, "Error during verification data processing", e);
				if (!verificationPromiseResolved) {
					verificationPromiseResolved = true;
					if (verificationCompletionResolver) verificationCompletionResolver();
				}
			}
		};
		dataListenerDisposable = ptyProcess.onData(dataListener);

		const exitListener = () => {
			if (verificationPromiseResolved) return;
			if (getProcessInfo(label)?.status === "verifying") {
				log.warn(label, "Process exited during verification phase.");
				verificationPromiseResolved = true;
				if (verificationCompletionResolver) verificationCompletionResolver();
			}
		};
		exitListenerDisposable = ptyProcess.onExit(exitListener);

		if (timeoutMs !== undefined) {
			processInfo.verificationTimer = setTimeout(() => {
				if (verificationPromiseResolved) return;
				log.warn(label, "Verification timed out.");
				verificationPromiseResolved = true;
				if (verificationCompletionResolver) verificationCompletionResolver();
			}, timeoutMs);
		}

		log.debug(
			label,
			"Waiting for verification process to complete (match, timeout, or exit)...",
		);
		await verificationCompletionPromise;
		log.debug(label, "Verification process completed.");

		if (dataListenerDisposable) dataListenerDisposable.dispose();
		if (exitListenerDisposable) exitListenerDisposable.dispose();
		if (processInfo.verificationTimer) {
			clearTimeout(processInfo.verificationTimer);
			processInfo.verificationTimer = undefined;
		}

		isVerified = patternMatched;
		if (isVerified) {
			log.info(label, "Verification successful (pattern matched).");
			addLogEntry(label, "Verification successful (pattern matched).");
		} else {
			const currentStatus = getProcessInfo(label)?.status;
			if (currentStatus === "verifying") {
				log.warn(
					label,
					"Verification failed (timeout or exit during verification). Setting status to error.",
				);
				addLogEntry(label, "Verification failed (timeout or exit).");
				updateProcessStatus(label, "error");
			} else {
				log.warn(
					label,
					`Verification failed, process status already changed to ${currentStatus}.`,
				);
				addLogEntry(
					label,
					`Verification failed, process already in state: ${currentStatus}`,
				);
			}
		}
	} else {
		log.info(label, "No verification pattern provided. Marking as running.");
		addLogEntry(label, "Status: running (no verification specified).");
		updateProcessStatus(label, "running");
		isVerified = true;
	}

	// --- Standard Log Handling ---
	processInfo.mainDataListenerDisposable = ptyProcess.onData((data: string) => {
		const currentProcessInfo = getProcessInfo(label);
		if (!currentProcessInfo) return; // Process might have been removed

		// Ensure buffer exists (initialize if somehow missing)
		currentProcessInfo.partialLineBuffer =
			(currentProcessInfo.partialLineBuffer || "") + data;

		let newlineIndex: number;
		// Process all complete lines in the buffer
		// Assign first, then check in the loop condition
		newlineIndex = currentProcessInfo.partialLineBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = currentProcessInfo.partialLineBuffer.substring(
				0,
				newlineIndex + 1,
			);
			currentProcessInfo.partialLineBuffer =
				currentProcessInfo.partialLineBuffer.substring(newlineIndex + 1);

			// Trim newline characters (\r\n or \n)
			const trimmedLine = line.replace(/\r?\n$/, "");

			if (trimmedLine) {
				// Check if line not empty after removing newline
				handleData(label, trimmedLine, "stdout"); // Process the complete line
			}
			// Re-assign for the next iteration of the loop
			newlineIndex = currentProcessInfo.partialLineBuffer.indexOf("\n");
		}
		// Remaining data in currentProcessInfo.partialLineBuffer is kept for the next chunk
	});

	// --- Exit/Error Handling ---
	processInfo.mainExitListenerDisposable = ptyProcess.onExit(
		({ exitCode, signal }) => {
			log.info(
				label,
				`[ExitHandler] Process exited. Code: ${exitCode}, Signal: ${signal}`,
			);

			// Get fresh info before calling handleExit
			const currentInfo = managedProcesses.get(label);
			// Call the imported handleExit
			handleExit(
				label,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		},
	);

	// --- Wait for logs to potentially settle after verification ---
	let infoForPayload: ProcessInfo | undefined = undefined; // Variable to hold the definitive info for payload

	if (["verifying", "running"].includes(getProcessInfo(label)?.status ?? "")) {
		await _waitForLogSettleOrTimeout(label, ptyProcess);

		const processInfoAfterSettle = getProcessInfo(label);
		if (processInfoAfterSettle) {
			const statusAfterSettle = processInfoAfterSettle.status;
			if (isVerified && statusAfterSettle === "verifying") {
				log.info(
					label,
					`Verification successful and logs settled (status=${statusAfterSettle}), updating status to running.`,
				);
				// *** Capture the returned updated object ***
				const updatedInfo = updateProcessStatus(label, "running");
				addLogEntry(label, "Status changed to running after verification.");

				// *** Use this updated info directly for payload ***
				infoForPayload = updatedInfo;
			} else {
				log.info(
					label,
					`Verification state: ${isVerified}, Status after settle: ${statusAfterSettle}. Not updating status to running.`,
				);
				// If not updated, fetch latest for payload
				infoForPayload = getProcessInfo(label);
			}
		} else {
			log.warn(label, "Process vanished during log settle wait.");
			// Process gone, ensure payload reflects error or vanished state
			infoForPayload = undefined;
		}
	} else {
		// If not verifying/running initially, just get the current state for the payload
		infoForPayload = getProcessInfo(label);
	}

	// --- Construct SUCCESS Payload ---
	// *** Use the infoForPayload object determined above ***
	if (!infoForPayload) {
		// Check if process vanished
		log.error(
			label,
			"Process info unavailable for constructing final success payload!",
		);
		return fail(textPayload("Process disappeared unexpectedly"));
	}

	const finalStatus = infoForPayload.status;
	log.info(label, `Final status for payload construction: ${finalStatus}`);

	// Initialize payload with common fields from infoForPayload
	const payload: z.infer<typeof StartSuccessPayloadSchema> = {
		label: infoForPayload.label,
		status: finalStatus,
		pid: infoForPayload.pid,
		command: infoForPayload.command,
		args: infoForPayload.args,
		cwd: infoForPayload.cwd,
		logs: formatLogsForResponse(
			infoForPayload.logs.map((log) => log.content),
			DEFAULT_RETURN_LOG_LINES,
		), // <-- Map logs and use correct constant
		monitoring_hint:
			infoForPayload.logFilePath && serverLogDirectory
				? `For status updates or more logs, use check_process_status('${infoForPayload.label}'). File logging enabled.`
				: `For status updates or recent logs, use check_process_status('${infoForPayload.label}'). File logging disabled.`,
		log_file_path:
			infoForPayload.logFilePath && serverLogDirectory
				? infoForPayload.logFilePath
				: null,
		tail_command:
			infoForPayload.logFilePath && serverLogDirectory
				? getTailCommand(infoForPayload.logFilePath)
				: null,
		exitCode: infoForPayload.exitCode,
		signal: infoForPayload.signal,
		message: "", // Populated below
		instructions: undefined, // Will be populated below
	};

	// --- Payload Message Construction ---
	let statusPart = `Process status: ${finalStatus}.`;
	if (finalStatus === "running" && verificationPattern && isVerified) {
		statusPart =
			"Process started and verification pattern matched. Final status: running.";
	} else if (finalStatus === "running" && !verificationPattern) {
		statusPart = "Process started. Final status: running.";
	} else if (finalStatus === "stopped") {
		statusPart = "Process started. Final status: stopped.";
	} else if (finalStatus === "error" && verificationPattern && !isVerified) {
		statusPart = `Process started but verification failed (${infoForPayload.verificationFailureReason ?? "unknown reason"}). Final status: error.`;
	} else if (finalStatus === "error") {
		statusPart = "Process started but failed. Final status: error.";
	}

	const instructionParts: string[] = [];
	// Generic instruction about clickable links
	instructionParts.push(
		"If any URLs (like http://localhost:...) appear in the logs above, please render them as clickable links.",
	);

	// Cursor-specific instruction for tailing logs
	if (infoForPayload.host === "cursor" && payload.tail_command) {
		instructionParts.push(
			`The process is logging output to a file. You can monitor it by running the following command in a separate background terminal: ${payload.tail_command}`,
		);
	}
	const instructionText =
		instructionParts.length > 0 ? `\\n\\n${instructionParts.join("\\n")}` : "";

	payload.message = `${statusPart}${instructionText}`.trim();
	// --- End Payload Message Construction ---

	log.info(
		label,
		`Returning success payload for start_process. Status: ${payload.status}, PID: ${payload.pid}, Logs returned: ${payload.logs.length}`,
	);

	// If final status is error/crashed, return failure, otherwise success
	if (["error", "crashed"].includes(finalStatus)) {
		const errorPayload: z.infer<typeof StartErrorPayloadSchema> = {
			error: payload.message ?? `Process ended with status: ${finalStatus}`, // <-- Use default value for error
			status: finalStatus,
			cwd: effectiveWorkingDirectory,
			error_type: "process_exit_error",
		};
		log.error(
			label,
			`start_process returning failure. Status: ${finalStatus}, Exit Code: ${payload.exitCode}, Signal: ${payload.signal}`,
		);
		return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
	}

	// Ensure success payload reflects stopped status if process exited cleanly during startup
	if (payload.status === "stopped" && payload.exitCode === 0) {
		log.info(
			label,
			"start_process returning success, but final status is stopped due to clean exit.",
		);
		return ok(textPayload(JSON.stringify(payload, null, 2)));
	}

	// If status is running, return standard success
	if (payload.status === "running") {
		return ok(textPayload(JSON.stringify(payload, null, 2)));
	}

	// Fallback: Should not happen if logic above is correct, but return failure if status is unexpected
	log.error(
		label,
		`start_process reached unexpected final state. Status: ${payload.status}`,
	);
	const fallbackErrorPayload: z.infer<typeof StartErrorPayloadSchema> = {
		error: `Process ended in unexpected state: ${payload.status}`,
		status: payload.status,
		cwd: effectiveWorkingDirectory,
		error_type: "unexpected_process_state",
	};
	return fail(textPayload(JSON.stringify(fallbackErrorPayload)));
}

/**
 * Internal function to stop a background process.
 * Handles both graceful termination (SIGTERM with fallback to SIGKILL) and forceful kill (SIGKILL).
 */
export async function _stopProcess(
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
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: initialProcessInfo.status,
			message: `Process already in terminal state: ${initialProcessInfo.status}.`,
			pid: initialProcessInfo.pid,
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
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: "Process found but has no active process handle or PID.",
			pid: initialProcessInfo.pid,
		};
		// Return failure as we couldn't perform the stop action
		return fail(textPayload(JSON.stringify(payload)));
	}

	// Mark that we initiated the stop and update status
	initialProcessInfo.stopRequested = true;
	updateProcessStatus(label, "stopping");

	let finalMessage = "";
	let finalStatus: string = initialProcessInfo.status; // Initialize with current status
	const processToKill = initialProcessInfo.process; // Store reference in case info changes
	const pidToKill = initialProcessInfo.pid; // Store PID for logging/payload

	try {
		if (force) {
			// --- Force Kill Logic (SIGKILL immediately) ---
			log.info(
				label,
				`Force stop requested. Sending SIGKILL to PID ${pidToKill}...`,
			);
			addLogEntry(label, "Sending SIGKILL...");
			await killPtyProcess(processToKill, label, "SIGKILL");
			// Note: The onExit handler (attached in _startProcess) will eventually update the status
			// to 'stopped' or 'crashed' via handleExit. We don't wait for it here.
			finalMessage = `Force stop requested. SIGKILL sent to PID ${pidToKill}.`;
			// We assume 'stopping' is the status until handleExit confirms otherwise
			finalStatus = "stopping";
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
				`Waiting ${STOP_WAIT_DURATION}ms for graceful shutdown...`,
			);
			await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_DURATION));

			// Check status *after* the wait
			const infoAfterWait = await checkAndUpdateProcessStatus(label);
			finalStatus = infoAfterWait?.status ?? "error"; // Get potentially updated status

			// Check if the process is still running (or stopping/starting/verifying/restarting)
			if (
				infoAfterWait &&
				["stopping", "running", "starting", "verifying", "restarting"].includes(
					infoAfterWait.status,
				)
			) {
				log.warn(
					label,
					`Process ${pidToKill} did not terminate after SIGTERM and ${STOP_WAIT_DURATION}ms wait. Sending SIGKILL.`,
				);
				addLogEntry(label, "Graceful shutdown timed out. Sending SIGKILL...");
				await killPtyProcess(processToKill, label, "SIGKILL"); // Use stored reference
				finalMessage = `Process ${pidToKill} did not terminate gracefully. SIGKILL sent.`;
				// Status remains 'stopping' until handleExit confirms otherwise
				finalStatus = "stopping";
			} else {
				finalMessage = `Process ${pidToKill} terminated gracefully after SIGTERM.`;
				log.info(label, finalMessage);
				addLogEntry(label, "Process terminated gracefully.");
				// Use the status determined after the wait (likely 'stopped' or 'crashed')
				finalStatus = infoAfterWait?.status ?? "stopped"; // Default to stopped if info disappeared
			}
		}
	} catch (error) {
		const errorMsg = `Error stopping process ${label} (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error stopping process: ${errorMsg}`);
		finalMessage = `Error stopping process: ${errorMsg}`;
		updateProcessStatus(label, "error"); // Ensure status is error on failure
		finalStatus = "error";
		// Construct failure payload and return fail()
		const errorPayload = {
			label,
			status: finalStatus,
			message: finalMessage,
			pid: pidToKill,
		};
		return fail(textPayload(JSON.stringify(errorPayload))); // Explicitly return fail
	}

	// --- Construct SUCCESS Payload ---
	// Always construct and return ok() unless an explicit fail() was returned above
	const payload: z.infer<typeof StopProcessPayloadSchema> = {
		label,
		status: finalStatus as ProcessStatus, // Use the determined final status (with type cast)
		message: finalMessage,
		pid: pidToKill, // Use the PID we attempted to stop
	};
	log.info(
		label,
		`Returning result for stop_process. Final status: ${payload.status}. PID: ${payload.pid}`,
	);
	return ok(textPayload(JSON.stringify(payload))); // Add final return path
}

// Function Definition for handleData (if it's supposed to be here)
// NOTE: If handleData is defined elsewhere, remove this. If it's used here, define it.
function handleData(label: string, data: string, source: "stdout" | "stderr") {
	const processInfo = getProcessInfo(label); // <-- Use getProcessInfo helper
	if (!processInfo) {
		log.warn(label, `[handleData] Received data for unknown process: ${label}`);
		return; // Exit if process not found
	}

	// Add the log entry to the managed process state
	addLogEntry(label, data); // Use addLogEntry from state.ts
}
