import { promisify } from "node:util";
import treeKill from "tree-kill";
import {
	CRASH_LOOP_DETECTION_WINDOW_MS,
	DEFAULT_RETRY_DELAY_MS,
	MAX_RETRIES,
} from "./constants.js";
import { _startProcess } from "./processLogic.js"; // May need adjustment later
import {
	addLogEntry,
	getProcessInfo,
	managedProcesses,
	updateProcessStatus,
} from "./state.js"; // Assuming state functions remain accessible
import { log } from "./utils.js";

// ADD killProcessTree definition
const killProcessTree = promisify(treeKill);

// --- handleExit function --- (Copied from state.ts)
export function handleExit(
	label: string,
	code: number | null,
	signal: string | null,
): void {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		log.warn(label, "handleExit called but process info not found.");
		return;
	}

	// --- Close Log Stream --- (Copied from state.ts)
	if (processInfo.logFileStream) {
		log.debug(label, `Closing log file stream for ${label} due to exit.`);
		addLogEntry(
			label,
			`--- Process Exited (Code: ${code ?? "N/A"}, Signal: ${signal ?? "N/A"}) ---`,
		);
		processInfo.logFileStream.end(() => {
			log.debug(
				label,
				`Log file stream for ${label} finished writing and closed.`,
			);
		});
		processInfo.logFileStream = null; // Nullify immediately
		// Keep logFilePath even after closing for reference
	}
	// --- End Close Log Stream ---

	const status = processInfo.status;

	// If the process was explicitly stopped, mark as stopped
	if (status === "stopping") {
		log.info(
			label,
			`Process was explicitly stopped. Final code: ${code}, signal: ${signal}`,
		);
		updateProcessStatus(label, "stopped", { code, signal });
	} // If process exited cleanly (code 0) BUT was still starting/verifying, let _startProcess decide final status.
	else if (code === 0 && (status === "starting" || status === "verifying")) {
		log.info(
			label,
			`Process exited cleanly (code 0) during ${status} phase. _startProcess will determine final payload status.`,
		);
		// DO NOT update status here. Let _startProcess check the exit code after settling.
		// We need to store the exit info though for _startProcess to see it.
		processInfo.exitCode = code;
		processInfo.signal = signal;
		processInfo.lastExitTimestamp = Date.now(); // Record exit time
	}
	// Check for clean exit code 0 AFTER it was running
	else if (code === 0 && status === "running") {
		log.info(
			label,
			"Process exited cleanly (code 0) from running state. Marking as stopped.",
		);
		updateProcessStatus(label, "stopped", { code, signal });
	}
	// Otherwise (non-zero code or signal), treat as crash or error
	else if (status !== "stopped" && status !== "error" && status !== "crashed") {
		log.warn(
			label,
			`Process exited unexpectedly (code: ${code}, signal: ${signal}). Marking as crashed.`,
		);
		updateProcessStatus(label, "crashed", { code, signal });
		// Check if retry is configured and appropriate
		if (
			processInfo.maxRetries !== undefined &&
			processInfo.maxRetries > 0 &&
			processInfo.retryDelayMs !== undefined
		) {
			// Use void to explicitly ignore the promise for fire-and-forget
			void handleCrashAndRetry(label); // Call the local retry handler
		} else {
			log.info(label, "Process crashed, but no retry configured.");
			addLogEntry(label, "Process crashed. No retry configured.");
		}
	} else {
		log.info(
			label,
			`Process exited but was already in state ${status}. No status change.`,
		);
	}
}

