import { cfg } from "../constants/index.js"; // Update path
import { killProcessTree } from "../processLifecycle.js";
import {
	addLogEntry,
	getShellInfo,
	removeShell,
	updateProcessStatus,
} from "../state.js"; // Adjust path
import { managedShells } from "../state.js"; // Need state access
import { log } from "../utils.js"; // Adjust path
import { startShellWithVerification } from "./lifecycle.js"; // Import the new startProcess

/**
 * Handles the logic for retrying a crashed shell.
 *
 * @param label The label of the crashed shell.
 */
export async function handleCrashAndRetry(label: string): Promise<void> {
	const shellInfo = getShellInfo(label); // Use getShellInfo to ensure latest state
	if (!shellInfo || shellInfo.status !== "crashed") {
		log.warn(
			label,
			"handleCrashAndRetry called but shell not found or not in crashed state.",
		);
		return;
	}

	const now = Date.now();
	const maxRetries = shellInfo.maxRetries ?? cfg.maxRetries;
	const retryDelay = shellInfo.retryDelayMs ?? cfg.defaultRetryDelayMs;

	// Reset restart attempts if outside the crash loop window
	if (
		shellInfo.lastCrashTime &&
		now - shellInfo.lastCrashTime > cfg.crashLoopDetectionWindowMs
	) {
		log.info(label, "Resetting restart attempts, outside crash loop window.");
		shellInfo.restartAttempts = 0;
	}

	shellInfo.lastCrashTime = now;
	shellInfo.restartAttempts = (shellInfo.restartAttempts ?? 0) + 1;

	if (shellInfo.restartAttempts > maxRetries) {
		log.warn(
			label,
			`Crash detected. Shell exceeded max retries (${maxRetries}). Marking as error.`,
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
			`Crash detected. Attempting restart ${shellInfo.restartAttempts}/${maxRetries} after ${retryDelay}ms...`,
		);
		addLogEntry(
			label,
			`Crash detected. Attempting restart ${shellInfo.restartAttempts}/${maxRetries}...`,
		);
		updateProcessStatus(label, "restarting");

		// Use await with setTimeout for delay
		await new Promise((resolve) => setTimeout(resolve, retryDelay));

		log.info(label, "Initiating restart...");
		// Call the new startProcessWithVerification from lifecycle.ts
		await startShellWithVerification(
			label,
			shellInfo.command,
			shellInfo.args,
			shellInfo.cwd,
			shellInfo.host,
			shellInfo.verificationPattern,
			shellInfo.verificationTimeoutMs,
			shellInfo.retryDelayMs,
			shellInfo.maxRetries,
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
	const shellInfo = getShellInfo(label);
	if (!shellInfo) {
		log.warn(label, "handleProcessExit called but shell info not found.");
		return;
	}

	// Close Log Stream
	if (shellInfo.logFileStream) {
		log.debug(label, `Closing log file stream for ${label} due to exit.`);
		addLogEntry(
			label,
			`--- Process Exited (Code: ${code ?? "N/A"}, Signal: ${signal ?? "N/A"}) ---`,
		);
		shellInfo.logFileStream.end(() => {
			log.debug(
				label,
				`Log file stream for ${label} finished writing and closed.`,
			);
		});
		shellInfo.logFileStream = null;
	}

	const status = shellInfo.status;

	// Explicitly stopped
	if (status === "stopping") {
		log.info(
			label,
			`Shell was explicitly stopped. Final code: ${code}, signal: ${signal}`,
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
				`Shell purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
	}
	// Exited cleanly during startup/verification (let startShell handle final state)
	else if (code === 0 && (status === "starting" || status === "verifying")) {
		log.info(label, `Shell exited cleanly (code 0) during ${status} phase.`);
		// Store exit info for startShell to check
		shellInfo.exitCode = code;
		shellInfo.signal = signal;
		shellInfo.lastExitTimestamp = Date.now();
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
				`Shell purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
	}
	// Unexpected exit (crash)
	else if (status !== "stopped" && status !== "error" && status !== "crashed") {
		log.warn(
			label,
			`Shell exited unexpectedly (code: ${code}, signal: ${signal}). Marking as crashed.`,
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
				`Shell purged from management after reaching terminal state: ${updatedInfo.status}`,
			);
		}
		// Check retry configuration
		if (
			shellInfo.maxRetries !== undefined &&
			shellInfo.maxRetries > 0 &&
			shellInfo.retryDelayMs !== undefined
		) {
			void handleCrashAndRetry(label); // Fire-and-forget retry handler
		} else {
			log.info(label, "Shell crashed, but no retry configured.");
			addLogEntry(label, "Shell crashed. No retry configured.");
		}
	} else {
		log.info(
			label,
			`Shell exited but was already in state ${status}. No status change.`,
		);
	}

	// --- Cleanup Listeners (moved from state.ts) ---
	if (shellInfo.mainDataListenerDisposable) {
		log.debug(label, "Disposing main data listener on exit.");
		shellInfo.mainDataListenerDisposable.dispose();
		shellInfo.mainDataListenerDisposable = undefined;
	}
	if (shellInfo.mainExitListenerDisposable) {
		log.debug(label, "Disposing main exit listener on exit.");
		shellInfo.mainExitListenerDisposable.dispose();
		shellInfo.mainExitListenerDisposable = undefined;
	}
	// Set shell handle to null AFTER disposing listeners
	shellInfo.shell = null;
	shellInfo.pid = undefined; // Clear PID as well
}

/**
 * Stops all managed shells, typically called on server exit.
 */
export function stopAllShellsOnExit(): void {
	log.info(null, "Stopping all managed shells on exit...");
	const stopPromises: Promise<void>[] = [];

	managedShells.forEach((shellInfo, label) => {
		log.info(
			label,
			`Attempting to stop shell ${label} (PID: ${shellInfo.pid})...`,
		);
		if (shellInfo.shell && shellInfo.pid) {
			updateProcessStatus(label, "stopping");
			const stopPromise = new Promise<void>((resolve) => {
				if (shellInfo.pid) {
					killProcessTree(shellInfo.pid)
						.then(() => {
							resolve();
						})
						.catch((err: unknown) => {
							if (err instanceof Error) {
								log.warn(
									label,
									`Error stopping process tree for ${label}: ${err.message}`,
								);
							} else {
								log.warn(
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
			log.warn(label, `Shell ${label} has no active process or PID to stop.`);
		}

		// Close Log Stream on Shutdown
		if (shellInfo.logFileStream) {
			log.info(
				label,
				`Closing log stream for ${label} during server shutdown.`,
			);
			shellInfo.logFileStream.end();
			shellInfo.logFileStream = null;
		}
	});

	log.info(null, "Issued stop commands for all shells.");
	managedShells.clear();
}
