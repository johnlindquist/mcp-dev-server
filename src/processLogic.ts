import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IDisposable, IPty } from "node-pty"; // Import only types if needed
import treeKill from "tree-kill";
import type { z } from "zod"; // Import zod
import {
	LOG_SETTLE_DURATION_MS,
	OVERALL_LOG_WAIT_TIMEOUT_MS,
} from "./constants.js";
import { serverLogDirectory } from "./main.js"; // Import the log dir path
import { fail, ok, textPayload } from "./mcpUtils.js";
import { handleExit } from "./processLifecycle.js"; // Import handleExit from new location
import { checkAndUpdateProcessStatus } from "./processSupervisor.js"; // Import from supervisor
import { killPtyProcess, spawnPtyProcess, writeToPty } from "./ptyManager.js"; // Import new functions
import { addLogEntry, managedProcesses, updateProcessStatus } from "./state.js";
import type { SendInputParams } from "./toolDefinitions.js"; // Import the schema type
import type {
	CallToolResult,
	LogEntry,
	ProcessInfo,
	SendInputPayloadSchema,
	StartErrorPayloadSchema,
	StartSuccessPayloadSchema,
	StopProcessPayloadSchema,
} from "./types.ts"; // Renamed types
import { formatLogsForResponse, log } from "./utils.js";
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
			if (dataListenerDisposable) dataListenerDisposable.dispose();
			if (exitListenerDisposable) exitListenerDisposable.dispose(); // Dispose exit listener too
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

		// Attach a *temporary* data listener
		dataListenerDisposable = ptyProcess.onData((data: string) => {
			// We don't need to process the data here, just reset the timer
			resetSettleTimer();
		});

		// Attach a temporary exit listener
		exitListenerDisposable = ptyProcess.onExit(onProcessExit);

		// Start the timers
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
		`Starting process... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", isRestart: ${isRestart}`,
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
			const safeFilename = sanitizeLabelForFilename(label);
			logFilePath = path.join(serverLogDirectory, safeFilename);

			// Create/Open the stream in append mode. Truncate if restarting.
			const fileExists = fs.existsSync(logFilePath);
			const flags = isRestart && fileExists ? "w" : "a"; // 'w' (write/truncate) on restart, 'a' (append) otherwise

			logFileStream = fs.createWriteStream(logFilePath, {
				flags: flags,
				encoding: "utf8",
			});

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
			log.info(
				label,
				`Logging process output to: ${logFilePath} (mode: ${flags})`,
			);
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
		log.debug(label, `Attempting to spawn PTY with shell: ${shell}`);
		ptyProcess = spawnPtyProcess(
			shell,
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
		lastCrashTime: existingProcess?.lastCrashTime, // Preserve crash time on restart
		restartAttempts: existingProcess?.restartAttempts, // Preserve attempts on restart
		verificationPattern,
		verificationTimeoutMs: verificationTimeoutMs ?? null, // Default to null (disabled)
		verificationTimer: undefined,
		retryDelayMs: retryDelayMs ?? null, // Default to null (disabled)
		maxRetries: maxRetries ?? 0, // Default to 0 (disabled)
		logFilePath: logFilePath, // <-- STORED
		logFileStream: logFileStream, // <-- STORED
	};
	managedProcesses.set(label, processInfo);
	updateProcessStatus(label, "starting"); // Ensure status is set via the function
	addLogEntry(
		label,
		`Process spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// --- Start the command in the PTY ---
	try {
		log.debug(label, `Writing command to PTY: ${fullCommand}`);
		// Use ptyManager function
		if (!writeToPty(ptyProcess, `${fullCommand}\r`, label)) {
			// Handle write failure - already logged by writeToPty
			updateProcessStatus(label, "error");
			addLogEntry(label, "Error: Failed to write initial command to PTY");
			try {
				killPtyProcess(ptyProcess, label, "SIGKILL");
			} catch (killError) {
				log.error(
					label,
					"Failed to kill PTY process after write error",
					killError,
				);
			}
			return fail(
				textPayload(
					JSON.stringify({
						error: "Failed to write initial command to PTY",
						status: "error",
						error_type: "pty_write_failed",
					}),
				),
			);
		}
		log.debug(label, "Command written to PTY successfully.");
	} catch (error: unknown) {
		// This catch block might be redundant if writeToPty handles its errors
		const errorMsg = `Failed to write command to PTY process ${ptyProcess.pid}: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		updateProcessStatus(label, "error");
		addLogEntry(label, `Error: ${errorMsg}`);
		try {
			killPtyProcess(ptyProcess, label, "SIGKILL");
		} catch (killError) {
			log.error(
				label,
				"Failed to kill PTY process after write error",
				killError,
			);
		}
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					error_type: "pty_write_failed",
				}),
			),
		);
	}

	// --- Verification Logic ---
	let isVerified = !verificationPattern;
	let verificationCompletionPromise: Promise<void> | null = null;

	if (verificationPattern) {
		const timeoutMessage =
			processInfo.verificationTimeoutMs !== null
				? `Timeout ${processInfo.verificationTimeoutMs}ms`
				: "Timeout disabled";
		log.info(
			label,
			`Verification required: Pattern /${verificationPattern.source}/, ${timeoutMessage}`,
		);
		addLogEntry(label, "Status: verifying. Waiting for pattern or timeout.");
		updateProcessStatus(label, "verifying");

		const dataListener = (data: string): void => {
			try {
				if (verificationPattern.test(data)) {
					if (processInfo.status === "verifying") {
						// Check status before completing
						verificationCompletionPromise = Promise.resolve();
					} else {
						log.warn(
							label,
							`Verification pattern matched, but status is now ${processInfo.status}. Ignoring match.`,
						);
						// Listener disposed below if necessary
						verificationCompletionPromise = null;
					}
				}
			} catch (e: unknown) {
				log.error(label, "Error during verification data processing", e);
				if (processInfo.status === "verifying") {
					verificationCompletionPromise = Promise.resolve();
				}
				// Listener disposed in completeVerification
			}
		};
		ptyProcess.onData(dataListener);

		// Only set timeout if verificationTimeoutMs is provided (not null)
		if (processInfo.verificationTimeoutMs !== null) {
			const timeoutMs = processInfo.verificationTimeoutMs;
			verificationCompletionPromise = new Promise<void>(
				(resolveVerification) => {
					setTimeout(() => {
						if (processInfo.status === "verifying") {
							// Check status before timeout failure
							verificationCompletionPromise = Promise.resolve();
						} else {
							log.warn(
								label,
								`Verification timeout occurred, but status is now ${processInfo.status}. Ignoring timeout.`,
							);
							// Listener might still need cleanup if process exited without data match
							verificationCompletionPromise = null;
						}
						resolveVerification();
					}, timeoutMs);
					// Store the timer in processInfo as well for external access/clearing (e.g., in stopProcess)
					processInfo.verificationTimer = setTimeout(() => {
						if (processInfo.status === "verifying") {
							// Check status before timeout failure
							verificationCompletionPromise = Promise.resolve();
						} else {
							log.warn(
								label,
								`Verification timeout occurred, but status is now ${processInfo.status}. Ignoring timeout.`,
							);
							// Listener might still need cleanup if process exited without data match
							verificationCompletionPromise = null;
						}
					}, timeoutMs);
				},
			);
		}

		// Ensure listener is removed on exit if verification didn't complete
		ptyProcess.onExit(() => {
			// Use onExit, store disposable
			if (processInfo.status === "verifying") {
				log.warn(label, "Process exited during verification phase.");
				verificationCompletionPromise = null;
			}
			// Listener disposed in completeVerification or earlier
		});
	} else {
		// No verification pattern, consider running after a short delay or immediately
		// For simplicity, let's mark as running immediately if no pattern
		log.info(label, "No verification pattern provided. Marking as running.");
		addLogEntry(label, "Status: running (no verification specified).");
		updateProcessStatus(label, "running");
		isVerified = true;
	}

	// --- Standard Log Handling ---
	const mainDataDisposable = ptyProcess.onData((data: string) => {
		const lines = data.split(/\r?\n/);
		for (const line of lines) {
			if (line.trim()) {
				addLogEntry(label, line); // Store raw log line
			}
		}
	});

	// --- Exit/Error Handling ---
	const mainExitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
		log.debug(label, "Main onExit handler triggered.", { exitCode, signal });
		mainDataDisposable.dispose(); // Dispose data listener on exit

		// Get fresh info before calling handleExit
		const currentInfo = managedProcesses.get(label);
		// Call the imported handleExit
		handleExit(
			label,
			exitCode ?? null,
			signal !== undefined ? String(signal) : null,
		);
		mainExitDisposable.dispose(); // Dispose self
	});

	// --- Wait for Initial Logs to Settle ---
	const settleResult = await _waitForLogSettleOrTimeout(label, ptyProcess);
	// --- End Wait for Initial Logs to Settle ---

	// If verification was started, wait for it to complete as well
	if (verificationCompletionPromise) {
		log.debug(
			label,
			"Waiting for verification process to complete (if running)...",
		);
		log.debug(label, "Verification completion awaited (or skipped).");
	}

	// --- Final Return ---
	const currentInfoAfterWait = await checkAndUpdateProcessStatus(label); // Use check function

	if (!currentInfoAfterWait) {
		// Process might have exited very quickly and been removed, or internal error
		const errorMsg = `Internal error: Process info for "${label}" not found after startup wait.`;
		log.error(label, errorMsg);
		return fail(
			textPayload(JSON.stringify({ error: errorMsg, status: "not_found" })), // Use not_found status
		);
	}

	// Determine the final status and message
	const finalStatus = currentInfoAfterWait.status;
	let message = `Process "${label}" started (PID: ${currentInfoAfterWait.pid}). Status: ${finalStatus}.`;

	if (settleResult.settled) {
		message += ` Initial logs settled after a ${LOG_SETTLE_DURATION_MS}ms pause.`;
	} else if (settleResult.timedOut) {
		message += ` Initial log settling wait timed out after ${OVERALL_LOG_WAIT_TIMEOUT_MS}ms.`;
	}
	// Add verification status if applicable (needs integration with verification promise result)
	// if (verificationSucceeded) message += " Verification successful.";
	// else if (verificationFailed) message += " Verification failed.";

	message +=
		" This indicates initial output stability, not necessarily task completion. Use check_process_status for updates.";

	const logsToReturn = formatLogsForResponse(
		currentInfoAfterWait.logs.map((l: LogEntry) => l.content),
		currentInfoAfterWait.logs.length,
	);

	log.info(
		label,
		`Returning result for start_process. Included ${logsToReturn.length} log lines. Status: ${finalStatus}.`,
	);

	// Updated monitoring hint
	let monitoringHint = `Call check_process_status('${label}') to stream logs or verify state.`;
	if (logFilePath) {
		monitoringHint += ` Or tail the log file: tail -f "${logFilePath}"`;
	}

	// Use the Zod schema type
	const successPayload: z.infer<typeof StartSuccessPayloadSchema> = {
		label,
		message: `Process "${label}" started with status: ${finalStatus}.`,
		status: finalStatus,
		pid: currentInfoAfterWait.pid,
		command: command,
		args: args,
		cwd: effectiveWorkingDirectory,
		logs: formatLogsForResponse(logsToReturn, logsToReturn.length),
		monitoring_hint: monitoringHint,
		log_file_path: logFilePath,
		tail_command: logFilePath ? `tail -f "${logFilePath}"` : null,
		info_message: message,
		exitCode: currentInfoAfterWait.exitCode ?? null,
		signal: currentInfoAfterWait.signal ?? null,
	};

	// If final status is error/crashed, return failure, otherwise success
	if (["error", "crashed"].includes(finalStatus)) {
		const errorPayload: z.infer<typeof StartErrorPayloadSchema> = {
			error: message || `Process ended with status ${finalStatus}. Check logs.`,
			status: finalStatus,
			pid: currentInfoAfterWait.pid,
			cwd: effectiveWorkingDirectory,
			error_type:
				finalStatus === "crashed" ? "process_crashed" : "startup_error",
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}

	return ok(textPayload(JSON.stringify(successPayload)));
}

