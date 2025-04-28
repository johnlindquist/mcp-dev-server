import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as pty from "node-pty";
import type { IDisposable } from "node-pty"; // Import IDisposable
import treeKill from "tree-kill";
import type { z } from "zod"; // Import zod
import {
	DEFAULT_LOG_LINES,
	LOG_SETTLE_DURATION_MS,
	OVERALL_LOG_WAIT_TIMEOUT_MS,
} from "./constants.js";
import {
	addLogEntry,
	checkAndUpdateProcessStatus, // Renamed function
	handleExit, // Corrected type in state.ts handleExit
	managedProcesses, // Renamed map
	updateProcessStatus, // Renamed function
} from "./state.js";
import type { SendInputParams } from "./toolDefinitions.js"; // Import the schema type
import { fail, ok, textPayload } from "./types.js";
import type { CallToolResult, ProcessInfo, ProcessStatus } from "./types.ts"; // Renamed types
import { formatLogsForResponse, log } from "./utils.js";

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
	ptyProcess: pty.IPty,
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
	let ptyProcess: pty.IPty;
	const fullCommand = [command, ...args].join(" "); // Combine command and args for PTY

	try {
		ptyProcess = pty.spawn(shell, [], {
			name: "xterm-color",
			cols: 80,
			rows: 30,
			cwd: effectiveWorkingDirectory,
			env: {
				...process.env,
				FORCE_COLOR: "1",
				MCP_PROCESS_LABEL: label, // Updated Env Var Name
			},
			encoding: "utf8",
		});
	} catch (error: unknown) {
		const errorMsg = `Failed to spawn PTY process: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
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
			});
		}
		updateProcessStatus(label, "error");
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					cwd: effectiveWorkingDirectory,
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
	};
	managedProcesses.set(label, processInfo);
	updateProcessStatus(label, "starting"); // Ensure status is set via the function
	addLogEntry(
		label,
		`Process spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// Write command to PTY shell
	ptyProcess.write(`${fullCommand}\r`); // Send command + Enter

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
		currentInfoAfterWait.logs.map((l) => l.content),
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
		return ok(
			textPayload(
				JSON.stringify(
					{
						label: label,
						message: message, // Use the detailed message
						status: finalStatus,
						pid: currentInfoAfterWait.pid,
						cwd: currentInfoAfterWait.cwd,
						logs: logsToReturn,
						monitoring_hint: `Process is ${finalStatus}. Use check_process_status with label "${label}" for updates.`,
					},
					null,
					2,
				),
			),
		);
	}

	// Process ended up in a terminal state (stopped, crashed, error) during startup
	const errorMsg = `Process "${label}" failed to stabilize or exited during startup wait. Final status: ${finalStatus}`;
	log.error(label, errorMsg, {
		exitCode: currentInfoAfterWait.exitCode,
		signal: currentInfoAfterWait.signal,
	});
	return fail(
		textPayload(
			JSON.stringify(
				{
					error: errorMsg,
					status: finalStatus,
					pid: currentInfoAfterWait.pid,
					exitCode: currentInfoAfterWait.exitCode,
					signal: currentInfoAfterWait.signal,
					logs: logsToReturn, // Include logs collected so far
				},
				null,
				2,
			),
		),
	);
}

/**
 * Internal function to stop a background process.
 * Handles both graceful termination (SIGTERM) and forceful kill (SIGKILL).
 */
