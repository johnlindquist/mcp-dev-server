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
import { addLogEntry, managedProcesses } from "./state.js";
import type {
	CheckProcessStatusParams,
	GetAllLoglinesParams,
	ListProcessesParams,
	RestartProcessParams,
	WaitForProcessParams,
} from "./toolDefinitions.js"; // Import param types
import type { CallToolResult, LogEntry, ProcessStatus } from "./types.js";
import {
	formatLogsForResponse,
	log,
	stripAnsiAndControlChars,
} from "./utils.js";

// Define shared response types locally or import if moved to types.ts
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

// --- checkProcessStatusImpl --- (Moved from _checkProcessStatus)
export async function checkProcessStatusImpl(
	params: z.infer<typeof CheckProcessStatusParams>,
): Promise<CallToolResult> {
	const { label, log_lines } = params;
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(textPayload(`Process with label "${label}" not found.`));
	}

	const formattedLogs = formatLogsForResponse(
		processInfo.logs.map((l: LogEntry) => l.content),
		log_lines ?? DEFAULT_LOG_LINES,
	);

	const responsePayload: CheckStatusResponsePayload = {
		label: processInfo.label,
		status: processInfo.status,
		pid: processInfo.pid,
		command: processInfo.command,
		args: processInfo.args,
		cwd: processInfo.cwd,
		exitCode: processInfo.exitCode,
		signal: processInfo.signal,
		logs: formattedLogs,
		log_file_path: processInfo.logFilePath,
		tail_command: processInfo.logFilePath
			? `tail -f "${processInfo.logFilePath}"`
			: null,
	};

	const totalStoredLogs = processInfo.logs.length;
	const requestedLines = log_lines ?? DEFAULT_LOG_LINES;
	if (requestedLines > 0 && totalStoredLogs > formattedLogs.length) {
		const hiddenLines = totalStoredLogs - formattedLogs.length;
		const limitReached = totalStoredLogs >= MAX_STORED_LOG_LINES;
		responsePayload.hint = `Returned latest ${formattedLogs.length} lines. ${hiddenLines} older lines stored${limitReached ? ` (limit: ${MAX_STORED_LOG_LINES})` : ""}.`;
	} else if (requestedLines === 0 && totalStoredLogs > 0) {
		responsePayload.hint = `Logs are stored (${totalStoredLogs} lines). Specify 'log_lines > 0' to view.`;
	}

	return ok(textPayload(JSON.stringify(responsePayload, null, 2)));
}