/**
 * Internal function to stop a background process.
 * Handles both graceful termination (SIGTERM) and forceful kill (SIGKILL).
 */
export async function _stopProcess(
	label: string,
	force = false,
): Promise<CallToolResult> {
	log.info(label, `Stop requested for process "${label}". Force: ${force}`);
	addLogEntry(label, `Stop requested. Force: ${force}`);

	const processInfo = await checkAndUpdateProcessStatus(label); // Refresh status

	if (!processInfo) {
		return fail(
			textPayload(JSON.stringify({ error: `Process "${label}" not found.` })),
		);
	}

	if (
		processInfo.status === "stopped" ||
		processInfo.status === "crashed" ||
		processInfo.status === "error"
	) {
		log.info(
			label,
			`Process already in terminal state: ${processInfo.status}.`,
		);
		// Use StopProcessPayloadSchema
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: processInfo.status,
			message: `Process already in terminal state: ${processInfo.status}.`,
			pid: processInfo.pid,
		};
		return ok(textPayload(JSON.stringify(payload)));
	}

	if (!processInfo.process || typeof processInfo.pid !== "number") {
		log.warn(
			label,
			`Process "${label}" found but has no active process handle or PID. Marking as error.`,
		);
		updateProcessStatus(label, "error");
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: "Process found but has no active process handle or PID.",
			pid: processInfo.pid,
		};
		return fail(textPayload(JSON.stringify(payload)));
	}

	processInfo.stopRequested = true; // Mark that we initiated the stop
	updateProcessStatus(label, "stopping");

	try {
		await killPtyProcess(label, processInfo.pid, force);
		// Status might have been updated by handleExit already
		const finalInfo = managedProcesses.get(label);
		const finalStatus = finalInfo?.status ?? "stopped"; // Assume stopped if info gone
		const message = `Stop signal sent successfully (Force: ${force}). Final status: ${finalStatus}.`;
		log.info(label, message);
		addLogEntry(label, `Stop signal sent. Force: ${force}.`);

		// Use StopProcessPayloadSchema
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: finalStatus,
			message: message,
			pid: finalInfo?.pid, // Use final PID if available
		};
		return ok(textPayload(JSON.stringify(payload)));
	} catch (error) {
		const errorMsg = `Failed to stop process "${label}": ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error during stop: ${errorMsg}`);
		updateProcessStatus(label, "error"); // Mark as error on failure

		// Use StopProcessPayloadSchema for error reporting
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: errorMsg,
			pid: processInfo.pid, // PID before stop attempt
		};
		return fail(textPayload(JSON.stringify(payload)));
	}
}

