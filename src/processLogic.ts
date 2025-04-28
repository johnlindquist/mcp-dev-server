import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import type { IDisposable } from "node-pty"; // Import IDisposable
import { LOG_LINE_LIMIT } from "./constants.js";
import {
	addLogEntry,
	checkAndUpdateProcessStatus, // Renamed function
	handleExit, // Corrected type in state.ts handleExit
	managedProcesses, // Renamed map
	updateProcessStatus, // Renamed function
} from "./state.js";
import { fail, ok, textPayload } from "./types.js";
import type { CallToolResult, ProcessInfo } from "./types.ts"; // Renamed types
import { formatLogsForResponse, log } from "./utils.js";

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
	let isVerified = !verificationPattern; // Automatically verified if no pattern
	let verificationTimerDisposable: NodeJS.Timeout | undefined = undefined; // Renamed
	let dataListenerDisposable: IDisposable | undefined = undefined; // For data listener
	let exitListenerDisposable: IDisposable | undefined = undefined; // For exit listener during verification

	const disposeVerificationListeners = () => {
		if (verificationTimerDisposable) {
			clearTimeout(verificationTimerDisposable);
			verificationTimerDisposable = undefined;
		}
		if (dataListenerDisposable) {
			dataListenerDisposable.dispose();
			dataListenerDisposable = undefined;
		}
		if (exitListenerDisposable) {
			exitListenerDisposable.dispose();
			exitListenerDisposable = undefined;
		}
		// Also clear the timer stored in processInfo
		if (processInfo.verificationTimer) {
			clearTimeout(processInfo.verificationTimer);
			processInfo.verificationTimer = undefined;
		}
	};

	const completeVerification = (success: boolean, reason: string): void => {
		disposeVerificationListeners(); // Clean up all listeners/timers
		if (processInfo.status === "verifying") {
			if (success) {
				log.info(label, `Verification successful: ${reason}`);
				addLogEntry(label, `Verification successful: ${reason}`);
				updateProcessStatus(label, "running");
				isVerified = true; // Ensure flag is set
			} else {
				log.error(label, `Verification failed: ${reason}`);
				addLogEntry(label, `Verification failed: ${reason}`);
				updateProcessStatus(label, "error");
				// Optionally kill the process if verification fails critically
				if (processInfo.process && processInfo.pid) {
					log.warn(label, "Killing process due to verification failure."); // Removed template literal
					try {
						processInfo.process.kill("SIGKILL");
					} catch (e) {
						log.error(
							label,
							`Error killing process after verification failure: ${e}`,
						);
					}
				}
			}
		} else {
			// Status changed before verification completed (e.g., crashed)
			log.warn(
				label,
				`Verification completion skipped as status is now ${processInfo.status}. Reason: ${reason}`,
			);
		}
	};

	if (verificationPattern) {
		const timeoutMessage =
			processInfo.verificationTimeoutMs !== null
				? `Timeout ${processInfo.verificationTimeoutMs}ms`
				: "Timeout disabled";
		log.info(
			label,
			`Verification required: Pattern /${verificationPattern.source}/, ${timeoutMessage}`,
		);
		addLogEntry(
			label,
			"Status: verifying. Waiting for pattern or timeout.", // Removed template literal
		);
		updateProcessStatus(label, "verifying");

		const dataListener = (data: string): void => {
			try {
				if (verificationPattern.test(data)) {
					if (processInfo.status === "verifying") {
						// Check status before completing
						completeVerification(true, "Pattern matched.");
						// Listener disposed in completeVerification
					} else {
						log.warn(
							label,
							`Verification pattern matched, but status is now ${processInfo.status}. Ignoring match.`,
						);
						// Listener disposed below if necessary
						disposeVerificationListeners(); // Dispose if pattern matched but state changed
					}
				}
			} catch (e: unknown) {
				log.error(label, "Error during verification data processing", e);
				if (processInfo.status === "verifying") {
					completeVerification(
						false,
						`Error processing verification pattern: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				// Listener disposed in completeVerification
			}
		};
		dataListenerDisposable = ptyProcess.onData(dataListener);

		// Only set timeout if verificationTimeoutMs is provided (not null)
		if (processInfo.verificationTimeoutMs !== null) {
			verificationTimerDisposable = setTimeout(() => {
				if (processInfo.status === "verifying") {
					// Check status before timeout failure
					completeVerification(
						false,
						`Timeout (${processInfo.verificationTimeoutMs}ms)`,
					);
					// Listener disposed in completeVerification
				} else {
					log.warn(
						label,
						`Verification timeout occurred, but status is now ${processInfo.status}. Ignoring timeout.`,
					);
					// Listener might still need cleanup if process exited without data match
					disposeVerificationListeners(); // Dispose if timeout irrelevant
				}
			}, processInfo.verificationTimeoutMs); // Use the actual timeout value
			// Store the timer in processInfo as well for external access/clearing (e.g., in stopProcess)
			processInfo.verificationTimer = verificationTimerDisposable;
		}

		// Ensure listener is removed on exit if verification didn't complete
		exitListenerDisposable = ptyProcess.onExit(() => {
			// Use onExit, store disposable
			if (processInfo.status === "verifying") {
				log.warn(label, "Process exited during verification phase.");
				completeVerification(
					false,
					"Process exited before verification completed.",
				);
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

	// --- Standard Log Handling --- Tidy this up
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
		// Clean up the main data listener on exit
		mainDataDisposable.dispose();
		// If verification was happening, its exit listener should handle it.
		// If verification is done or wasn't needed, handle the exit normally.
		if (processInfo.status !== "verifying") {
			const currentInfo = managedProcesses.get(label); // Get fresh info
			// Pass numeric signal directly, handleExit now expects string|null
			// We need to convert the numeric signal code to string name IF possible, else use null or UNKNOWN(num)
			// For now, pass null as signal interpretation is complex and handleExit accepts null
			handleExit(
				label,
				exitCode ?? null,
				signal !== undefined ? String(signal) : null,
			);
		}
		// Ensure this listener is also disposed
		mainExitDisposable.dispose();
	});

	// Don't wait for verification promise here, let it run in background
	// Return immediately after spawning and setting up listeners/timers

	if (!isVerified) {
		// Wait for verification if it hasn't happened yet (only relevant if verificationPattern exists)
		await new Promise<void>((resolve) => {
			const checkInterval = setInterval(() => {
				if (
					isVerified ||
					!["starting", "verifying"].includes(processInfo.status)
				) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}

	// --- Final Return --- //
	// Check status again after potential verification wait
	const currentStatus = managedProcesses.get(label)?.status;
	if (
		currentStatus &&
		["running", "verifying", "starting"].includes(currentStatus)
	) {
		const currentProcessInfo = managedProcesses.get(label);
		if (!currentProcessInfo) {
			// This should not happen if status was checked, but handle defensively
			const errorMsg =
				"Internal error: Process info disappeared after starting.";
			log.error(label, errorMsg);
			return fail(
				textPayload(JSON.stringify({ error: errorMsg, status: "error" })),
			);
		}
		const message = isVerified
			? `Process "${label}" started successfully (PID: ${currentProcessInfo.pid}). Status: ${currentProcessInfo.status}.`
			: `Process "${label}" started (PID: ${currentProcessInfo.pid}), verification pending... Status: ${currentProcessInfo.status}.`;

		return ok(
			textPayload(
				JSON.stringify(
					{
						label: label,
						message,
						status: currentProcessInfo.status,
						pid: currentProcessInfo.pid,
						cwd: currentProcessInfo.cwd,
						logs: formatLogsForResponse(
							currentProcessInfo.logs.map((l) => l.content),
							LOG_LINE_LIMIT, // Return standard log lines on start
						),
						monitoring_hint: `Process is ${currentProcessInfo.status}. Use check_process_status with label "${label}" for updates.`,
					},
					null,
					2,
				),
			),
		);
	}

	// Process likely failed during verification or exited quickly
	const finalInfo = await checkAndUpdateProcessStatus(label);
	const errorMsg = `Process "${label}" failed to start or exited prematurely. Final status: ${finalInfo?.status ?? "unknown"}`;
	log.error(label, errorMsg);
	return fail(
		textPayload(
			JSON.stringify(
				{
					error: errorMsg,
					status: finalInfo?.status ?? "error",
					pid: finalInfo?.pid,
					exitCode: finalInfo?.exitCode,
					signal: finalInfo?.signal,
					logs: formatLogsForResponse(
						finalInfo?.logs?.map((l) => l.content) ?? [],
						LOG_LINE_LIMIT,
					),
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
						LOG_LINE_LIMIT,
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
						LOG_LINE_LIMIT,
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
						LOG_LINE_LIMIT,
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
						LOG_LINE_LIMIT,
					),
					monitoring_hint:
						"Process is stopping. Use check_process_status for final status.", // Removed template literal
				},
				null,
				2,
			),
		),
	);
}
