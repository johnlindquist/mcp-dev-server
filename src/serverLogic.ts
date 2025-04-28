import * as fs from "fs"; // Import fs for directory check
import * as path from "path"; // Import path module
import * as pty from "node-pty";
import type { IPty } from "node-pty"; // Ensure IPty is imported
import {
	DEFAULT_RETURN_LOG_LINES,
	MAX_STORED_LOG_LINES,
	STOP_WAIT_DURATION,
	VERIFICATION_PATTERN,
	VERIFICATION_TIMEOUT,
} from "./constants.js";
import {
	addLogEntry,
	checkAndUpdateStatus,
	handleCrashAndRetry,
	handleExit,
	runningServers,
	updateServerStatus,
} from "./state.js";
import {
	type CallToolResult,
	fail,
	formatLogsForResponse,
	ok,
	textPayload,
} from "./types.js";
import type { ServerInfo } from "./types.js";
import { log, stripAnsiSafe } from "./utils.js";

/**
 * Internal function to start a server process.
 * Handles process spawning, logging, status updates, and verification.
 */
export async function _startServer(
	label: string,
	command: string,
	workingDirectoryInput: string | undefined, // Renamed from cwd
	logLines: number,
): Promise<CallToolResult> {
	// Resolve the working directory: Use input, fallback to MCP_WORKSPACE_ROOT, then process CWD
	const effectiveWorkingDirectory = workingDirectoryInput
		? path.resolve(workingDirectoryInput) // Resolve relative paths based on current process CWD
		: process.env.MCP_WORKSPACE_ROOT || process.cwd();

	log.info(
		label,
		`Starting server process... Command: "${command}", Input Working Dir: "${workingDirectoryInput || "(not provided)"}", Effective Working Dir: "${effectiveWorkingDirectory}"`,
	);

	// Verify the effective working directory exists before attempting to spawn
	log.debug(
		label,
		`Verifying existence of effective working directory: ${effectiveWorkingDirectory}`,
	);
	if (!fs.existsSync(effectiveWorkingDirectory)) {
		const errorMsg = `Working directory does not exist: ${effectiveWorkingDirectory}`;
		log.error(label, errorMsg);
		// Update status to error even if the server map entry wasn't fully created yet
		// Ensure a placeholder ServerInfo exists if this is the first attempt for the label
		if (!runningServers.has(label)) {
			runningServers.set(label, {
				label,
				command,
				cwd: effectiveWorkingDirectory,
				status: "error",
				error: errorMsg,
				pid: null,
				process: null,
				logs: [],
				startTime: new Date(),
				exitCode: null,
				retryCount: 0,
				lastCrashTime: null,
			});
		} else {
			updateServerStatus(label, "error", {
				error: errorMsg,
				pid: undefined,
				process: null,
			});
		}
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: errorMsg,
						status: "error",
						cwd: effectiveWorkingDirectory,
						error_type: "working_directory_not_found",
					},
					null,
					2,
				),
			),
		);
	}
	log.debug(
		label,
		`Effective working directory verified: ${effectiveWorkingDirectory}`,
	);

	const existingServer = runningServers.get(label);

	// Check if server with this label already exists and is active
	if (
		existingServer &&
		(existingServer.status === "running" ||
			existingServer.status === "starting" ||
			existingServer.status === "verifying" ||
			existingServer.status === "restarting")
	) {
		const errorMsg = `Server with label "${label}" is already ${existingServer.status} (PID: ${existingServer.pid}). Use a different label or stop the existing server first.`;
		log.error(label, errorMsg);
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: errorMsg,
						status: existingServer.status,
						error_type: "label_conflict",
					},
					null,
					2,
				),
			),
		);
	}

	// If it exists but is stopped/crashed/error, reuse the label but reset state
	if (existingServer) {
		log.warn(
			label,
			`Reusing label "${label}". Previous instance was ${existingServer.status}. Clearing old state.`,
		);
		// Clear logs, reset status etc. Map entry will be overwritten below.
	}

	const shell =
		process.env.SHELL ||
		(process.platform === "win32" ? "powershell.exe" : "bash");
	let ptyProcess: pty.IPty;

	try {
		ptyProcess = pty.spawn(shell, [], {
			name: "xterm-color",
			cols: 80,
			rows: 30,
			// Use the EFFECTIVE working directory
			cwd: effectiveWorkingDirectory,
			env: { ...process.env, FORCE_COLOR: "1", MCP_DEV_SERVER_LABEL: label }, // Force color and add label
			encoding: "utf8",
		});
	} catch (error: unknown) {
		const errorMsg = `Failed to spawn PTY process: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		// Update status to error
		if (!runningServers.has(label)) {
			// Ensure entry exists before update
			runningServers.set(label, {
				label,
				command,
				cwd: effectiveWorkingDirectory,
				status: "error",
				error: errorMsg,
				pid: null,
				process: null,
				logs: [],
				startTime: new Date(),
				exitCode: null,
				retryCount: 0,
				lastCrashTime: null,
			});
		} else {
			updateServerStatus(label, "error", {
				error: errorMsg,
				pid: undefined,
				process: null,
			});
		}
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: errorMsg,
						status: "error",
						cwd: effectiveWorkingDirectory,
						error_type: "pty_spawn_failed",
					},
					null,
					2,
				),
			),
		);
	}

	// Create the server info entry immediately after successful spawn
	const serverInfo: ServerInfo = {
		label,
		pid: ptyProcess.pid,
		process: ptyProcess,
		command,
		// Store the EFFECTIVE working directory used
		cwd: effectiveWorkingDirectory,
		logs: [],
		status: "starting",
		startTime: new Date(),
		exitCode: null,
		error: null,
		retryCount: 0, // Initialize retry count
		lastCrashTime: null, // Initialize last crash time
	};
	runningServers.set(label, serverInfo);
	addLogEntry(
		label,
		"system",
		`Process spawned successfully (PID: ${ptyProcess.pid}) in ${effectiveWorkingDirectory}. Status: starting.`,
	);

	// Write command to PTY shell
	ptyProcess.write(`${command}\r`); // Send command + Enter

	// --- Verification Logic ---
	let verificationTimer: NodeJS.Timeout | null = null;
	let isVerified = false;
	const verificationPattern = VERIFICATION_PATTERN; // Configurable pattern
	const verificationTimeout = VERIFICATION_TIMEOUT; // Configurable timeout

	const verificationPromise = new Promise<boolean>((resolve) => {
		if (!verificationPattern) {
			log.info(
				label,
				"No verification pattern set. Assuming server is running after spawn.",
			);
			resolve(true); // Skip verification if no pattern
			return;
		}

		log.info(
			label,
			`Setting up verification: waiting for pattern "${verificationPattern.source}" within ${verificationTimeout}ms`,
		);
		updateServerStatus(label, "verifying");
		addLogEntry(
			label,
			"system",
			`Status: verifying. Waiting for log pattern: ${verificationPattern.source}`,
		);

		const onDataForVerification = (data: string) => {
			const strippedData = stripAnsiSafe(data);
			if (verificationPattern.test(strippedData)) {
				log.info(
					label,
					`Verification pattern matched: "${verificationPattern.source}". Server marked as running.`,
				);
				if (verificationTimer) clearTimeout(verificationTimer);
				isVerified = true;
				resolve(true);
			}
		};

		ptyProcess.onData(onDataForVerification);

		verificationTimer = setTimeout(() => {
			if (!isVerified) {
				log.error(
					label,
					`Verification timed out after ${verificationTimeout}ms. Pattern "${verificationPattern.source}" not found.`,
				);
				ptyProcess.removeListener("data", onDataForVerification); // Clean up listener
				updateServerStatus(label, "error", {
					error: "Verification pattern not found within timeout.",
				});
				addLogEntry(label, "error", "Verification timed out.");
				// Attempt to kill the process since it didn't verify
				try {
					ptyProcess.kill("SIGTERM");
				} catch (e) {
					log.warn(
						label,
						`Failed to send SIGTERM after verification timeout: ${e}`,
					);
				}
				resolve(false);
			}
		}, verificationTimeout);

		// Clean up listener when process exits before verification completes
		ptyProcess.onExit(() => {
			if (!isVerified) {
				log.warn(label, "Process exited before verification completed.");
				if (verificationTimer) clearTimeout(verificationTimer);
				ptyProcess.removeListener("data", onDataForVerification); // Clean up listener
				// Status might be set by handleExit/handleCrash, but ensure timer is cleared
				resolve(false); // Verification failed
			}
		});
	});

	// --- Standard Log Handling ---
	ptyProcess.onData((data: string) => {
		const lines = data.split(/\r?\n/);
		lines.forEach((line) => {
			if (line.trim()) {
				// Avoid logging empty lines
				addLogEntry(label, "stdout", line);
				// Minimal logging to server console for visibility
				// log.info(label, `[stdout] ${stripAnsiSafe(line).substring(0, 100)}`);
			}
		});
	});

	// --- Exit/Error Handling ---
	ptyProcess.onExit(({ exitCode, signal }) => {
		// Ensure verification timer is cleared if exit happens
		if (verificationTimer && !isVerified) {
			clearTimeout(verificationTimer);
			log.warn(label, "Process exited during verification phase.");
		}
		const exitReason = `exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""}`;
		log.info(label, `Process ${exitReason}.`);

		// Check if the exit was expected (status 'stopping') or a crash
		const currentInfo = runningServers.get(label);
		if (currentInfo?.status === "stopping") {
			handleExit(label, exitCode, signal);
		} else {
			// Treat any other exit (including during 'starting', 'verifying', 'running') as a crash
			handleCrashAndRetry(
				label,
				exitCode,
				`Process ${exitReason} unexpectedly.`,
			);
		}
	});

	// Wait for verification to complete (or timeout/fail)
	const verificationSuccess = await verificationPromise;

	if (verificationSuccess && !isVerified && verificationPattern) {
		// This case should ideally not happen if logic is correct, but handles edge cases
		log.warn(
			label,
			"Verification promise resolved true, but verification flag not set. Marking as running tentatively.",
		);
		updateServerStatus(label, "running");
		addLogEntry(label, "system", "Status: running (post-verification phase).");
	} else if (verificationSuccess && isVerified) {
		// Explicitly set to running AFTER successful verification
		updateServerStatus(label, "running");
		addLogEntry(label, "system", "Status: running (verified).");
	} else if (!verificationSuccess) {
		// Verification failed (timeout or process exit)
		// Status should already be 'error' or 'crashed' set by timer/onExit handlers
		const finalStatus = runningServers.get(label)?.status || "error"; // Get the most recent status
		const errorMsg =
			runningServers.get(label)?.error ||
			"Verification failed or process exited prematurely.";
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: errorMsg,
						status: finalStatus,
						pid: serverInfo.pid,
						cwd: serverInfo.cwd, // Include cwd in failure response
						logs: formatLogsForResponse(serverInfo.logs, logLines),
						error_type: "verification_failed",
					},
					null,
					2,
				),
			),
		);
	} else {
		// !verificationPattern case (auto-success)
		updateServerStatus(label, "running");
		addLogEntry(label, "system", "Status: running (no verification pattern).");
	}

	// Return success state
	const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
	const finalServerInfo = runningServers.get(label) as ServerInfo; // Should exist
	return ok(
		textPayload(
			JSON.stringify(
				{
					message: `Server "${label}" started successfully.`,
					status: finalServerInfo.status,
					pid: finalServerInfo.pid,
					cwd: finalServerInfo.cwd, // Return the effective working directory
					logs: formatLogsForResponse(finalServerInfo.logs, linesToReturn),
					logLinesReturned: Math.min(
						linesToReturn,
						finalServerInfo.logs.length,
					),
					monitoring_hint: `Server is ${finalServerInfo.status}. Use check_dev_server_status for updates.`,
				},
				null,
				2,
			),
		),
	);
}

/**
 * Internal function to stop a server process.
 * Handles sending signals and updating status.
 */
export async function _stopServer(
	label: string,
	force: boolean,
	logLines: number,
): Promise<CallToolResult> {
	log.info(label, `Attempting to stop server "${label}" (force=${force})...`);
	// Ensure status is up-to-date before attempting stop
	const serverInfo = await checkAndUpdateStatus(label);

	if (!serverInfo) {
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: `Server with label "${label}" not found.`,
						status: "not_found",
						error_type: "not_found",
					},
					null,
					2,
				),
			),
		);
	}

	// Check if already stopped or in a terminal state where stop is irrelevant
	if (serverInfo.status === "stopped" || serverInfo.status === "crashed") {
		log.warn(label, `Server is already ${serverInfo.status}.`);
		return ok(
			textPayload(
				JSON.stringify(
					{
						message: `Server "${label}" was already ${serverInfo.status}.`,
						status: serverInfo.status,
						pid: serverInfo.pid,
						cwd: serverInfo.cwd,
						logs: formatLogsForResponse(serverInfo.logs, logLines),
						logLinesReturned: Math.min(logLines, serverInfo.logs.length),
					},
					null,
					2,
				),
			),
		);
	}

	if (serverInfo.status === "error" && !serverInfo.pid) {
		log.warn(
			label,
			`Server is in error state without a PID. Cannot send signal, marking as stopped.`,
		);
		updateServerStatus(label, "stopped", {
			error: "Server was in error state with no process to kill.",
		});
		return ok(
			textPayload(
				JSON.stringify(
					{
						message: `Server "${label}" was in error state with no PID. Considered stopped.`,
						status: "stopped",
						pid: null,
						cwd: serverInfo.cwd,
						error: serverInfo.error,
						logs: formatLogsForResponse(serverInfo.logs, logLines),
						logLinesReturned: Math.min(logLines, serverInfo.logs.length),
					},
					null,
					2,
				),
			),
		);
	}

	// Proceed with stop if process exists or might exist
	if (!serverInfo.process || !serverInfo.pid) {
		log.error(
			label,
			`Cannot stop server: process handle or PID is missing despite status being ${serverInfo.status}. Attempting to mark as error.`,
		);
		updateServerStatus(label, "error", {
			error: `Cannot stop server: process handle or PID missing (status was ${serverInfo.status})`,
			process: null,
		});
		return fail(
			textPayload(
				JSON.stringify(
					{
						error: `Cannot stop server: process handle or PID missing (status was ${serverInfo.status}).`,
						status: "error",
						error_type: "missing_handle_on_stop",
						pid: serverInfo.pid, // Include last known PID if available
						cwd: serverInfo.cwd,
						logs: formatLogsForResponse(serverInfo.logs, logLines),
						logLinesReturned: Math.min(logLines, serverInfo.logs.length),
					},
					null,
					2,
				),
			),
		);
	}

	const signal: "SIGTERM" | "SIGKILL" = force ? "SIGKILL" : "SIGTERM";
	log.info(label, `Sending ${signal} to process PID ${serverInfo.pid}...`);
	addLogEntry(label, "system", `Sending ${signal} signal.`);
	updateServerStatus(label, "stopping");

	try {
		serverInfo.process.kill(signal);
	} catch (error: unknown) {
		const errorMsg = `Failed to send ${signal} to process PID ${serverInfo.pid}: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		addLogEntry(label, "error", `Error sending signal: ${errorMsg}`);
		// If signal fails, process might already be gone, or permissions issue
		// Try checking status again, maybe it already exited
		const postSignalCheck = await checkAndUpdateStatus(label);
		const currentStatus = postSignalCheck?.status ?? serverInfo.status;
		const finalError =
			currentStatus === "stopped" || currentStatus === "crashed"
				? `Signal ${signal} failed, but process seems to have stopped anyway (${currentStatus}).`
				: `Failed to send ${signal}. Server status remains ${currentStatus}.`;

		if (currentStatus !== "stopped" && currentStatus !== "crashed") {
			updateServerStatus(label, "error", { error: finalError });
		}

		return fail(
			textPayload(
				JSON.stringify(
					{
						error: finalError,
						status: currentStatus,
						error_type: "signal_send_failed",
						pid: serverInfo.pid,
						cwd: serverInfo.cwd,
						logs: formatLogsForResponse(
							postSignalCheck?.logs ?? serverInfo.logs,
							logLines,
						),
						logLinesReturned: Math.min(
							logLines,
							(postSignalCheck?.logs ?? serverInfo.logs).length,
						),
					},
					null,
					2,
				),
			),
		);
	}

	// Wait for the process to exit after sending the signal
	log.info(
		label,
		`Waiting up to ${STOP_WAIT_DURATION}ms for process ${serverInfo.pid} to exit after ${signal}...`,
	);
	const stopTimeoutPromise = new Promise((resolve) =>
		setTimeout(resolve, STOP_WAIT_DURATION),
	);
	const exitPromise = new Promise<void>((resolve) => {
		const checkExit = () => {
			const currentInfo = runningServers.get(label);
			// Resolve if server is gone or in a terminal state
			if (
				!currentInfo ||
				currentInfo.status === "stopped" ||
				currentInfo.status === "crashed" ||
				currentInfo.status === "error"
			) {
				resolve();
			} else {
				setTimeout(checkExit, 100); // Check again shortly
			}
		};
		checkExit();
	});

	await Promise.race([stopTimeoutPromise, exitPromise]);

	// Final status check after wait
	const finalInfo = await checkAndUpdateStatus(label);
	const finalStatus = finalInfo?.status ?? "unknown"; // Use 'unknown' if info somehow disappeared

	log.info(label, `Post-stop wait check: Final status is ${finalStatus}`);

	const responsePayload = {
		message: "",
		status: finalStatus,
		pid: finalInfo?.pid ?? serverInfo.pid, // Report last known PID if info disappeared
		cwd: finalInfo?.cwd ?? serverInfo.cwd,
		exitCode: finalInfo?.exitCode,
		error: finalInfo?.error,
		logs: formatLogsForResponse(finalInfo?.logs ?? serverInfo.logs, logLines),
		logLinesReturned: Math.min(
			logLines,
			(finalInfo?.logs ?? serverInfo.logs).length,
		),
	};

	if (finalStatus === "stopped" || finalStatus === "crashed") {
		responsePayload.message = `Server "${label}" stopped successfully (final status: ${finalStatus}).`;
		return ok(textPayload(JSON.stringify(responsePayload, null, 2)));
	} else {
		const errorMsg = `Server "${label}" did not stop within ${STOP_WAIT_DURATION}ms after ${signal}. Current status: ${finalStatus}.`;
		responsePayload.message = errorMsg;
		if (!responsePayload.error) {
			responsePayload.error = errorMsg;
		}
		log.error(label, errorMsg);
		// If it didn't stop, and wasn't already 'error', mark it as error now
		if (finalStatus !== "error" && finalInfo) {
			updateServerStatus(label, "error", { error: errorMsg });
			responsePayload.status = "error"; // Reflect the update in the response
		}
		return fail(
			textPayload(
				JSON.stringify(
					{ ...responsePayload, error_type: "stop_timeout" },
					null,
					2,
				),
			),
		);
	}
}
