// Intentionally empty for now. Will contain shell verification logic (startup pattern, log settle).

import type { IDisposable, IPty } from "node-pty";
import { cfg } from "../constants/index.js"; // Update path
import { getShellInfo, updateProcessStatus } from "../state.js"; // Adjust path
import { log } from "../utils.js"; // Adjust path
import { handleData } from "./lifecycle.js"; // Assuming handleData moves to lifecycle

/**
 * Waits until logs have settled (no new data for a duration) or an overall timeout is reached.
 * Listens temporarily to the PTY process data stream.
 *
 * @param label Shell label for logging.
 * @param ptyShell The node-pty shell instance.
 * @returns A promise that resolves when logs settle or timeout occurs.
 */
export async function waitForLogSettleOrTimeout(
	label: string,
	ptyShell: IPty,
): Promise<{ settled: boolean; timedOut: boolean }> {
	return new Promise((resolve) => {
		let settleTimerId: NodeJS.Timeout | null = null;
		let overallTimeoutId: NodeJS.Timeout | null = null;
		let settled = false;
		let timedOut = false;
		let dataListenerDisposable: IDisposable | null = null;
		let exitListenerDisposable: IDisposable | null = null; // Added exit listener

		const cleanup = () => {
			if (settleTimerId) clearTimeout(settleTimerId);
			if (overallTimeoutId) clearTimeout(overallTimeoutId);
			if (dataListenerDisposable) {
				log.debug(
					label,
					"[waitForLogSettleOrTimeout] Disposing temporary data listener.",
				);
				dataListenerDisposable.dispose();
			}
			if (exitListenerDisposable) {
				log.debug(
					label,
					"[waitForLogSettleOrTimeout] Disposing temporary exit listener.",
				);
				exitListenerDisposable.dispose();
			}
			settleTimerId = null;
			overallTimeoutId = null;
			dataListenerDisposable = null;
			exitListenerDisposable = null; // Clear exit listener
		};

		const onSettle = () => {
			if (timedOut) return; // Don't resolve if already timed out
			log.debug(
				label,
				`Logs settled after ${cfg.logSettleDurationMs}ms pause.`,
			);
			settled = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const onOverallTimeout = () => {
			if (settled) return; // Don't resolve if already settled
			log.warn(
				label,
				`Overall log wait timeout (${cfg.overallLogWaitTimeoutMs}ms) reached. Proceeding with captured logs.`,
			);
			timedOut = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const onProcessExit = ({
			exitCode,
			signal,
		}: { exitCode: number; signal?: number }) => {
			if (settled || timedOut) return; // Don't act if already resolved
			log.warn(
				label,
				`Shell exited (code: ${exitCode}, signal: ${signal}) during log settle wait.`,
			);
			// Indicate timeout as the reason for stopping the wait, even though it was an exit
			timedOut = true;
			cleanup();
			resolve({ settled, timedOut });
		};

		const resetSettleTimer = () => {
			if (settled || timedOut) return; // Don't reset if already resolved
			if (settleTimerId) clearTimeout(settleTimerId);
			settleTimerId = setTimeout(onSettle, cfg.logSettleDurationMs);
		};

		// Attach temporary listeners
		// dataListenerDisposable = ptyShell.onData(() => { // <-- Intentionally commented out as per original
		// 	log.debug(label, "[waitForLogSettleOrTimeout.onData] Received data during settle wait.");
		// 	resetSettleTimer(); // Reset settle timer on any data
		// });
		exitListenerDisposable = ptyShell.onExit(onProcessExit); // Handle exit during wait

		// Start timers
		resetSettleTimer(); // Initial settle timer
		overallTimeoutId = setTimeout(
			onOverallTimeout,
			cfg.overallLogWaitTimeoutMs,
		);

		log.debug(
			label,
			`Waiting for logs to settle (Pause: ${cfg.logSettleDurationMs}ms, Timeout: ${cfg.overallLogWaitTimeoutMs}ms)...`,
		);
	});
}

/**
 * Handles the verification process for a newly started PTY shell.
 * Listens for a pattern match or timeout.
 *
 * @param shellInfo The shell information object.
 * @param ptyShell The node-pty shell instance.
 * @returns A promise resolving to { patternMatched: boolean, verificationFailed: boolean, failureReason: string }
 */
export async function verifyProcessStartup(shellInfo: {
	label: string;
	verificationPattern?: RegExp;
	verificationTimeoutMs?: number;
	verificationTimer?: NodeJS.Timeout;
}): Promise<{
	patternMatched: boolean;
	verificationFailed: boolean;
	failureReason: string;
}> {
	const { label, verificationPattern, verificationTimeoutMs } = shellInfo;
	let patternMatched = false;
	let verificationFailed = false;
	let failureReason = "";

	if (!verificationPattern) {
		log.debug(
			label,
			"No verification pattern provided, skipping verification.",
		);
		// Update status to running immediately if no verification needed
		const currentStatus = getShellInfo(label)?.status;
		if (currentStatus === "starting") {
			updateProcessStatus(label, "running");
			addLogEntry(label, "Status: running (no verification specified).");
		}
		return {
			patternMatched: true,
			verificationFailed: false,
			failureReason: "",
		}; // Auto-verified
	}

	const currentInfo = getShellInfo(label);
	if (!currentInfo || !currentInfo.shell) {
		log.error(label, "Cannot verify startup, shell info or PTY not found.");
		return {
			patternMatched: false,
			verificationFailed: true,
			failureReason: "Shell or PTY not found during verification",
		};
	}
	const ptyShell = currentInfo.shell;

	let verificationPromiseResolved = false;
	let dataListenerDisposable: IDisposable | undefined;
	let exitListenerDisposable: IDisposable | undefined;
	let verificationTimer: NodeJS.Timeout | undefined;

	log.info(
		label,
		`Verification required: Pattern /${verificationPattern.source}/, Timeout: ${verificationTimeoutMs === undefined ? "disabled" : `${verificationTimeoutMs}ms`}`,
	);
	addLogEntry(label, "Status: verifying. Waiting for pattern or timeout.");
	updateProcessStatus(label, "verifying");

	const verificationCompletionPromise = new Promise<void>((resolve) => {
		const resolveOnce = () => {
			if (!verificationPromiseResolved) {
				verificationPromiseResolved = true;
				// Clear timer and listeners immediately
				if (verificationTimer) clearTimeout(verificationTimer);
				dataListenerDisposable?.dispose();
				exitListenerDisposable?.dispose();
				resolve();
			}
		};

		const dataListener = (data: string): void => {
			if (verificationPromiseResolved) return;
			try {
				// Log raw data first for debugging
				handleData(label, data.replace(/\r\n?|\n$/, ""), "stdout");

				if (verificationPattern.test(data)) {
					const currentStatus = getShellInfo(label)?.status;
					if (currentStatus === "verifying") {
						log.info(label, "Verification pattern matched.");
						patternMatched = true;
						resolveOnce();
					} else {
						log.warn(
							label,
							`Verification pattern matched, but status changed to ${currentStatus}. Ignoring match.`,
						);
						// Still resolve the promise to stop listening, but don't set patternMatched
						resolveOnce();
					}
				}
			} catch (e: unknown) {
				log.error(label, "Error during verification data processing", e);
				verificationFailed = true;
				failureReason =
					e instanceof Error ? e.message : "Unknown verification error";
				resolveOnce();
			}
		};
		dataListenerDisposable = ptyShell.onData(dataListener);

		const exitListener = ({
			exitCode,
			signal,
		}: { exitCode: number; signal?: number }) => {
			if (verificationPromiseResolved) return;
			const currentStatus = getShellInfo(label)?.status;
			if (currentStatus === "verifying") {
				log.warn(
					label,
					`Shell exited (code: ${exitCode}, signal: ${signal}) during verification phase.`,
				);
				verificationFailed = true;
				failureReason = `Shell exited (code: ${exitCode}, signal: ${signal}) during verification phase.`;
				resolveOnce();
			} else {
				log.debug(
					label,
					`Shell exited (code: ${exitCode}, signal: ${signal}) but status was ${currentStatus}, not verifying. Verification listener ignoring.`,
				);
				// Resolve promise to clean up listeners, but don't mark as failed verification
				resolveOnce();
			}
		};
		exitListenerDisposable = ptyShell.onExit(exitListener);

		if (verificationTimeoutMs !== undefined && verificationTimeoutMs >= 0) {
			verificationTimer = setTimeout(() => {
				if (verificationPromiseResolved) return;
				const currentStatus = getShellInfo(label)?.status;
				if (currentStatus === "verifying") {
					log.warn(
						label,
						`Verification timed out after ${verificationTimeoutMs}ms.`,
					);
					verificationFailed = true;
					failureReason = `Verification timed out after ${verificationTimeoutMs}ms.`;
					resolveOnce();
				} else {
					log.debug(
						label,
						`Verification timer fired, but status is ${currentStatus}, not verifying. Ignoring timeout.`,
					);
					resolveOnce(); // Clean up listeners
				}
			}, verificationTimeoutMs);
			// Store timer on shellInfo? The original code did this but didn't seem to use it.
			// If needed for external clearing, pass shellInfo by ref and update it.
		}
	});

	// Wait for verification to complete (pattern match, timeout, or exit)
	await verificationCompletionPromise;

	log.debug(
		label,
		`Verification phase completed. Pattern Matched: ${patternMatched}, Failed: ${verificationFailed}`,
	);

	// Update status based on verification result *only if still verifying*
	const finalInfo = getShellInfo(label);
	if (finalInfo?.status === "verifying") {
		if (patternMatched) {
			addLogEntry(label, "Verification successful. Status: running.");
			updateProcessStatus(label, "running");
		} else {
			addLogEntry(
				label,
				`Verification failed: ${failureReason}. Status: error.`,
			);
			updateProcessStatus(label, "error");
		}
	}

	return { patternMatched, verificationFailed, failureReason };
}

// Need addLogEntry import
import { addLogEntry } from "../state.js";

// TODO: Extract verification logic from _startProcess here
// export async function verifyProcessStartup(...) { ... }
