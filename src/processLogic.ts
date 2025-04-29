import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IDisposable, IPty } from "node-pty"; // Import only types if needed
import treeKill from "tree-kill";
import type { z } from "zod"; // Import zod
import {
	DEFAULT_LOG_LINES,
	LOG_SETTLE_DURATION_MS,
	OVERALL_LOG_WAIT_TIMEOUT_MS,
} from "./constants.js";
import { serverLogDirectory } from "./main.js"; // Import the log dir path
import { fail, ok, textPayload } from "./mcpUtils.js";
import { killPtyProcess, spawnPtyProcess, writeToPty } from "./ptyManager.js"; // Import new functions
import {
	addLogEntry,
	checkAndUpdateProcessStatus, // Renamed function
	handleExit, // Corrected type in state.ts handleExit
	managedProcesses, // Renamed map
	updateProcessStatus, // Renamed function
} from "./state.js";
import type { SendInputParams } from "./toolDefinitions.js"; // Import the schema type
import type {
	CallToolResult,
	LogEntry,
	ProcessInfo,
	ProcessStatus,
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
				return fail(
					textPayload(
						JSON.stringify({
							error: errorMsg,
							status: existing.status,
							error_type: "composite_label_conflict",
						}),
					),
				);
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
		if (currentInfo && currentInfo.status !== "verifying") {
			// Avoid double handling if verification exit listener ran
			handleExit(
				label,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		}
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
		DEFAULT_LOG_LINES,
	);

	log.info(
		label,
		`Returning result for start_process. Included ${logsToReturn.length} log lines. Status: ${finalStatus}.`,
	);

	// Determine if the overall operation should be considered successful for the caller
	// Generally, if it's starting, running, or verifying, it's okay.
	// If it crashed or errored during the settle/verification wait, it should fail.
	if (["starting", "running", "verifying"].includes(finalStatus)) {
		message = `Process is ${finalStatus}.`;
		if (finalStatus === "running")
			message += ` PID: ${currentInfoAfterWait.pid}`;
		if (finalStatus === "verifying") message += " Verification in progress...";

		// Define a more specific type (can be moved to types.ts later)
		interface StartSuccessPayload {
			label: string;
			message: string;
			status: ProcessStatus;
			pid: number | undefined;
			cwd: string;
			logs: string[];
			monitoring_hint: string;
			log_file_path?: string | null;
			tail_command?: string | null;
		}

		const successPayload: StartSuccessPayload = {
			label: label,
			message: message,
			status: finalStatus,
			pid: currentInfoAfterWait.pid,
			cwd: currentInfoAfterWait.cwd,
			logs: logsToReturn,
			monitoring_hint: `Process is ${finalStatus}. Use check_process_status with label "${label}" for updates.`,
		};
		if (currentInfoAfterWait.logFilePath) {
			successPayload.log_file_path = currentInfoAfterWait.logFilePath;
			successPayload.tail_command = `tail -f "${currentInfoAfterWait.logFilePath}"`;
		}
		return ok(textPayload(JSON.stringify(successPayload, null, 2)));
	}

	// Process ended up in a terminal state (stopped, crashed, error) during startup
	// Define error payload type
	interface StartErrorPayload {
		error: string;
		status: ProcessStatus;
		pid?: number | undefined;
		exitCode: number | null;
		signal: string | null;
		logs: string[];
		log_file_path?: string | null;
	}

	const errorMsg = `Process "${label}" failed to stabilize or exited during startup wait. Final status: ${finalStatus}`;
	log.error(label, errorMsg, {
		exitCode: currentInfoAfterWait.exitCode,
		signal: currentInfoAfterWait.signal,
	});
	logFileStream?.end(); // Close stream on startup failure

	const errorPayload: StartErrorPayload = {
		error: errorMsg,
		status: finalStatus,
		pid: currentInfoAfterWait.pid,
		exitCode: currentInfoAfterWait.exitCode,
		signal: currentInfoAfterWait.signal,
		logs: logsToReturn,
	};
	if (currentInfoAfterWait.logFilePath) {
		errorPayload.log_file_path = currentInfoAfterWait.logFilePath;
	}
	return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
}

/**
 * Internal function to stop a background process.
 * Handles both graceful termination (SIGTERM) and forceful kill (SIGKILL).
 */
