import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { IDisposable, IPty } from "node-pty"; // Import only types if needed
import treeKill from "tree-kill";
import type { z } from "zod"; // Import zod
import {
	LOG_SETTLE_DURATION_MS,
	OVERALL_LOG_WAIT_TIMEOUT_MS,
	STOP_WAIT_DURATION,
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
	ProcessStatus,
	SendInputPayloadSchema,
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
		// Use ptyManager function - corrected args
		if (!processInfo.process) {
			log.error(label, "Cannot write command to PTY: process object is null.");
			updateProcessStatus(label, "error");
			addLogEntry(
				label,
				"Error: Failed to write initial command, PTY process object missing.",
			);
			return fail(
				textPayload(
					JSON.stringify({
						error: "PTY process object missing",
						status: "error",
						error_type: "internal_error",
					}),
				),
			);
		}
		if (!writeToPty(processInfo.process, `${fullCommand}\r`, label)) {
			// Correct call
			// Handle write failure - already logged by writeToPty
			updateProcessStatus(label, "error");
			addLogEntry(label, "Error: Failed to write initial command to PTY");
			// Failed write is critical, attempt cleanup
			try {
				if (processInfo.process) {
					// Check if process exists before killing
					killPtyProcess(processInfo.process, label, "SIGKILL"); // Correct call
				}
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
		// Failed write is critical, attempt cleanup
		try {
			if (processInfo.process) {
				// Check if process exists before killing
				killPtyProcess(processInfo.process, label, "SIGKILL"); // Correct call
			}
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
			processInfo.verificationTimeoutMs !== undefined
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

		// Only set timeout if verificationTimeoutMs is provided (not undefined)
		if (processInfo.verificationTimeoutMs !== undefined) {
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
	processInfo.mainDataListenerDisposable = ptyProcess.onData((data: string) => {
		log.debug(
			label,
			`[processLogic._startProcess.onData RAW] Received ${data.length} chars: ${JSON.stringify(data)}`,
		);

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

			log.debug(
				label,
				`[processLogic._startProcess.onData BUFFER] Extracted line: ${JSON.stringify(trimmedLine)}`,
			);

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
			log.debug(label, "Main onExit handler triggered.", { exitCode, signal });
			log.debug(
				label,
				`[processLogic._startProcess.mainExitListener] Exited with code ${exitCode}, signal ${signal}. Disposing mainDataListener.`,
			);

			// Get the CURRENT process info to dispose the correct listeners
			const currentProcessInfo = managedProcesses.get(label);
			if (currentProcessInfo) {
				if (currentProcessInfo.mainDataListenerDisposable) {
					log.debug(
						label,
						"[processLogic._startProcess.mainExitListener] Found mainDataListenerDisposable. Disposing now...",
					);
					log.debug(label, "Disposing main data listener from onExit handler.");
					currentProcessInfo.mainDataListenerDisposable.dispose();
					currentProcessInfo.mainDataListenerDisposable = undefined; // Clear disposed listener
				} else {
					log.warn(
						label,
						"[processLogic._startProcess.mainExitListener] mainDataListenerDisposable was already undefined before explicit disposal.",
					);
				}
				if (currentProcessInfo.mainExitListenerDisposable) {
					log.debug(
						label,
						"Disposing main exit listener (self) from onExit handler.",
					);
					// Dispose self - important to prevent multiple calls if exit event fires again somehow
					currentProcessInfo.mainExitListenerDisposable.dispose();
					currentProcessInfo.mainExitListenerDisposable = undefined;
				}
			} else {
				log.warn(
					label,
					"ProcessInfo not found during onExit handling, cannot dispose listeners.",
				);
			}

			log.info(
				label,
				`[ExitHandler] Process exited. Code: ${exitCode}, Signal: ${signal}`,
			); // Added log

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

	// --- Wait for Verification Completion (if applicable) ---
	if (verificationCompletionPromise) {
		log.debug(
			label,
			"Waiting for verification process to complete (match, timeout, or exit)...",
		);
		await verificationCompletionPromise; // Wait for the verification listener/timeout to resolve
		log.debug(label, "Verification process completed.");
		// Re-fetch info as status might have changed during verification wait
		const infoAfterVerification = managedProcesses.get(label);
		if (infoAfterVerification) {
			log.debug(
				label,
				`Status after verification wait: ${infoAfterVerification.status}`,
			);
			processInfo.status = infoAfterVerification.status; // Update local status
		} else {
			log.warn(label, "ProcessInfo missing after verification wait.");
			// Handle potential error? For now, proceed might lead to failure later.
		}
	}
	// --- End Verification Wait ---

	// --- Wait for settling or timeout ---
	const { settled, timedOut } = await _waitForLogSettleOrTimeout(
		label,
		ptyProcess,
	);
	// --- End Wait ---

	// --- Determine Final Status and Message ---
	const currentInfoAfterWait = managedProcesses.get(label);
	if (!currentInfoAfterWait) {
		// This should ideally not happen if the process was just started
		log.error(label, "Process info unexpectedly missing after log settling.");
		return fail(
			textPayload(
				JSON.stringify({
					error: "Internal error: Process state lost after startup.",
					status: "error",
					error_type: "internal_state_error",
				}),
			),
		);
	}

	let finalStatus = currentInfoAfterWait.status;
	let message = "Process started."; // Default message

	if (finalStatus === "verifying") {
		message = "Process started, verification pattern matched.";
		// No status change needed, already implicitly successful if verifying passed
	} else if (finalStatus === "starting") {
		// If verification was NOT used, or timed out without a match/exit, consider it 'running'
		if (!verificationPattern) {
			finalStatus = "running"; // Promote to running if no verification
			updateProcessStatus(label, "running");
			message = "Process started and is now considered running.";
		} else {
			// Verification timed out or settled without match, but didn't crash/error
			finalStatus = "running"; // Still treat as running, but mention timeout
			updateProcessStatus(label, "running");
			message = `Process started, but verification pattern did not match within the timeout (${verificationTimeoutMs || "default"}ms). Considered running.`;
			log.warn(
				label,
				`Verification pattern did not match within timeout. Process status set to '${finalStatus}'.`,
			);
		}
	} else if (finalStatus === "crashed" || finalStatus === "error") {
		message = `Process failed to start or exited unexpectedly. Final status: ${finalStatus}. Check logs for details.`;
		log.error(label, message);
	}

	if (settled && !timedOut) {
		message += " Logs settled quickly.";
	} else if (timedOut) {
		message += ` Log settling wait timed out after ${OVERALL_LOG_WAIT_TIMEOUT_MS}ms.`;
	}

	// Include exit code/signal if applicable
	if (currentInfoAfterWait.exitCode !== null) {
		message += ` Exit Code: ${currentInfoAfterWait.exitCode}.`;
	}
	if (currentInfoAfterWait.signal !== null) {
		message += ` Signal: ${currentInfoAfterWait.signal}.`;
	}

	log.info(label, `Final status after settling/wait: ${finalStatus}`);

	// Retrieve potentially updated logs after settling/timeout
	const logsToReturn = formatLogsForResponse(
		currentInfoAfterWait.logs.map((l) => l.content),
		currentInfoAfterWait.logs.length, // Use the full length here for payload, actual return might be capped by transport
	);
	// --- End Determine Final Status and Message ---

	// --- Construct Payload ---
	// Generate the tail command first
	const tailCommand = getTailCommand(logFilePath);

	// Conditionally generate the monitoring hint based on tail command availability
	let monitoringHint: string;
	if (tailCommand) {
		// Phrasing for when file logging (and thus tailing) is possible
		monitoringHint = `If you requested to tail the '${label}' process, please run this command in a separate background terminal: ${tailCommand}. For status updates or recent inline logs, use check_process_status('${label}').`;
	} else {
		// Phrasing for when file logging is disabled
		monitoringHint = `For status updates or recent inline logs, use check_process_status('${label}'). File logging is not enabled for this process.`;
	}

	// Keep the detailed startup/settling message separate if needed
	const infoMessage = message; // 'message' contains the details about settling/timeout

	// Construct the final payload
	const successPayload: z.infer<typeof StartSuccessPayloadSchema> = {
		label,
		// Keep the primary message concise about the start status
		message: `Process "${label}" started with status: ${finalStatus}.`,
		status: finalStatus,
		pid: currentInfoAfterWait.pid,
		command: command,
		args: args,
		cwd: effectiveWorkingDirectory,
		// Ensure logsToReturn uses the full length from the earlier modification
		logs: formatLogsForResponse(
			currentInfoAfterWait.logs.map((l: LogEntry) => l.content),
			currentInfoAfterWait.logs.length, // Use the full length here for payload, actual return might be capped by transport
		),
		monitoring_hint: monitoringHint, // Use the newly formatted hint
		log_file_path: logFilePath,
		tail_command: tailCommand, // Include the generated tail command
		info_message: infoMessage, // Use the separate variable for settling details
		exitCode: currentInfoAfterWait.exitCode ?? null,
		signal: currentInfoAfterWait.signal ?? null,
	};

	log.info(
		label,
		`Returning result for start_process. Included ${successPayload.logs.length} log lines. Status: ${finalStatus}.`,
	);
	// --- End Construct Payload ---

	// If final status is error/crashed, return failure, otherwise success
	if (["error", "crashed"].includes(finalStatus)) {
		const errorPayload: z.infer<typeof StartErrorPayloadSchema> = {
			error: infoMessage, // Use the detailed message as the error
			status: finalStatus,
			cwd: effectiveWorkingDirectory, // CWD is allowed in the schema
			error_type: "process_exit_error", // General error type
		};
		log.error(
			label,
			`start_process returning failure. Status: ${finalStatus}, Exit Code: ${successPayload.exitCode}, Signal: ${successPayload.signal}`,
		);
		return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
	}

	return ok(textPayload(JSON.stringify(successPayload, null, 2))); // Ensure payload is stringified
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
					`Process did not terminate after SIGTERM and wait. Sending SIGKILL to PID ${pidToKill}...`,
				);
				addLogEntry(
					label,
					"Process unresponsive to SIGTERM, sending SIGKILL...",
				);
				await killPtyProcess(processToKill, label, "SIGKILL");
				finalMessage = `Graceful stop attempted (SIGTERM), but process unresponsive. SIGKILL sent to PID ${pidToKill}.`;
				finalStatus = "stopping"; // Assume stopping until handleExit updates
			} else {
				// Process likely terminated gracefully
				finalMessage = `Graceful stop successful (SIGTERM) for PID ${pidToKill}. Final status: ${finalStatus}.`;
				log.info(label, "Process terminated gracefully after SIGTERM.");
				addLogEntry(label, "Process terminated gracefully after SIGTERM.");
			}
		}

		// Prepare success payload
		// Get the LATEST status again, as handleExit might have run during SIGKILL/wait
		const latestInfo = managedProcesses.get(label);
		// Ensure the status is one of the allowed enum values or undefined
		const finalPayloadStatus =
			(latestInfo?.status as ProcessStatus | undefined) ??
			(finalStatus as ProcessStatus | undefined);

		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: finalPayloadStatus, // Use type-checked status
			message: finalMessage,
			pid: latestInfo?.pid ?? pidToKill, // Use latest known PID
		};
		return ok(textPayload(JSON.stringify(payload)));
	} catch (error) {
		const errorMsg = `Failed to stop process "${label}" (PID: ${pidToKill}): ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, `Error during stop: ${errorMsg}`);
		updateProcessStatus(label, "error"); // Mark as error on failure

		// Prepare error payload
		const payload: z.infer<typeof StopProcessPayloadSchema> = {
			label,
			status: "error",
			message: errorMsg,
			pid: pidToKill, // PID before stop attempt
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
		// Correct call to writeToPty
		if (!processInfo.process) {
			log.error(label, "Cannot send input: PTY process object is null.");
			return fail(
				textPayload(`Process "${label}" has no active process handle.`),
			);
		}
		const dataToSend = append_newline ? `${input}\r` : input;
		await writeToPty(processInfo.process, dataToSend, label);
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

function handleData(label: string, data: string, source: "stdout" | "stderr") {
	// [MCP-TEST-LOG STEP 4.1] Log raw incoming data
	log.debug(
		label,
		`[processLogic.handleData RAW ENTRY] Source: ${source}, Raw Data: ${JSON.stringify(data)}`,
	);
	const processInfo = getProcessInfo(label); // <-- Use getProcessInfo helper
	if (!processInfo) {
		log.warn(label, `[handleData] Received data for unknown process: ${label}`);
		return;
	}
	// >> ADDED: Log retrieved processInfo state (partially)
	log.debug(
		label,
		`[processLogic.handleData STATE] Found processInfo. Status: ${processInfo.status}, Log Count: ${processInfo.logs.length}`,
	);

	log.debug(
		label,
		`[processLogic.handleData ENTRY] Received ${source} line: ${JSON.stringify(data)}`,
	); // Use the new simpler entry log

	log.debug(
		label,
		`[processLogic.handleData] Adding line: ${data.substring(0, 100)}`,
	);
	const content = data; // Use the line directly
	log.debug(
		label,
		`[processLogic.handleData] Calling addLogEntry for line: ${content.substring(0, 100)}`,
	);
	addLogEntry(label, content); // Pass the single line to addLogEntry

	// No file stream write here anymore, handled within addLogEntry
}

function getProcessInfo(label: string): ProcessInfo | undefined {
	const found = managedProcesses.get(label);
	log.debug(
		label,
		`[state.getProcessInfo] Requested for label: ${label}. Found: ${!!found}`,
	);
	return found;
}

// Initialize the buffer when creating ProcessInfo
export function initializeProcessInfo(
	label: string,
	command: string,
	args: string[],
	cwd: string,
	ptyProcess: IPty,
	verificationPattern: RegExp | undefined,
	verificationTimeoutMs: number | undefined,
	retryDelayMs: number | undefined,
	maxRetries: number | undefined,
	logFilePath: string | null,
	logFileStream: fs.WriteStream | null,
): ProcessInfo {
	const info: ProcessInfo = {
		label,
		command,
		args,
		cwd,
		status: "starting",
		logs: [],
		pid: ptyProcess.pid,
		process: ptyProcess,
		exitCode: null,
		signal: null,
		verificationPattern,
		verificationTimeoutMs: verificationTimeoutMs ?? undefined,
		retryDelayMs: retryDelayMs ?? undefined,
		maxRetries: maxRetries ?? undefined,
		logFilePath,
		logFileStream,
		partialLineBuffer: "", // Initialize buffer
	};
	return info;
}
