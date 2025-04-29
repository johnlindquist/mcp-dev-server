import { promisify } from "node:util"; // Add import
import treeKill from "tree-kill"; // Add import
import { MAX_STORED_LOG_LINES } from "./constants.js";
import { handleCrashAndRetry } from "./processLifecycle.js"; // Import from new location
import type { LogEntry, ProcessInfo, ProcessStatus } from "./types.ts"; // Import LogEntry from types.ts
import { log } from "./utils.js";

// Renamed Map
export const managedProcesses: Map<string, ProcessInfo> = new Map();
export let zombieCheckIntervalId: NodeJS.Timeout | null = null; // Export directly

const killProcessTree = promisify(treeKill); // Define killProcessTree here

export function addLogEntry(label: string, content: string): void {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		// Log warning removed for brevity, handled elsewhere if needed
		return;
	}

	const entry: LogEntry = { timestamp: Date.now(), content };
	processInfo.logs.push(entry);

	// Enforce the maximum in-memory log line limit
	if (processInfo.logs.length > MAX_STORED_LOG_LINES) {
		processInfo.logs.shift();
	}

	// --- Write to file stream ---
	// Use optional chaining where appropriate, but keep explicit check for write logic
	if (processInfo.logFileStream?.writable) {
		try {
			// Write the raw content + newline. Error handled by stream 'error' listener.
			processInfo.logFileStream.write(`${content}\n`); // Use template literal
		} catch (writeError) {
			// This catch might not be strictly necessary due to the async nature
			// and the 'error' listener, but added for robustness.
			log.error(
				label,
				`Direct error writing to log stream for ${label}`,
				writeError,
			);
			processInfo.logFileStream?.end(); // Attempt to close on direct error (optional chain)
			processInfo.logFileStream = null;
			processInfo.logFilePath = null; // Mark as unusable
		}
	}
	// --- End write to file stream ---
}

// Renamed function
export function updateProcessStatus(
	label: string,
	status: ProcessStatus,
	exitInfo?: { code: number | null; signal: string | null },
): ProcessInfo | undefined {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		log.warn(label, "Attempted to update status but process info missing.");
		return undefined;
	}

	const oldStatus = processInfo.status;
	if (oldStatus === status) return processInfo; // No change

	processInfo.status = status;
	if (exitInfo) {
		processInfo.exitCode = exitInfo.code;
		processInfo.signal = exitInfo.signal;
	} else {
		// Reset exit info if moving to a non-terminal state
		processInfo.exitCode = null;
		processInfo.signal = null;
	}

	log.info(label, `Status changing from ${oldStatus} to ${status}`);
	addLogEntry(label, `Status changed to ${status}`);

	// Clear verification timer if process moves out of 'verifying' state
	if (
		oldStatus === "verifying" &&
		status !== "verifying" &&
		processInfo.verificationTimer
	) {
		clearTimeout(processInfo.verificationTimer);
		processInfo.verificationTimer = undefined;
	}

	// Log when reaching stable running state
	if (status === "running" && oldStatus !== "running") {
		log.info(label, "Process reached stable running state.");
		addLogEntry(label, "Process reached stable running state.");
	}

	return processInfo;
}

export function doesProcessExist(pid: number): boolean {
	try {
		// Sending signal 0 doesn't actually send a signal but checks if the process exists.
		process.kill(pid, 0);
		return true;
	} catch (e: unknown) {
		// Check for specific error codes
		if (e && typeof e === "object" && "code" in e) {
			if (e.code === "ESRCH") return false; // No such process
			if (e.code === "EPERM") return true; // Operation not permitted, but process exists
		}
		// Assume false for other errors or if error structure is unexpected
		return false;
	}
}