export async function _stopProcess(
	label: string,
	force = false,
): Promise<CallToolResult> {
	log.info(label, `Attempting to stop process "${label}" (force=${force})...`);
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found.`,
					status: "not_found",
					error_type: "not_found",
				}),
			),
		);
	}

	if (
		["stopped", "crashed", "error"].includes(processInfo.status) &&
		!processInfo.pid
	) {
		log.warn(
			label,
			`Process is already terminal (${processInfo.status}) with no active PID.`,
		);
		return ok(
			textPayload(
				JSON.stringify({
					message: `Process "${label}" was already ${processInfo.status}.`,
					status: processInfo.status,
					pid: processInfo.pid, // null or undefined
					cwd: processInfo.cwd,
					exitCode: processInfo.exitCode,
					signal: processInfo.signal,
					// Map LogEntry[] to string[]
					logs: formatLogsForResponse(
						processInfo.logs.map((l) => l.content),
						DEFAULT_LOG_LINES,
					),
				}),
			),
		);
	}

	if (!processInfo.process || !processInfo.pid) {
		const errorMsg = `Cannot stop process: handle or PID is missing despite status being ${processInfo.status}. Attempting to mark as error.`;
		log.error(label, errorMsg);
		updateProcessStatus(label, "error"); // Mark as error
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: "error",
					error_type: "missing_handle_on_stop",
					pid: processInfo.pid,
					cwd: processInfo.cwd,
					// Map LogEntry[] to string[]
					logs: formatLogsForResponse(
						processInfo.logs.map((l) => l.content),
						DEFAULT_LOG_LINES,
					),
				}),
			),
		);
	}

	// Clear verification timer if stopping during verification
	if (processInfo.verificationTimer) {
		clearTimeout(processInfo.verificationTimer);
		processInfo.verificationTimer = undefined;
		log.info(label, "Cleared verification timer during stop request.");
	}

	const signal: "SIGTERM" | "SIGKILL" = force ? "SIGKILL" : "SIGTERM";
	log.info(label, `Sending ${signal} to process PID ${processInfo.pid}...`);
	addLogEntry(label, `Sending ${signal} signal.`);
	updateProcessStatus(label, "stopping");

	try {
		// Use the node-pty kill method
		processInfo.process.kill(signal);
	} catch (error: unknown) {
		const errorMsg = `Failed to send ${signal} to PID ${processInfo.pid}: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error sending signal: ${errorMsg}`);

		// Check status again after failed signal
		const postSignalCheck = await checkAndUpdateProcessStatus(label);
		const currentStatus = postSignalCheck?.status ?? processInfo.status;
		const finalError = `Failed to send ${signal}. Status: ${currentStatus}. Error: ${errorMsg}`;

		if (currentStatus !== "stopped" && currentStatus !== "crashed") {
			updateProcessStatus(label, "error"); // Mark as error if signal failed and not already terminal
		}

		return fail(
			textPayload(
				JSON.stringify({
					error: finalError,
					status: postSignalCheck?.status ?? "error", // Reflect updated status
					error_type: "signal_send_failed",
					pid: processInfo.pid,
					cwd: processInfo.cwd,
					// Map LogEntry[] to string[]
					logs: formatLogsForResponse(
						(postSignalCheck?.logs ?? processInfo.logs).map((l) => l.content),
						DEFAULT_LOG_LINES,
					),
				}),
			),
		);
	}

	// Stop initiated, let onExit handler manage the final state transition.
	// Return an intermediate success indicating the stop command was sent.

	const currentProcessInfo = managedProcesses.get(label) as ProcessInfo; // Should exist
	return ok(
		textPayload(
			JSON.stringify(
				{
					message: `Stop signal (${signal}) sent to process "${label}" (PID: ${currentProcessInfo.pid}).`,
					status: currentProcessInfo.status, // Should be 'stopping'
					pid: currentProcessInfo.pid,
					cwd: currentProcessInfo.cwd,
					// Map LogEntry[] to string[]
					logs: formatLogsForResponse(
						currentProcessInfo.logs.map((l) => l.content),
						DEFAULT_LOG_LINES,
					),
					monitoring_hint:
						"Process is stopping. Use check_process_status for final status.",
				},
				null,
				2,
			),
		),
	);
}

/**
 * Internal function to send input to a running background process.
 */
export async function _sendInput(
	params: z.infer<typeof SendInputParams>, // Use inferred type from Zod schema
): Promise<CallToolResult> {
	const { label, input, append_newline } = params;
	log.info(label, `Attempting to send input to process "${label}"...`);

	// Use checkAndUpdateProcessStatus to get potentially updated info
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found.`,
					status: "not_found",
					error_type: "not_found",
				}),
			),
		);
	}

	// Check if the process is in a state that can receive input
	const allowedStates: ProcessStatus[] = ["running", "verifying", "starting"];
	if (!allowedStates.includes(processInfo.status)) {
		const errorMsg = `Process "${label}" is not in a state to receive input. Current status: ${processInfo.status}. Required status: ${allowedStates.join(" or ")}.`;
		log.warn(label, errorMsg);
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: processInfo.status,
					error_type: "invalid_state_for_input",
					pid: processInfo.pid,
					cwd: processInfo.cwd,
				}),
			),
		);
	}

	if (!processInfo.process) {
		const errorMsg = `Cannot send input: Process handle is missing for "${label}" despite status being ${processInfo.status}.`;
		log.error(label, errorMsg);
		// Consider updating status to 'error' here? Might be too aggressive.
		return fail(
			textPayload(
				JSON.stringify({
					error: errorMsg,
					status: processInfo.status, // Report current status
					error_type: "missing_handle_on_input",
					pid: processInfo.pid,
					cwd: processInfo.cwd,
				}),
			),
		);
	}

	try {
		const dataToSend = input + (append_newline ? "\\r" : "");
		log.debug(label, `Writing to PTY: "${dataToSend.replace("\\r", "\r")}"`); // Log escaped newline

		// Send the input via the node-pty process handle
		processInfo.process.write(dataToSend);

		// Log the action internally for the process
		const logMessage = `Input sent: "${input}"${append_newline ? " (with newline)" : ""}`;
		addLogEntry(label, logMessage);
		log.info(label, logMessage);

		return ok(
			textPayload(
				JSON.stringify(
					{
						message: `Input successfully sent to process "${label}".`,
						input_sent: input,
						newline_appended: append_newline,
						status: processInfo.status, // Return current status after sending
						pid: processInfo.pid,
					},
					null,
					2,
				),
			),
		);
	} catch (error: unknown) {
		const errorMsg = `Failed to write input to process "${label}": ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg, error);
		addLogEntry(label, `Error sending input: ${errorMsg}`);
		// Don't change process status here, as the process itself might still be running
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: errorMsg,
						status: processInfo.status, // Report status at time of error
						error_type: "write_failed",
						pid: processInfo.pid,
					},
					null,
					2,
				),
			),
		);
	}
}