export async function _stopProcess(
	label: string,
	force = false,
): Promise<CallToolResult> {
	log.info(label, `Stopping process... Force: ${force}`);
	// Fetch latest status and process info
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		const msg = `Process with label "${label}" not found.`;
		log.warn(label, msg);
		return ok(textPayload(msg)); // Not an error if already gone
	}

	if (!processInfo.process || !processInfo.pid) {
		const msg = `Process "${label}" has no active PTY instance or PID (Status: ${processInfo.status}). Cannot stop.`;
		log.warn(label, msg);
		// Consider if this should be an error? For now, treat as already stopped/invalid state.
		return ok(textPayload(msg));
	}

	const pidToKill = processInfo.pid;
	const ptyToKill = processInfo.process;
	const signal = force ? "SIGKILL" : "SIGTERM";

	updateProcessStatus(label, "stopping");
	addLogEntry(label, `Stopping process with ${signal}...`);

	try {
		log.info(label, `Attempting to kill process tree for PID: ${pidToKill}`);
		await killProcessTree(pidToKill);
		log.info(
			label,
			`Successfully sent signal to process tree for PID: ${pidToKill}`,
		);
		// Even after tree-kill, explicitly kill the PTY process to ensure it cleans up
		// Use ptyManager function
		killPtyProcess(ptyToKill, label, signal);

		// Wait briefly for potential exit event to fire and update status
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Re-check status after attempting kill
		const finalStatusInfo = managedProcesses.get(label);
		const finalStatus = finalStatusInfo?.status ?? "unknown";
		const exitCode = finalStatusInfo?.exitCode;
		const exitSignal = finalStatusInfo?.signal;

		const msg = `Stop signal (${signal}) sent to process "${label}" (PID: ${pidToKill}). Final status: ${finalStatus}. Exit Code: ${exitCode}, Signal: ${exitSignal}`; // Add exit details
		addLogEntry(label, `Stop signal sent. Final status: ${finalStatus}.`);
		log.info(label, msg);
		return ok(
			textPayload(
				JSON.stringify({
					message: msg,
					status: finalStatus,
					exitCode: exitCode,
					signal: exitSignal,
				}),
			),
		);
	} catch (error: unknown) {
		const errorMsg = `Error stopping process "${label}" (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg, error);
		addLogEntry(label, `Error: ${errorMsg}`);
		// Attempt to force kill the direct PTY process if the tree-kill failed
		try {
			log.warn(label, "Tree kill failed, attempting direct PTY kill...");
			// Use ptyManager function
			killPtyProcess(ptyToKill, label, "SIGKILL");
		} catch (ptyKillError) {
			log.error(
				label,
				"Failed to force kill PTY process after tree kill error",
				ptyKillError,
			);
		}
		// Update status to error if stopping failed badly
		updateProcessStatus(label, "error");
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					error_type: "stop_failed",
				}),
			),
		);
	}
}

/**
 * Internal function to send input to a running background process.
 */
export async function _sendInput(
	params: z.infer<typeof SendInputParams>, // Use inferred type from Zod schema
): Promise<CallToolResult> {
	const { label, input, append_newline } = params;
	const processInfo = managedProcesses.get(label);

	if (!processInfo || !processInfo.process) {
		const errorMsg = `Process "${label}" not found or has no active PTY instance.`;
		log.error(label, errorMsg);
		return fail(textPayload(errorMsg));
	}

	if (!["running", "verifying"].includes(processInfo.status)) {
		const errorMsg = `Process "${label}" is not in a running state (status: ${processInfo.status}). Cannot send input.`;
		log.error(label, errorMsg);
		return fail(textPayload(errorMsg));
	}

	const dataToSend = append_newline ? `${input}\r` : input;
	log.info(label, `Sending input to process: ${dataToSend.length} chars`);

	try {
		// Use ptyManager function
		if (writeToPty(processInfo.process, dataToSend, label)) {
			return ok(textPayload(`Input sent to process "${label}".`));
		}
		// Error already logged by writeToPty
		const errorMsg = `Failed to send input to process "${label}".`;
		return fail(textPayload(errorMsg));
	} catch (error: unknown) {
		// This catch block might be redundant
		const errorMsg = `Error sending input to process "${label}": ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg, error);
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: processInfo.status,
					error_type: "send_input_failed",
				}),
			),
		);
	}
}