// Renamed function
export async function checkAndUpdateProcessStatus(
	label: string,
): Promise<ProcessInfo | null> {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		return null;
	}

	// If process has a PID, check if it's still running
	if (
		processInfo.pid &&
		(processInfo.status === "running" ||
			processInfo.status === "starting" ||
			processInfo.status === "verifying" ||
			processInfo.status === "restarting")
	) {
		if (!doesProcessExist(processInfo.pid)) {
			log.warn(
				label,
				`Correcting status: Process PID ${processInfo.pid} not found, but status was '${processInfo.status}'. Marking as crashed.`,
			);
			addLogEntry(
				label,
				`Detected process PID ${processInfo.pid} no longer exists.`,
			);
			// Treat as a crash if it disappeared unexpectedly
			updateProcessStatus(label, "crashed", { code: -1, signal: null }); // Use a conventional code for "disappeared"
			// Trigger retry if configured
			if (
				processInfo.maxRetries !== undefined &&
				processInfo.maxRetries > 0 &&
				processInfo.retryDelayMs !== undefined
			) {
				void handleCrashAndRetry(label); // Fire and forget retry
			}
		}
	}

	return processInfo;
}

// --- Zombie Process Handling ---

export async function reapZombies(): Promise<void> {
	log.debug(null, "Running zombie process check...");
	let correctedCount = 0;
	for (const [label, processInfo] of managedProcesses.entries()) {
		if (
			processInfo.pid &&
			(processInfo.status === "running" ||
				processInfo.status === "starting" ||
				processInfo.status === "verifying" ||
				processInfo.status === "restarting")
		) {
			if (!doesProcessExist(processInfo.pid)) {
				log.warn(
					label,
					`Correcting status via zombie check: Process PID ${processInfo.pid} not found, but status was '${processInfo.status}'. Marking as crashed.`,
				);
				addLogEntry(
					label,
					`Zombie check detected process PID ${processInfo.pid} no longer exists.`,
				);
				updateProcessStatus(label, "crashed", { code: -1, signal: null });
				correctedCount++;
				// Trigger retry if configured
				if (
					processInfo.maxRetries !== undefined &&
					processInfo.maxRetries > 0 &&
					processInfo.retryDelayMs !== undefined
				) {
					void handleCrashAndRetry(label); // Fire and forget retry
				}
			}
		}
	}
	if (correctedCount > 0) {
		log.info(
			null,
			`Zombie check completed. Corrected status for ${correctedCount} processes.`,
		);
	} else {
		log.debug(null, "Zombie check completed. No zombie processes found.");
	}
}

export function setZombieCheckInterval(intervalMs: number): void {
	if (zombieCheckIntervalId) {
		clearInterval(zombieCheckIntervalId);
	}
	log.info(null, `Setting zombie process check interval to ${intervalMs}ms.`);
	zombieCheckIntervalId = setInterval(() => {
		void reapZombies(); // Use void for fire-and-forget async call
	}, intervalMs);
}

// --- Graceful Shutdown ---

export function stopAllProcessesOnExit(): void {
	log.info(null, "Stopping all managed processes on exit...");
	const stopPromises: Promise<void>[] = [];

	managedProcesses.forEach((processInfo, label) => {
		log.info(
			label,
			`Attempting to stop process ${label} (PID: ${processInfo.pid})...`,
		);
		if (processInfo.process && processInfo.pid) {
			updateProcessStatus(label, "stopping");
			// Create a promise for each stop operation
			const stopPromise = new Promise<void>((resolve) => {
				// Add null check for pid
				if (processInfo.pid) {
					// promisify(treeKill) expects only pid
					killProcessTree(processInfo.pid)
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
	managedProcesses.clear(); // Clear the map finally
}

export function removeProcess(label: string): void {
	const processInfo = managedProcesses.get(label);
	// The try...catch block was here, but the try was empty.
	// If cleanup logic is needed for processInfo.process, it should go here.
	managedProcesses.delete(label);
	log.debug(label, "Removed process info from management.");
}

export function isZombieCheckActive(): boolean {
	return !!zombieCheckIntervalId;
}
