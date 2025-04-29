import { handleCrashAndRetry } from "./processLifecycle.js"; // Import retry logic
import { addLogEntry, managedProcesses, updateProcessStatus } from "./state.js";
import type { ProcessInfo } from "./types.js"; // Import necessary types
import { log } from "./utils.js";

// Keep zombieCheckIntervalId managed via exported functions
let zombieCheckIntervalIdInternal: NodeJS.Timeout | null = null;

// --- doesProcessExist function --- (Copied from state.ts)
export function doesProcessExist(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e) {
			if (e.code === "ESRCH") return false;
			if (e.code === "EPERM") return true;
		}
		return false;
	}
}

// --- checkAndUpdateProcessStatus function --- (Copied from state.ts)
// This function now calls handleCrashAndRetry if correction leads to 'crashed' state
export async function checkAndUpdateProcessStatus(
	label: string,
): Promise<ProcessInfo | null> {
	const processInfo = managedProcesses.get(label);
	if (!processInfo) {
		return null;
	}

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
			updateProcessStatus(label, "crashed", { code: -1, signal: null });
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

// --- reapZombies function --- (Copied from state.ts)
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
				// Call the local checkAndUpdateProcessStatus which handles logging, status update, and retry trigger
				await checkAndUpdateProcessStatus(label);
				correctedCount++; // Increment count if a correction was triggered
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

// --- setZombieCheckInterval function --- (Copied from state.ts)
export function setZombieCheckInterval(intervalMs: number): void {
	if (zombieCheckIntervalIdInternal) {
		clearInterval(zombieCheckIntervalIdInternal);
	}
	log.info(null, `Setting zombie process check interval to ${intervalMs}ms.`);
	zombieCheckIntervalIdInternal = setInterval(() => {
		void reapZombies();
	}, intervalMs);
}

// --- isZombieCheckActive function --- (Copied from state.ts)
export function isZombieCheckActive(): boolean {
	return !!zombieCheckIntervalIdInternal;
}

// --- clearZombieCheckInterval function --- (New)
export function clearZombieCheckInterval(): void {
	if (zombieCheckIntervalIdInternal) {
		clearInterval(zombieCheckIntervalIdInternal);
		zombieCheckIntervalIdInternal = null;
		log.info(null, "Cleared zombie check interval.");
	}
}
