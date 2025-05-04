import { managedShells, updateProcessStatus } from "./state.js";
import type { ShellInfo } from "./types/process.js"; // Update path
import { log } from "./utils.js";

// Keep zombieCheckIntervalId managed via exported functions
let zombieCheckIntervalIdInternal: NodeJS.Timeout | null = null;

// --- doesProcessExist function --- (Copied from state.ts)
export function doesShellExist(pid: number): boolean {
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
): Promise<ShellInfo | undefined> {
	const initialProcessInfo = managedShells.get(label);
	// ---> ADDED LOG: Log status at start
	log.debug(
		label,
		`[checkAndUpdateProcessStatus START] Initial ProcessInfo found: ${!!initialProcessInfo}, Status: ${initialProcessInfo?.status}`,
	);
	// ---> END ADDED LOG

	if (!initialProcessInfo) {
		log.warn(label, "checkAndUpdateProcessStatus: Process not found.");
		return undefined;
	}

	// Only update if the process is potentially active
	if (
		initialProcessInfo.status === "running" ||
		initialProcessInfo.status === "verifying" ||
		initialProcessInfo.status === "starting"
	) {
		// Use process.kill(0) to check if the process exists
		try {
			if (initialProcessInfo.pid) {
				process.kill(initialProcessInfo.pid, 0);
				// Process exists, status remains the same unless PTY exit event handled it
				log.debug(
					label,
					`Process check (kill 0): PID ${initialProcessInfo.pid} exists. Status remains ${initialProcessInfo.status}.`,
				);
			} else {
				log.warn(
					label,
					`Process check: Status is ${initialProcessInfo.status} but PID is missing. Updating to error.`,
				);
				updateProcessStatus(label, "error");
			}
		} catch (error: unknown) {
			// If kill(0) throws, process likely doesn't exist
			if (error && typeof error === "object" && "code" in error) {
				if (error.code === "ESRCH") {
					// If the state map says 'running' but the OS says the process is gone,
					// trust the OS and update the state map to 'stopped' immediately.
					if (initialProcessInfo.status === "running") {
						log.info(
							label,
							`Process check (kill 0): PID ${initialProcessInfo.pid} not found (ESRCH) but status was 'running'. Updating status to stopped.`,
						);
						// Update status to stopped, assuming clean exit (code 0)
						updateProcessStatus(label, "stopped", { code: 0, signal: null });
					} else {
						// If status wasn't 'running' when ESRCH detected, it likely crashed unexpectedly.
						log.warn(
							label,
							`Process check (kill 0): PID ${initialProcessInfo.pid} not found (ESRCH). Current status ${initialProcessInfo.status}. Updating status to crashed.`,
						);
						updateProcessStatus(label, "crashed"); // Okay to set crashed if it wasn't 'running'
					}
				} else {
					// Check if it's an Error instance before accessing message
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					log.error(
						label,
						`Process check (kill 0): Unexpected error for PID ${initialProcessInfo.pid}: ${errorMsg}. Status remains ${initialProcessInfo.status}.`,
					);
				}
			}
		}
	} else {
		log.debug(
			label,
			`Process check: Status is ${initialProcessInfo.status}. No update needed.`,
		);
	}

	// Re-fetch the potentially updated info from state
	const finalProcessInfo = managedShells.get(label);
	return finalProcessInfo;
}

// --- reapZombies function --- (Copied from state.ts)
export async function reapZombies(): Promise<void> {
	log.debug(null, "Running zombie process check...");
	let correctedCount = 0;
	for (const [label, processInfo] of managedShells.entries()) {
		if (
			processInfo.pid &&
			(processInfo.status === "running" ||
				processInfo.status === "starting" ||
				processInfo.status === "verifying" ||
				processInfo.status === "restarting")
		) {
			if (!doesShellExist(processInfo.pid)) {
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
