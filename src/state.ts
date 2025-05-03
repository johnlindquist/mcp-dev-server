import { cfg } from "./constants/index.js";
import type { LogEntry, ShellInfo, ShellStatus } from "./types/process.js"; // Update path
import { log } from "./utils.js";

// Renamed Map
export const managedProcesses: Map<string, ShellInfo> = new Map();

// REMOVE: const killProcessTree = promisify(treeKill); // Define killProcessTree here

export function addLogEntry(label: string, content: string): void {
	const shellInfo = managedProcesses.get(label);
	if (!shellInfo) {
		log.warn(
			label,
			`[addLogEntry] Attempted to add log entry for unknown process: ${label}`,
		);
		return;
	}
	const entry: LogEntry = { timestamp: Date.now(), content };
	log.debug(
		label,
		`[state.addLogEntry] Pushing log entry (ts: ${entry.timestamp}): ${content.substring(0, 100)}`,
	);
	shellInfo.logs.push(entry);
	log.debug(
		label,
		`[state.addLogEntry] Pushed entry. New log count: ${shellInfo.logs.length}`,
	);

	// Enforce the maximum in-memory log line limit
	if (shellInfo.logs.length > cfg.maxStoredLogLines) {
		shellInfo.logs.shift();
	}

	// --- Write to file stream ---
	// Use optional chaining where appropriate, but keep explicit check for write logic
	if (shellInfo.logFileStream?.writable) {
		try {
			// Write the raw content + newline. Error handled by stream 'error' listener.
			shellInfo.logFileStream.write(`${content}\n`); // Use template literal
		} catch (writeError) {
			// This catch might not be strictly necessary due to the async nature
			// and the 'error' listener, but added for robustness.
			log.error(
				label,
				`Direct error writing to log stream for ${label}`,
				writeError,
			);
			shellInfo.logFileStream?.end(); // Attempt to close on direct error (optional chain)
			shellInfo.logFileStream = null;
			shellInfo.logFilePath = null; // Mark as unusable
		}
	}
	// --- End write to file stream ---
}

// Renamed function
export function updateProcessStatus(
	label: string,
	status: ShellStatus,
	exitInfo?: { code: number | null; signal: string | null },
): ShellInfo | undefined {
	const oldProcessInfo = managedProcesses.get(label);
	if (!oldProcessInfo) {
		log.warn(label, "Attempted to update status but process info missing.");
		return undefined;
	}

	const oldStatus = oldProcessInfo.status;
	if (oldStatus === status) {
		log.debug(label, `[updateProcessStatus] Status unchanged: ${status}`);
		return oldProcessInfo; // No change, return the old object
	}

	log.info(label, `Status changing from ${oldStatus} to ${status}`);

	// Create a NEW object with the updated status and other info
	const newProcessInfo: ShellInfo = {
		...oldProcessInfo, // Copy existing properties
		status: status, // Set the new status
		// Update exit code/signal/timestamp if applicable
		...(["stopped", "crashed", "error"].includes(status) && {
			exitCode: exitInfo?.code ?? oldProcessInfo.exitCode ?? null,
			signal: exitInfo?.signal ?? oldProcessInfo.signal ?? null,
			lastExitTimestamp: Date.now(),
		}),
		// Explicitly reset exit info if moving to a non-terminal state
		...(!["stopped", "crashed", "error"].includes(status) && {
			exitCode: null,
			signal: null,
		}),
	};

	// REPLACE the object in the map
	managedProcesses.set(label, newProcessInfo);

	// Log AFTER the update
	addLogEntry(label, `Status changed to ${status}`);

	// Clear verification timer if process moves out of 'verifying' state
	// Note: timer is on the OLD object, but clearTimeout should still work
	if (
		oldStatus === "verifying" &&
		status !== "verifying" &&
		oldProcessInfo.verificationTimer // Check timer on the OLD object reference
	) {
		clearTimeout(oldProcessInfo.verificationTimer);
		// No need to set newProcessInfo.verificationTimer = undefined, it wasn't copied
	}

	// Log when reaching stable running state or ending
	if (status === "running" && oldStatus !== "running") {
		log.info(label, "Process reached stable running state.");
		addLogEntry(label, "Process reached stable running state.");
	} else if (["stopped", "crashed", "error"].includes(status)) {
		addLogEntry(
			label,
			`Process ended. Code: ${newProcessInfo.exitCode}, Signal: ${newProcessInfo.signal}`,
		);
	}

	return newProcessInfo; // Return the NEW object reference
}

export function removeShell(label: string): void {
	const processInfo = managedProcesses.get(label);
	// The try...catch block was here, but the try was empty.
	// If cleanup logic is needed for processInfo.process, it should go here.
	managedProcesses.delete(label);
	log.debug(label, "Removed process info from management.");
}

export function getShellInfo(label: string): ShellInfo | undefined {
	const found = managedProcesses.get(label);
	return found;
}
