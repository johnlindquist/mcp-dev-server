import type { z } from "zod";
import {
	DEFAULT_LOG_LINES,
	MAX_STORED_LOG_LINES,
	SERVER_NAME,
	SERVER_VERSION,
} from "./constants.js";
import { fail, getResultText, ok, textPayload } from "./mcpUtils.js";
import { _startProcess, _stopProcess } from "./processLogic.js";
import {
	checkAndUpdateProcessStatus,
	isZombieCheckActive,
} from "./processSupervisor.js";
import { writeToPty } from "./ptyManager.js";
import { addLogEntry, managedProcesses } from "./state.js";
import type {
	CheckProcessStatusParams,
	GetAllLoglinesParams,
	ListProcessesParams,
	RestartProcessParams,
	WaitForProcessParams,
} from "./toolDefinitions.js";
import type { StopProcessParams } from "./toolDefinitions.js";
import type {
	CallToolResult,
	CheckStatusPayloadSchema,
	GetAllLoglinesPayloadSchema,
	HealthCheckPayloadSchema,
	ListProcessDetailSchema,
	ListProcessesPayloadSchema,
	LogEntry,
	ProcessStatus,
	RestartErrorPayloadSchema,
	StopAllProcessesPayloadSchema,
	StopProcessPayloadSchema,
	WaitForProcessPayloadSchema,
} from "./types.js";
import {
	formatLogsForResponse,
	log,
	stripAnsiAndControlChars,
} from "./utils.js";

// --- FAST MODE --- Set MCP_PM_FAST=1 to use reduced timings
// -----------------

// Restore interfaces that were unintentionally removed
interface CheckStatusResponsePayload {
	label: string;
	status: ProcessStatus;
	pid: number | undefined;
	command: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	signal: string | null;
	logs: string[];
	log_file_path: string | null | undefined;
	tail_command: string | null | undefined;
	hint?: string;
}

interface ListProcessDetail {
	label: string;
	status: ProcessStatus;
	pid: number | undefined;
	command: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	signal: string | null;
	logs: string[];
	log_hint: string | null;
	log_file_path: string | null | undefined;
	tail_command: string | null | undefined;
}