/**
 * Internal function to send input to a running background process.
 */
export async function _sendInput(
	params: z.infer<typeof SendInputParams>, // Use inferred type from Zod schema
): Promise<CallToolResult> {
	const { label, input, append_newline } = params;

	const processInfo = await checkAndUpdateProcessStatus(label); // Refresh status

	if (!processInfo) {
		return fail(textPayload(`Process "${label}" not found.`));
	}

	if (!processInfo.process || !processInfo.pid) {
		return fail(
			textPayload(`Process "${label}" is not currently running or accessible.`),
		);
	}

	if (processInfo.status !== "running" && processInfo.status !== "verifying") {
		return fail(
			textPayload(
				`Process "${label}" is not in a state to receive input (status: ${processInfo.status}).`,
			),
		);
	}

	try {
		await writeToPty(label, processInfo.process, input, append_newline);
		log.info(label, `Sent input to process "${label}".`);
		addLogEntry(label, `Input sent: ${JSON.stringify(input)}`);

		// Use SendInputPayloadSchema
		const payload: z.infer<typeof SendInputPayloadSchema> = {
			label,
			message: "Input sent successfully.",
		};
		return ok(textPayload(JSON.stringify(payload)));
	} catch (error) {
		const errorMsg = `Failed to send input to process "${label}": ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error sending input: ${errorMsg}`);
		return fail(textPayload(errorMsg));
	}
}