// --- handleCrashAndRetry function --- (Copied from state.ts)
export async function handleCrashAndRetry(label: string): Promise<void> {
	const processInfo = getProcessInfo(label); // Use getProcessInfo to ensure latest state
	if (!processInfo || processInfo.status !== "crashed") {
		log.warn(
			label,
			"handleCrashAndRetry called but process not found or not in crashed state.",
		);
		return;
	}

	const now = Date.now();
	const maxRetries = processInfo.maxRetries ?? MAX_RETRIES;
	const retryDelay = processInfo.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	// Reset restart attempts if outside the crash loop window
	if (
		processInfo.lastCrashTime &&
		now - processInfo.lastCrashTime > CRASH_LOOP_DETECTION_WINDOW_MS
	) {
		log.info(label, "Resetting restart attempts, outside crash loop window.");
		processInfo.restartAttempts = 0;
	}

	processInfo.lastCrashTime = now;
	processInfo.restartAttempts = (processInfo.restartAttempts ?? 0) + 1;

	if (processInfo.restartAttempts > maxRetries) {
		log.error(
			label,
			`Crash detected. Process exceeded max retries (${maxRetries}). Marking as error.`,
		);
		addLogEntry(
			label,
			`Crash detected. Exceeded max retries (${maxRetries}). Marking as error.`,
		);
		updateProcessStatus(label, "error");
		// Consider cleanup or final notification here
	} else {
		log.warn(
			label,
			`Crash detected. Attempting restart ${processInfo.restartAttempts}/${maxRetries} after ${retryDelay}ms...`,
		);
		addLogEntry(
			label,
			`Crash detected. Attempting restart ${processInfo.restartAttempts}/${maxRetries}...`,
		);
		updateProcessStatus(label, "restarting");

		// Use await with setTimeout for delay
		await new Promise((resolve) => setTimeout(resolve, retryDelay));

		log.info(label, "Initiating restart...");
		// Re-use original start parameters, including verification settings
		// processInfo.host is already HostEnumType
		await _startProcess(
			label,
			processInfo.command,
			processInfo.args, // Pass args
			processInfo.cwd,
			processInfo.host, // Corrected: host goes here
			processInfo.verificationPattern, // Corrected: pattern goes here
			processInfo.verificationTimeoutMs ?? undefined, // Convert null to undefined
			processInfo.retryDelayMs ?? undefined, // Convert null to undefined
			processInfo.maxRetries, // Pass retry settings
			true, // Indicate this is a restart
		);
	}
}

// PASTE stopAllProcessesOnExit function here
export function stopAllProcessesOnExit(): void {
	log.info(null, "Stopping all managed processes on exit...");
	const stopPromises: Promise<void>[] = [];

	managedProcesses.forEach((processInfo, label) => {
		log.info(
			label,
			`Attempting to stop process ${label} (PID: ${processInfo.pid})...`,
		);
		if (processInfo.process && processInfo.pid) {
			updateProcessStatus(label, "stopping"); // <-- Needs updateProcessStatus import
			// Create a promise for each stop operation
			const stopPromise = new Promise<void>((resolve) => {
				// Add null check for pid
				if (processInfo.pid) {
					// promisify(treeKill) expects only pid
					killProcessTree(processInfo.pid) // <-- Needs killProcessTree
						.then(() => {
							// Resolve after successful kill
							resolve();
						})
						.catch((err: Error | null) => {
							if (err) {
								log.error(
									label,
									`Error stopping process tree for ${label}:`,
									err,
								);
							}
							// Resolve regardless of error to not block shutdown
							resolve();
						});
				} else {
					log.warn(label, "Cannot kill process tree, PID is missing.");
					resolve(); // Resolve anyway
				}
			});
			stopPromises.push(stopPromise);
		} else {
			log.warn(label, `Process ${label} has no active process or PID to stop.`);
		}

		// --- Close Log Stream on Shutdown ---
		if (processInfo.logFileStream) {
			log.info(
				label,
				`Closing log stream for ${label} during server shutdown.`,
			);
			processInfo.logFileStream.end();
			processInfo.logFileStream = null; // Nullify
		}
		// --- End Close Log Stream ---
	});

	// Clear the map *before* awaiting promises, as handleExit might be called
	// managedProcesses.clear(); // Let handleExit clear individual entries

	// Optionally wait for all stop commands to be issued (not necessarily completed)
	// await Promise.all(stopPromises); // Doesn't guarantee processes are dead

	// For a more robust shutdown, might need a timeout or check loop here
	log.info(null, "Issued stop commands for all processes.");
	managedProcesses.clear(); // Clear the map finally // <-- Needs managedProcesses import
}