// --- listProcessesImpl --- (Moved from _listProcesses)
export async function listProcessesImpl(
	params: z.infer<typeof ListProcessesParams>,
): Promise<CallToolResult> {
	const { log_lines } = params;
	const processList: ListProcessDetail[] = [];

	for (const label of managedProcesses.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (processInfo) {
			const formattedLogs = formatLogsForResponse(
				processInfo.logs.map((l: LogEntry) => l.content),
				log_lines ?? DEFAULT_LOG_LINES,
			);
			let logHint: string | null = null;
			const totalStoredLogs = processInfo.logs.length;
			const requestedLines = log_lines ?? 0;
			if (requestedLines > 0 && totalStoredLogs > formattedLogs.length) {
				const hiddenLines = totalStoredLogs - formattedLogs.length;
				logHint = `Showing ${formattedLogs.length} lines. ${hiddenLines} older stored.`;
			} else if (requestedLines === 0 && totalStoredLogs > 0) {
				logHint = `${totalStoredLogs} lines stored.`;
			}

			const processDetail: ListProcessDetail = {
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

// --- stopAllProcessesImpl --- (Moved from _stopAllProcesses)
export async function stopAllProcessesImpl(): Promise<CallToolResult> {
	log.info(null, "Attempting to stop all active processes...");
	const results: {
		label: string;
		result: string;
		status?: ProcessStatus | "not_found";
		pid?: number | null | undefined;
	}[] = [];
	let stoppedCount = 0;
	let skippedCount = 0;

	for (const label of managedProcesses.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (
			processInfo &&
			["starting", "running", "verifying", "restarting"].includes(
				processInfo.status,
			)
		) {
			log.info(
				label,
				`Process ${label} is active (${processInfo.status}), attempting stop.`,
			);
			const stopResult = await _stopProcess(label, false);
			const resultText = getResultText(stopResult) ?? "Unknown stop result";
			let parsedResult: {
				status?: ProcessStatus;
				error?: string;
				pid?: number | null;
			} = {};
			try {
				parsedResult = JSON.parse(resultText);
			} catch {
				/* ignore */
			}
			results.push({
				label,
				result: stopResult.isError ? "Failed" : "SignalSent",
				status: parsedResult.status ?? processInfo.status,
				pid: parsedResult.pid ?? processInfo.pid,
			});
			if (!stopResult.isError) stoppedCount++;
		} else {
			skippedCount++;
			results.push({
				label,
				result: "Skipped",
				status: processInfo?.status ?? "not_found",
				pid: processInfo?.pid,
			});
		}
	}

	const summary = `Processes processed: ${managedProcesses.size}. Signals sent: ${stoppedCount}. Skipped (already terminal/missing): ${skippedCount}.`;
	log.info(null, summary);
	return ok(
		textPayload(JSON.stringify({ summary, details: results }, null, 2)),
	);
}

// --- restartProcessImpl --- (Moved from _restartProcess)
export async function restartProcessImpl(
	params: z.infer<typeof RestartProcessParams>,
): Promise<CallToolResult> {
	const { label } = params;
	log.info(label, `Restart requested for process "${label}".`);
	addLogEntry(label, "Restart requested.");

	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found for restart.`,
					status: "not_found",
					pid: null,
				}),
			),
		);
	}

	const originalPid = processInfo.pid;

	let stopStatus: ProcessStatus | "not_needed" = "not_needed";
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
		const stopResultText = getResultText(stopResult);
		let stopResultJson: {
			status?: ProcessStatus;
			error?: string;
			pid?: number | null;
		} = {};
		try {
			if (stopResultText) stopResultJson = JSON.parse(stopResultText);
		} catch (e) {
			log.warn(label, "Could not parse stop result JSON", e);
		}

		const potentialStatus = stopResultJson.status;
		if (
			potentialStatus &&
			[
				"starting",
				"running",
				"stopping",
				"stopped",
				"crashed",
				"error",
				"verifying",
				"restarting",
			].includes(potentialStatus)
		) {
			stopStatus = potentialStatus as ProcessStatus;
		} else {
			stopStatus = "error";
			log.warn(
				label,
				`Could not determine valid stop status from JSON response. Defaulting to 'error'. Response status: ${potentialStatus}`,
			);
		}

		if (stopResult.isError) {
			const stopErrorMsg =
				stopResultJson.error ?? "Failed to stop process before restart.";
			log.error(label, `Restart aborted: ${stopErrorMsg}`);
			addLogEntry(label, `Restart aborted: Stop failed: ${stopErrorMsg}`);
			return fail(
				textPayload(
					JSON.stringify({
						error: `Restart failed: ${stopErrorMsg}`,
						status: stopStatus,
						pid: originalPid,
					}),
				),
			);
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
		const finalCheck = await checkAndUpdateProcessStatus(label);
		stopStatus = finalCheck?.status ?? stopStatus;
		log.info(label, `Stop phase completed, final status: ${stopStatus}.`);
		addLogEntry(label, `Stop phase completed, final status: ${stopStatus}.`);
	} else {
		log.info(
			label,
			`Process was already ${processInfo.status}. Skipping stop signal phase.`,
		);
		addLogEntry(
			label,
			`Process was already ${processInfo.status}. Skipping stop phase.`,
		);
		stopStatus = processInfo.status;
	}

	log.info(label, "Starting process after stop/check phase...");
	addLogEntry(label, "Starting process after stop/check phase...");

	const startResult = await _startProcess(
		label,
		processInfo.command,
		processInfo.args,
		processInfo.cwd,
		processInfo.verificationPattern,
		processInfo.verificationTimeoutMs ?? undefined,
		processInfo.retryDelayMs ?? undefined,
		processInfo.maxRetries,
		true,
	);

	const startResultText = getResultText(startResult);
	let startResultJson: {
		status?: ProcessStatus;
		error?: string;
		pid?: number | null;
	} = {};
	try {
		if (startResultText) startResultJson = JSON.parse(startResultText);
	} catch (e) {
		log.warn(label, "Could not parse start result JSON", e);
	}

	if (startResult.isError) {
		const startErrorMsg =
			startResultJson.error ?? "Failed to start process during restart.";
		log.error(label, `Restart failed: ${startErrorMsg}`);
		addLogEntry(label, `Restart failed: Start phase failed: ${startErrorMsg}`);
		return fail(
			textPayload(
				JSON.stringify({
					error: `Restart failed: ${startErrorMsg}`,
					status: startResultJson.status ?? "error",
					pid: startResultJson.pid ?? null,
				}),
			),
		);
	}

	log.info(label, "Restart sequence completed successfully.");
	addLogEntry(label, "Restart sequence completed successfully.");
	return startResult;
}

// --- waitForProcessImpl --- (Moved from _waitForProcess)
export async function waitForProcessImpl(
	params: z.infer<typeof WaitForProcessParams>,
): Promise<CallToolResult> {
	const { label, target_status, timeout_seconds, check_interval_seconds } =
		params;
	const startTime = Date.now();
	const timeoutMs = timeout_seconds * 1000;
	const intervalMs = check_interval_seconds * 1000;

	log.info(
		label,
		`Waiting up to ${timeout_seconds}s for status '${target_status}' (checking every ${check_interval_seconds}s).`,
	);
	addLogEntry(
		label,
		`Waiting for status '${target_status}'. Timeout: ${timeout_seconds}s.`,
	);

	while (Date.now() - startTime < timeoutMs) {
		const processInfo = await checkAndUpdateProcessStatus(label);

		if (!processInfo) {
			const errorMsg = `Process info for "${label}" disappeared during wait.`;
			log.error(label, errorMsg);
			addLogEntry(label, errorMsg);
			return fail(
				textPayload(
					JSON.stringify({
						error: errorMsg,
						status: "not_found",
						pid: null,
					}),
				),
			);
		}

		log.debug(label, `Wait check: Current status is ${processInfo.status}`);

		if (processInfo.status === target_status) {
			const successMsg = `Successfully reached target status '${target_status}'.`;
			log.info(label, successMsg);
			addLogEntry(label, successMsg);
			return ok(
				textPayload(
					JSON.stringify({
						message: successMsg,
						status: processInfo.status,
						pid: processInfo.pid,
						cwd: processInfo.cwd,
					}),
				),
			);
		}

		if (
			["stopped", "crashed", "error"].includes(processInfo.status) &&
			processInfo.status !== target_status
		) {
			const abortMsg = `Wait aborted: Process entered terminal state '${processInfo.status}' while waiting for '${target_status}'.`;
			log.warn(label, abortMsg);
			addLogEntry(label, abortMsg);
			return fail(
				textPayload(
					JSON.stringify({
						error: abortMsg,
						status: processInfo.status,
						pid: processInfo.pid,
					}),
				),
			);
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	const finalInfo = await checkAndUpdateProcessStatus(label);
	const timeoutMsg = `Timed out after ${timeout_seconds}s waiting for status '${target_status}'. Current status: '${finalInfo?.status ?? "unknown"}'.`;
	log.error(label, timeoutMsg);
	addLogEntry(label, timeoutMsg);
	return fail(
		textPayload(
			JSON.stringify({
				error: timeoutMsg,
				status: finalInfo?.status ?? "timeout",
				pid: finalInfo?.pid,
			}),
		),
	);
}

// --- getAllLoglinesImpl --- (Moved from _getAllLoglines)
export async function getAllLoglinesImpl(
	params: z.infer<typeof GetAllLoglinesParams>,
): Promise<CallToolResult> {
	const { label } = params;
	const processInfo = managedProcesses.get(label);

	if (!processInfo) {
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found.`,
					status: "not_found",
				}),
			),
		);
	}

	const allLogs = processInfo.logs.map((l: LogEntry) => l.content);
	const cleanedLogs = allLogs.map(stripAnsiAndControlChars);

	log.info(
		label,
		`getAllLoglines requested. Returning ${cleanedLogs.length} lines.`,
	);

	const storedLimitReached = cleanedLogs.length >= MAX_STORED_LOG_LINES;
	const message = `Returned all ${cleanedLogs.length} stored log lines for process "${label}"${storedLimitReached ? ` (storage limit is ${MAX_STORED_LOG_LINES}, older logs may have been discarded)` : ""}.`;

	return ok(
		textPayload(
			JSON.stringify(
				{
					label: label,
					total_lines_returned: cleanedLogs.length,
					storage_limit: MAX_STORED_LOG_LINES,
					logs: cleanedLogs,
					message: message,
				},
				null,
				2,
			),
		),
	);
}

// --- healthCheckImpl --- (Moved from _healthCheck)
export async function healthCheckImpl(): Promise<CallToolResult> {
	const activeProcesses = [];
	let errorCount = 0;
	let crashedCount = 0;

	for (const label of managedProcesses.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (processInfo) {
			activeProcesses.push({
				label: processInfo.label,
				status: processInfo.status,
				pid: processInfo.pid,
			});
			if (processInfo.status === "error") errorCount++;
			if (processInfo.status === "crashed") crashedCount++;
		}
	}

	const payload = {
		server_name: SERVER_NAME,
		server_version: SERVER_VERSION,
		status: "healthy",
		managed_processes_count: managedProcesses.size,
		processes_in_error_state: errorCount,
		processes_in_crashed_state: crashedCount,
		zombie_check_active: isZombieCheckActive(),
		process_details: activeProcesses,
	};

	if (errorCount > 0 || crashedCount > 0) {
		payload.status = "degraded";
	}

	log.info(
		null,
		`Health check performed. Status: ${payload.status}, Processes: ${payload.managed_processes_count}`,
	);
	return ok(textPayload(JSON.stringify(payload, null, 2)));
}
