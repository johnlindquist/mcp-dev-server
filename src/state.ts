// src/state.ts

import type { IPty } from "node-pty";
import {
	CRASH_LOOP_DETECTION_WINDOW_MS,
	DEFAULT_RETRY_DELAY_MS,
	LOG_LINE_LIMIT,
	MAX_RETRIES,
} from "./constants.js";
import { _startProcess } from "./processLogic.js"; // Corrected import path
import { ok } from "./types.js";
import type { LogEntry, ProcessInfo, ProcessStatus } from "./types.ts"; // Import LogEntry from types.ts
import { log } from "./utils.js";

// Renamed Map
export const managedProcesses: Map<string, ProcessInfo> = new Map();
export let zombieCheckIntervalId: NodeJS.Timeout | null = null;

export function addLogEntry(label: string, content: string): void {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		log.warn(
			label,
			`Attempted to add log but process info missing for label: ${label}`,
		);
		return;
	}

	const entry: LogEntry = { timestamp: Date.now(), content };
	processInfo.logs.push(entry);
	if (processInfo.logs.length > LOG_LINE_LIMIT) {
		processInfo.logs.shift(); // Keep the log buffer trimmed
	}
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

// Rename _startServer call later
export async function handleCrashAndRetry(label: string): Promise<void> {
	const processInfo = managedProcesses.get(label);
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
		await _startProcess(
			label,
			processInfo.command,
			processInfo.args, // Pass args
			processInfo.cwd,
			processInfo.verificationPattern,
			processInfo.verificationTimeoutMs,
			processInfo.retryDelayMs, // Pass retry settings
			processInfo.maxRetries, // Pass retry settings
			true, // Indicate this is a restart
		);
	}
}

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

	const status = processInfo.status;
	const exitCode = code ?? -1; // Use -1 if code is null
	const signalDesc = signal ? ` (signal ${signal})` : "";
	const logMessage = `Process exited with code ${exitCode}${signalDesc}.`;
	log.info(label, logMessage);
	addLogEntry(label, logMessage);

	// Determine if it's a crash or a clean stop
	if (status === "stopping") {
		updateProcessStatus(label, "stopped", { code, signal });
	} else if (status !== "stopped" && status !== "error") {
		// Any other unexpected exit is treated as a crash
		updateProcessStatus(label, "crashed", { code, signal });
		// Don't retry immediately here, let checkAndUpdateProcessStatus or explicit restart handle it
		// Check if retry is configured and appropriate
		if (
			processInfo.maxRetries !== undefined &&
			processInfo.maxRetries > 0 &&
			processInfo.retryDelayMs !== undefined
		) {
			// Use void to explicitly ignore the promise for fire-and-forget
			void handleCrashAndRetry(label);
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
	let killCount = 0;
	const promises: Promise<void>[] = [];

	managedProcesses.forEach((processInfo, label) => {
		if (
			processInfo.process &&
			processInfo.pid &&
			(processInfo.status === "running" ||
				processInfo.status === "starting" ||
				processInfo.status === "verifying" ||
				processInfo.status === "restarting")
		) {
			log.info(label, `Sending SIGTERM to PID ${processInfo.pid} on exit.`);
			try {
				// Use the process handle if available, otherwise PID
				if (processInfo.process) {
					processInfo.process.kill("SIGTERM"); // node-pty uses kill method
				} else if (processInfo.pid) {
					process.kill(processInfo.pid, "SIGTERM");
				}
				updateProcessStatus(label, "stopping");
				killCount++;
				// We might not be able to wait for confirmation here during exit
			} catch (err: unknown) {
				log.error(
					label,
					`Error sending SIGTERM on exit: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	});

	if (killCount > 0) {
		log.info(null, `Attempted final termination for ${killCount} processes.`);
	} else {
		log.info(null, "No active processes needed termination on exit.");
	}
	// Clear the interval on exit
	if (zombieCheckIntervalId) {
		clearInterval(zombieCheckIntervalId);
		zombieCheckIntervalId = null;
	}
	managedProcesses.clear(); // Clear the map
}
