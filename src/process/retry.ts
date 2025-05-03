import { cfg } from "../constants/index.js"; // Update path
import { killProcessTree } from "../processLifecycle.js";
import {
	addLogEntry,
	getShellInfo,
	removeShell,
	updateProcessStatus,
} from "../state.js"; // Adjust path
import { managedProcesses } from "../state.js"; // Need state access
import { log } from "../utils.js"; // Adjust path
import { startShellWithVerification } from "./lifecycle.js"; // Import the new startProcess

/**
 * Handles the logic for retrying a crashed process.
 *
 * @param label The label of the crashed process.
 */
export async function handleShellCrashAndRetry(label: string): Promise<void> {
	const processInfo = getShellInfo(label); // Use getProcessInfo to ensure latest state
	if (!processInfo || processInfo.status !== "crashed") {
		log.warn(
			label,
			"handleCrashAndRetry called but process not found or not in crashed state.",
		);
		return;
	}

	const now = Date.now();
	const maxRetries = processInfo.maxRetries ?? cfg.maxRetries;
	const retryDelay = processInfo.retryDelayMs ?? cfg.defaultRetryDelayMs;

	// Reset restart attempts if outside the crash loop window
	if (
		processInfo.lastCrashTime &&
		now - processInfo.lastCrashTime > cfg.crashLoopDetectionWindowMs
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
		// Call the new startProcessWithVerification from lifecycle.ts
		await startShellWithVerification(
			label,
			processInfo.command,
			processInfo.args,
			processInfo.cwd,
			processInfo.host,
			processInfo.verificationPattern,
			processInfo.verificationTimeoutMs,
			processInfo.retryDelayMs,
			processInfo.maxRetries,
			true, // Indicate this is a restart
		);
	}
}

/**
 * Handles the overall process exit, including determining the final state
 * and triggering crash retries if necessary.
 *
 * @param label The label of the process that exited.
 * @param code The exit code (null if killed by signal).
 * @param signal The signal name (null if exited normally).
 */
export function handleShellExit(
	label: string,
	code: number | null,
	signal: string | null,
): void {
	const processInfo = getShellInfo(label);
	if (!processInfo) {
		log.warn(label, "handleProcessExit called but process info not found.");
		return;
	}

	// Close Log Stream
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
		processInfo.logFileStream = null;
	}

	const status = processInfo.status;

	// Explicitly stopped
	if (status === "stopping") {
		log.info(
			label,
			`Process was explicitly stopped. Final code: ${code}, signal: ${signal}`,
		);
		updateProcessStatus(label, "stopped", { code, signal });
		const updatedInfo = getShellInfo(label);
		if (
			updatedInfo &&
			["stopped", "crashed", "error"].includes(updatedInfo.status)
		) {
			removeShell(label);
			log.info(
				label,
				`Process purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
	}
	// Exited cleanly during startup/verification (let startProcess handle final state)
	else if (code === 0 && (status === "starting" || status === "verifying")) {
		log.info(label, `Process exited cleanly (code 0) during ${status} phase.`);
		// Store exit info for startProcess to check
		processInfo.exitCode = code;
		processInfo.signal = signal;
		processInfo.lastExitTimestamp = Date.now();
	}
	// Exited cleanly while running
	else if (code === 0 && status === "running") {
		log.info(
			label,
			`[handleProcessExit] Condition met: code === 0 && status === \"running\". Calling updateProcessStatus('stopped').`,
		);
		updateProcessStatus(label, "stopped", { code, signal });
		const updatedInfo = getShellInfo(label);
		if (
			updatedInfo &&
			["stopped", "crashed", "error"].includes(updatedInfo.status)
		) {
			removeShell(label);
			log.info(
				label,
				`Process purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
	}
	// Unexpected exit (crash)
	else if (status !== "stopped" && status !== "error" && status !== "crashed") {
		log.warn(
			label,
			`Process exited unexpectedly (code: ${code}, signal: ${signal}). Marking as crashed.`,
		);
		updateProcessStatus(label, "crashed", { code, signal });
		const updatedInfo = getShellInfo(label);
		if (
			updatedInfo &&
			["stopped", "crashed", "error"].includes(updatedInfo.status)
		) {
			removeShell(label);
			log.info(
				label,
				`Process purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
		// Check retry configuration
		if (
			processInfo.maxRetries !== undefined &&
			processInfo.maxRetries > 0 &&
			processInfo.retryDelayMs !== undefined
		) {
			void handleShellCrashAndRetry(label); // Fire-and-forget retry handler
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

	// --- Cleanup Listeners (moved from state.ts) ---
	if (processInfo.mainDataListenerDisposable) {
		log.debug(label, "Disposing main data listener on exit.");
		processInfo.mainDataListenerDisposable.dispose();
		processInfo.mainDataListenerDisposable = undefined;
	}
	if (processInfo.mainExitListenerDisposable) {
		log.debug(label, "Disposing main exit listener on exit.");
		processInfo.mainExitListenerDisposable.dispose();
		processInfo.mainExitListenerDisposable = undefined;
	}
	// Set process handle to null AFTER disposing listeners
	processInfo.shell = null;
	processInfo.pid = undefined; // Clear PID as well
}

/**
 * Stops all managed processes, typically called on server exit.
 */
export function stopAllShellsOnExit(): void {
	log.info(null, "Stopping all managed processes on exit...");
	const stopPromises: Promise<void>[] = [];

	managedProcesses.forEach((processInfo, label) => {
		log.info(
			label,
			`Attempting to stop process ${label} (PID: ${processInfo.pid})...`,
		);
		if (processInfo.shell && processInfo.pid) {
			updateProcessStatus(label, "stopping");
			const stopPromise = new Promise<void>((resolve) => {
				if (processInfo.pid) {
					killProcessTree(processInfo.pid)
						.then(() => {
							resolve();
						})
						.catch((err: unknown) => {
							if (err instanceof Error) {
								log.error(
									label,
									`Error stopping process tree for ${label}: ${err.message}`,
								);
							} else {
								log.error(
									label,
									`Error stopping process tree for ${label}: Unknown error`,
									err,
								);
							}
							resolve();
						});
				} else {
					log.warn(label, "Cannot kill process tree, PID is missing.");
					resolve();
				}
			});
			stopPromises.push(stopPromise);
		} else {
			log.warn(label, `Process ${label} has no active process or PID to stop.`);
		}

		// Close Log Stream on Shutdown
		if (processInfo.logFileStream) {
			log.info(
				label,
				`Closing log stream for ${label} during server shutdown.`,
			);
			processInfo.logFileStream.end();
			processInfo.logFileStream = null;
		}
	});

	log.info(null, "Issued stop commands for all processes.");
	managedProcesses.clear();
}