export async function checkProcessStatusImpl(
	params: z.infer<typeof CheckProcessStatusParams>,
): Promise<CallToolResult> {
	const { label, log_lines } = params;
	log.debug(label, "Tool invoked: check_process_status", { params });

	// --- Check initial status and potentially wait ---
	const initialProcessInfo = await checkAndUpdateProcessStatus(label);

	if (!initialProcessInfo) {
		log.warn(label, `Process with label "${label}" not found.`);
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found.`,
				}),
			),
		);
	}

	const initialStatus = initialProcessInfo.status;
	const previousLastLogTimestampReturned =
		initialProcessInfo.lastLogTimestampReturned ?? 0;

	const finalProcessInfo = initialProcessInfo; // Initialize with initial info

	// --- Filter Logs (using finalProcessInfo) ---
	// Use the potentially updated process info (now just initialProcessInfo)
	const allLogs: LogEntry[] = finalProcessInfo.logs || [];
	log.debug(
		label,
		`Filtering logs. Total logs available: ${allLogs.length}. Filtering for timestamp > ${previousLastLogTimestampReturned}`,
	);

	const newLogs = allLogs.filter(
		(logEntry) => logEntry.timestamp > previousLastLogTimestampReturned,
	);

	let logHint = "";
	const returnedLogs: string[] = [];
	let newLastLogTimestamp = previousLastLogTimestampReturned; // Default to old value

	// Decide which logs to return based on log_lines parameter
	if (newLogs.length > 0) {
		log.debug(label, `Found ${newLogs.length} new log entries.`);
		// Update the timestamp in the processInfo state
		newLastLogTimestamp = newLogs[newLogs.length - 1].timestamp;
		log.debug(
			label,
			`Updating lastLogTimestampReturned in process state to ${newLastLogTimestamp}`,
		);
		// Ensure we update the actual state object (finalProcessInfo holds the reference)
		finalProcessInfo.lastLogTimestampReturned = newLastLogTimestamp;

		const numLogsToReturn = Math.max(0, log_lines ?? DEFAULT_LOG_LINES); // Ensure non-negative
		const startIndex = Math.max(0, newLogs.length - numLogsToReturn);
		returnedLogs.push(...newLogs.slice(startIndex).map((l) => l.content));

		log.debug(
			label,
			`Requested log lines: ${numLogsToReturn} (Default: ${DEFAULT_LOG_LINES})`,
		);
		log.debug(
			label,
			`Returning ${returnedLogs.length} raw log lines (limited by request).`,
		);

		if (returnedLogs.length < newLogs.length) {
			const omittedCount = newLogs.length - returnedLogs.length;
			logHint = `Returned ${returnedLogs.length} newest log lines since last check (${previousLastLogTimestampReturned}). ${omittedCount} more new lines were generated but not shown due to limit (${numLogsToReturn}).`;
		} else {
			logHint = `Returned all ${returnedLogs.length} new log lines since last check (${previousLastLogTimestampReturned}).`;
		}
	} else {
		log.debug(
			label,
			`No new logs found using filter timestamp ${previousLastLogTimestampReturned}`,
		);
		logHint = `No new log lines since last check (${previousLastLogTimestampReturned}).`; // Use variable here too
	}

	// Construct payload using data AFTER the wait
	const payload: z.infer<typeof CheckStatusPayloadSchema> = {
		label: finalProcessInfo.label,
		status: finalProcessInfo.status, // Status from AFTER the wait
		pid: finalProcessInfo.pid,
		command: finalProcessInfo.command,
		args: finalProcessInfo.args,
		cwd: finalProcessInfo.cwd,
		exitCode: finalProcessInfo.exitCode,
		signal: finalProcessInfo.signal,
		logs: returnedLogs,
		log_file_path: finalProcessInfo.logFilePath,
		tail_command: finalProcessInfo.logFilePath
			? `tail -f "${finalProcessInfo.logFilePath}"`
			: undefined,
		hint: logHint,
	};

	log.info(
		label,
		`check_process_status returning final status: ${payload.status}. New logs returned: ${returnedLogs.length}. New lastLogTimestamp: ${newLastLogTimestamp}`,
	);

	return ok(textPayload(JSON.stringify(payload))); // Use the pre-stringified version
}

export async function listProcessesImpl(
	params: z.infer<typeof ListProcessesParams>,
): Promise<CallToolResult> {
	const { log_lines } = params;
	const processList: z.infer<typeof ListProcessesPayloadSchema> = [];

	for (const label of managedProcesses.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (processInfo) {
			const requestedLines = log_lines ?? 0;
			const formattedLogs = formatLogsForResponse(
				processInfo.logs.map((l: LogEntry) => l.content),
				requestedLines,
			);
			let logHint: string | null = null;
			const totalStoredLogs = processInfo.logs.length;

			if (requestedLines > 0 && totalStoredLogs > formattedLogs.length) {
				const hiddenLines = totalStoredLogs - formattedLogs.length;
				logHint = `Showing ${formattedLogs.length} lines. ${hiddenLines} older stored.`;
			} else if (requestedLines === 0 && totalStoredLogs > 0) {
				logHint = `${totalStoredLogs} lines stored.`;
			}

			const processDetail: z.infer<typeof ListProcessDetailSchema> = {
				label: processInfo.label,
				status: processInfo.status,
				pid: processInfo.pid,
				command: processInfo.command,
				args: processInfo.args,
				cwd: processInfo.cwd,
				exitCode: processInfo.exitCode,
				signal: processInfo.signal,
				logs: formattedLogs,
				log_hint: logHint,
				log_file_path: processInfo.logFilePath,
				tail_command: processInfo.logFilePath
					? `tail -f "${processInfo.logFilePath}"`
					: null,
			};
			processList.push(processDetail);
		}
	}

	return ok(textPayload(JSON.stringify(processList, null, 2)));
}

export async function stopProcessImpl(
	params: StopProcessParams,
): Promise<CallToolResult> {
	const { label, force } = params;
	const result = await _stopProcess(label, force);
	return result;
}

export async function stopAllProcessesImpl(): Promise<CallToolResult> {
	log.info(null, "Attempting to stop all active processes...");
	const details: z.infer<typeof StopAllProcessesPayloadSchema>["details"] = [];
	let stoppedCount = 0;
	let skippedCount = 0;
	let errorCount = 0;

	const labels = Array.from(managedProcesses.keys());

	for (const label of labels) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (
			processInfo &&
			["starting", "running", "verifying", "restarting", "stopping"].includes(
				processInfo.status,
			)
		) {
			log.info(
				label,
				`Process ${label} is active (${processInfo.status}), attempting stop.`,
			);
			const stopResult = await _stopProcess(label, false);

			let detailResult: z.infer<
				typeof StopAllProcessesPayloadSchema
			>["details"][number]["result"] = "Failed";
			let detailStatus: z.infer<
				typeof StopAllProcessesPayloadSchema
			>["details"][number]["status"] = processInfo.status;
			let detailPid: z.infer<
				typeof StopAllProcessesPayloadSchema
			>["details"][number]["pid"] = processInfo.pid;

			if (!stopResult.isError) {
				try {
					const parsedPayload: z.infer<typeof StopProcessPayloadSchema> =
						JSON.parse(stopResult.payload.content);
					detailResult = "SignalSent";
					detailStatus = parsedPayload.status;
					detailPid = parsedPayload.pid;
					stoppedCount++;
				} catch (e) {
					log.error(
						label,
						`Failed to parse stop result for ${label}: ${getResultText(stopResult)}`,
						e,
					);
					detailResult = "Failed";
					errorCount++;
				}
			} else {
				try {
					const parsedPayload: z.infer<typeof StopProcessPayloadSchema> =
						JSON.parse(stopResult.payload.content);
					detailStatus = parsedPayload.status;
					detailPid = parsedPayload.pid;
				} catch (e) {
					/* Ignore parsing error for error payload */
				}
				errorCount++;
				detailResult = "Failed";
			}

			details.push({
				label,
				result: detailResult,
				status: detailStatus,
				pid: detailPid,
			});
		} else {
			skippedCount++;
			details.push({
				label,
				result: "Skipped",
				status: processInfo?.status ?? "not_found",
				pid: processInfo?.pid,
			});
		}
	}

	const summary = `Processes processed: ${labels.length}. Signals sent: ${stoppedCount}. Skipped: ${skippedCount}. Failed: ${errorCount}.`;
	log.info(null, summary);
	const responsePayload: z.infer<typeof StopAllProcessesPayloadSchema> = {
		summary,
		details,
	};
	return ok(textPayload(JSON.stringify(responsePayload, null, 2)));
}

export async function restartProcessImpl(
	params: z.infer<typeof RestartProcessParams>,
): Promise<CallToolResult> {
	const { label } = params;
	log.info(label, `Restart requested for process "${label}".`);
	addLogEntry(label, "Restart requested.");

	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		const errorPayload: z.infer<typeof RestartErrorPayloadSchema> = {
			error: `Process with label "${label}" not found for restart.`,
			status: "error",
			pid: undefined,
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}

	const {
		command,
		args,
		cwd,
		verificationPattern,
		verificationTimeoutMs,
		retryDelayMs,
		maxRetries,
		host,
	} = processInfo;

	let stopSucceeded = false;
	if (
		["starting", "running", "verifying", "restarting", "stopping"].includes(
			processInfo.status,
		)
	) {
		log.info(
			label,
			`Stopping process (status: ${processInfo.status}) before restart...`,
		);
		addLogEntry(label, "Stopping process before restart...");
		const stopResult = await _stopProcess(label, false);
		log.info(
			label,
			`[Restart] Stop process result: ${JSON.stringify(stopResult)}`,
		);
		if (stopResult.isError) {
			const errorMsg = `Failed to stop process "${label}" before restart. Error: ${getResultText(stopResult)}`;
			log.error(label, errorMsg);
			addLogEntry(label, `Error stopping before restart: ${errorMsg}`);
			const errorPayload: z.infer<typeof RestartErrorPayloadSchema> = {
				error: errorMsg,
				status: managedProcesses.get(label)?.status ?? "error",
				pid: processInfo.pid,
			};
			return fail(textPayload(JSON.stringify(errorPayload)));
		}
		log.info(label, "Process stopped successfully before restart.");
		addLogEntry(label, "Process stopped before restart.");
		stopSucceeded = true;

		// Add a small delay after confirming stop before starting again
		log.info(label, "[Restart] Waiting 500ms after stop before starting...");
		await new Promise((resolve) => setTimeout(resolve, 500));
	} else {
		log.info(
			label,
			`Process already in terminal state (${processInfo.status}). Proceeding directly to start.`,
		);
		addLogEntry(
			label,
			`Process already stopped (${processInfo.status}). Starting...`,
		);
	}

	log.info(label, "Starting process after stop/check...");
	const startResult = await _startProcess(
		label,
		command,
		args,
		cwd,
		host,
		verificationPattern,
		verificationTimeoutMs,
		retryDelayMs,
		maxRetries,
		true,
	);

	log.info(
		label,
		`[Restart] Start attempt completed. Result: ${JSON.stringify(startResult)}`,
	);

	if (startResult.isError) {
		try {
			const parsedError: z.infer<typeof RestartErrorPayloadSchema> = JSON.parse(
				startResult.payload.content,
			);
			return fail(
				textPayload(
					JSON.stringify({
						...parsedError,
						error: `Restart failed: ${parsedError.error}`,
					}),
				),
			);
		} catch (e) {
			return fail(
				textPayload(
					JSON.stringify({
						error: `Restart failed during start phase. Raw error: ${getResultText(startResult)}`,
					}),
				),
			);
		}
	} else {
		return startResult;
	}
}

export async function waitForProcessImpl(
	params: z.infer<typeof WaitForProcessParams>,
): Promise<CallToolResult> {
	const { label, target_status, timeout_seconds, check_interval_seconds } =
		params;
	const startTime = Date.now();
	const timeoutMs = timeout_seconds * 1000;
	const checkIntervalMs = check_interval_seconds * 1000;

	log.info(
		label,
		`Waiting for process "${label}" to reach status "${target_status}" (Timeout: ${timeout_seconds}s)`,
	);

	return new Promise((resolve) => {
		const intervalId = setInterval(async () => {
			const processInfo = await checkAndUpdateProcessStatus(label);
			const currentStatus = processInfo?.status;
			const elapsedTime = Date.now() - startTime;

			if (!processInfo) {
				clearInterval(intervalId);
				const message = `Process "${label}" disappeared while waiting for status "${target_status}".`;
				log.warn(label, message);
				const payload: z.infer<typeof WaitForProcessPayloadSchema> = {
					label,
					final_status: "error",
					message,
					timed_out: false,
				};
				resolve(fail(textPayload(JSON.stringify(payload))));
				return;
			}

			if (currentStatus === target_status) {
				clearInterval(intervalId);
				const message = `Process "${label}" reached target status "${target_status}" after ${elapsedTime / 1000}s.`;
				log.info(label, message);
				const payload: z.infer<typeof WaitForProcessPayloadSchema> = {
					label,
					final_status: currentStatus,
					message,
					timed_out: false,
				};
				resolve(ok(textPayload(JSON.stringify(payload))));
				return;
			}

			if (elapsedTime >= timeoutMs) {
				clearInterval(intervalId);
				const message = `Timed out after ${timeout_seconds}s waiting for process "${label}" to reach status "${target_status}". Current status: "${currentStatus}".`;
				log.warn(label, message);
				const payload: z.infer<typeof WaitForProcessPayloadSchema> = {
					label,
					final_status: currentStatus ?? "error",
					message,
					timed_out: true,
				};
				resolve(fail(textPayload(JSON.stringify(payload))));
				return;
			}
		}, checkIntervalMs);
	});
}

export async function getAllLoglinesImpl(
	params: z.infer<typeof GetAllLoglinesParams>,
): Promise<CallToolResult> {
	const { label } = params;
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(textPayload(`Process with label "${label}" not found.`));
	}

	const allLogs = processInfo.logs.map((l) =>
		stripAnsiAndControlChars(l.content),
	);

	const payload: z.infer<typeof GetAllLoglinesPayloadSchema> = {
		label,
		logs: allLogs,
		count: allLogs.length,
		storage_limit: MAX_STORED_LOG_LINES,
	};

	return ok(textPayload(JSON.stringify(payload, null, 2)));
}

export async function sendInputImpl(
	label: string,
	input: string,
	appendNewline = true,
): Promise<CallToolResult> {
	log.info(label, `Send input requested for process "${label}"`);
	addLogEntry(label, `Input received: ${input}`);

	const processInfo = managedProcesses.get(label);

	if (!processInfo) {
		log.warn(label, `Process "${label}" not found.`);
		return fail(
			textPayload(JSON.stringify({ error: `Process \"${label}\" not found.` })),
		);
	}

	if (!processInfo.process || typeof processInfo.pid !== "number") {
		log.warn(label, `Process "${label}" has no active PTY handle.`);
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process \"${label}\" has no active PTY handle.`,
				}),
			),
		);
	}

	if (processInfo.status !== "running" && processInfo.status !== "verifying") {
		log.warn(
			label,
			`Cannot send input to process "${label}" in state: ${processInfo.status}`,
		);
		return fail(
			textPayload(
				JSON.stringify({
					error: `Cannot send input to process \"${label}\" in state: ${processInfo.status}`,
				}),
			),
		);
	}

	const dataToSend = appendNewline ? `${input}\r` : input;
	const success = writeToPty(processInfo.process, dataToSend, label);

	if (success) {
		log.info(label, `Successfully sent input to process ${processInfo.pid}`);
		return ok(
			textPayload(
				JSON.stringify({ message: `Input sent to process "${label}".` }),
			),
		);
	}

	log.error(label, `Failed to send input to process ${processInfo.pid}`);
	return fail(
		textPayload(
			JSON.stringify({
				error: `Failed to send input to process "${label}".`,
			}),
		),
	);
}

export async function healthCheckImpl(): Promise<CallToolResult> {
	const activeProcesses = managedProcesses.size;
	const zombieCheckTimerActive = isZombieCheckActive();

	const payload: z.infer<typeof HealthCheckPayloadSchema> = {
		status: "ok",
		server_name: SERVER_NAME,
		version: SERVER_VERSION,
		active_processes: activeProcesses,
		zombie_check_active: zombieCheckTimerActive,
	};

	return ok(textPayload(JSON.stringify(payload)));
}
