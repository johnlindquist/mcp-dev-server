import { promisify } from "node:util"; // Add import
import treeKill from "tree-kill"; // Add import
import { MAX_STORED_LOG_LINES } from "./constants.js";
import type { LogEntry, ProcessInfo, ProcessStatus } from "./types.ts"; // Import LogEntry from types.ts
import { log } from "./utils.js";

// Renamed Map
export const managedProcesses: Map<string, ProcessInfo> = new Map();

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
