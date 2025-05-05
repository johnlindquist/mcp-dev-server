import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { cfg } from "./constants/index.js";
import { fail, getResultText, ok, textPayload } from "./mcpUtils.js";
import {
	startShell,
	startShellWithVerification,
	stopProcess,
} from "./process/lifecycle.js";
import {
	checkAndUpdateProcessStatus,
	isZombieCheckActive,
} from "./processSupervisor.js";
import { writeToPty } from "./ptyManager.js";
import { addLogEntry, managedShells } from "./state.js";
import type { LogEntry } from "./types/process.js";
import type {
	CheckProcessStatusParamsType as CheckProcessStatusParams,
	GetAllLoglinesParamsType as GetAllLoglinesParams,
	ListProcessesParamsType as ListProcessesParams,
	RestartProcessParamsType as RestartProcessParams,
	StopProcessParamsType as StopProcessParams,
	WaitForProcessParamsType as WaitForProcessParams,
} from "./types/schemas.js";
import type * as schemas from "./types/schemas.js";

import { NO_NOTABLE_EVENTS_MSG } from "./constants/messages.js";
import { analyseLogs } from "./logAnalysis.js";
import {
	formatLogsForResponse,
	log,
	stripAnsiAndControlChars,
} from "./utils.js";

function logsToArray(
	logs: LogEntry[] | { toArray: () => LogEntry[] },
): LogEntry[] {
	return typeof (logs as { toArray?: unknown }).toArray === "function"
		? (logs as { toArray: () => LogEntry[] }).toArray()
		: (logs as LogEntry[]);
}

export async function checkProcessStatusImpl(
	params: CheckProcessStatusParams,
): Promise<CallToolResult> {
	const { label, log_lines } = params;
	log.debug(label, "Tool invoked: check_shell", { params });

	const initialProcessInfo = await checkAndUpdateProcessStatus(label);

	if (!initialProcessInfo) {
		log.warn(
			label,
			`Process with label "${label}" not found. Returning stopped status for purged process.`,
		);
		const payload = {
			label,
			status: "stopped",
			pid: undefined,
			command: undefined,
			args: [],
			cwd: undefined,
			exitCode: undefined,
			signal: undefined,
			logs: [],
			log_file_path: undefined,
			tail_command: undefined,
			hint: undefined,
			message: NO_NOTABLE_EVENTS_MSG,
		};
		return ok(textPayload(JSON.stringify(payload)));
	}

	const initialStatus = initialProcessInfo.status;
	const previousLastLogTimestampReturned =
		initialProcessInfo.lastLogTimestampReturned ?? 0;

	const finalProcessInfo = initialProcessInfo;

	const allLogs: LogEntry[] = logsToArray(finalProcessInfo.logs || []);
	log.info(null, "[DEBUG][checkProcessStatusImpl] allLogs:", allLogs);
	log.info(
		null,
		"[DEBUG][checkProcessStatusImpl] previousLastLogTimestampReturned:",
		previousLastLogTimestampReturned,
	);
	log.info(
		null,
		"[DEBUG][checkProcessStatusImpl] allLogs timestamps:",
		allLogs.map((l) => l.timestamp),
	);
	log.debug(
		label,
		`Filtering logs. Total logs available: ${allLogs.length}. Filtering for timestamp > ${previousLastLogTimestampReturned}`,
	);

	const newLogsForPayload = allLogs.filter(
		(logEntry) => logEntry.timestamp > previousLastLogTimestampReturned,
	);

	const newLogsForSummary = allLogs.filter(
		(logEntry) => logEntry.timestamp > previousLastLogTimestampReturned,
	);

	let logHint = "";
	const returnedLogs: string[] = [];
	let newLastLogTimestamp = previousLastLogTimestampReturned;

	if (newLogsForPayload.length > 0) {
		log.debug(
			label,
			`Found ${newLogsForPayload.length} new log entries for payload.`,
		);
		newLastLogTimestamp =
			newLogsForPayload[newLogsForPayload.length - 1].timestamp;
		log.debug(
			label,
			`Updating lastLogTimestampReturned in process state to ${newLastLogTimestamp}`,
		);
		finalProcessInfo.lastLogTimestampReturned = newLastLogTimestamp;

		const numLogsToReturn = Math.max(
			0,
			log_lines ?? cfg.defaultCheckStatusLogLines,
		);
		const startIndex = Math.max(0, newLogsForPayload.length - numLogsToReturn);
		returnedLogs.push(
			...newLogsForPayload.slice(startIndex).map((l) => l.content),
		);

		log.debug(
			label,
			`Requested log lines: ${numLogsToReturn} (Default: ${cfg.defaultCheckStatusLogLines})`,
		);
		log.debug(
			label,
			`Returning ${returnedLogs.length} raw log lines (limited by request).`,
		);

		if (returnedLogs.length < newLogsForPayload.length) {
			const omittedCount = newLogsForPayload.length - returnedLogs.length;
			logHint = `Returned ${returnedLogs.length} newest log lines since last check (${previousLastLogTimestampReturned}). ${omittedCount} more new lines were generated but not shown due to limit (${numLogsToReturn}).`;
		} else {
			logHint = `Returned all ${returnedLogs.length} new log lines since last check (${previousLastLogTimestampReturned}).`;
		}
	} else {
		log.debug(
			label,
			`No new logs found using filter timestamp ${previousLastLogTimestampReturned}`,
		);
		logHint = `No new log lines since last check (${previousLastLogTimestampReturned}).`;
	}

	log.debug(
		label,
		`Analysing ${newLogsForSummary.length} logs for summary since timestamp ${previousLastLogTimestampReturned}`,
	);
	log.info(
		"[DEBUG][checkProcessStatusImpl] Logs for summary:",
		newLogsForSummary.map((l) => l.content).join(", "),
	);
	const { message: summaryMessage } = analyseLogs(
		newLogsForSummary.map((l) => l.content),
	);
	if (newLogsForSummary.length > 0) {
		newLastLogTimestamp =
			newLogsForSummary[newLogsForSummary.length - 1].timestamp;
		log.debug(
			label,
			`Updating lastLogTimestampReturned to ${newLastLogTimestamp}`,
		);
		finalProcessInfo.lastLogTimestampReturned = newLastLogTimestamp;
	}

	const payload: z.infer<typeof schemas.CheckStatusPayloadSchema> = {
		label: finalProcessInfo.label,
		status: finalProcessInfo.status,
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
		message: summaryMessage,
		isProbablyAwaitingInput: finalProcessInfo.isProbablyAwaitingInput ?? false,
	};

	log.info(
		label,
		`check_shell returning final status: ${payload.status}. New logs returned: ${returnedLogs.length}. New lastLogTimestamp: ${newLastLogTimestamp}`,
	);

	return ok(textPayload(JSON.stringify(payload)));
}

export async function listProcessesImpl(
	params: ListProcessesParams,
): Promise<CallToolResult> {
	const { log_lines } = params;
	const processList: z.infer<typeof schemas.ListProcessesPayloadSchema> = [];

	for (const label of managedShells.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (processInfo) {
			const requestedLines = log_lines ?? 0;
			const formattedLogs = formatLogsForResponse(
				logsToArray(processInfo.logs).map((l: LogEntry) => l.content),
				requestedLines,
			);
			let logHint: string | null = null;
			const totalStoredLogs = logsToArray(processInfo.logs).length;

			if (requestedLines > 0 && totalStoredLogs > formattedLogs.length) {
				const hiddenLines = totalStoredLogs - formattedLogs.length;
				logHint = `Showing ${formattedLogs.length} lines. ${hiddenLines} older stored.`;
			} else if (requestedLines === 0 && totalStoredLogs > 0) {
				logHint = `${totalStoredLogs} lines stored.`;
			}

			const processDetail: z.infer<typeof schemas.ListProcessDetailSchema> = {
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
				isProbablyAwaitingInput: processInfo.isProbablyAwaitingInput ?? false,
			};
			processList.push(processDetail);
		}
	}

	return ok(textPayload(JSON.stringify(processList)));
}

export async function stopProcessImpl(
	params: StopProcessParams,
): Promise<CallToolResult> {
	const { label, force } = params;
	const result = await stopProcess(label, force);
	if (typeof result === "object" && result !== null && !Array.isArray(result)) {
		return ok(textPayload(JSON.stringify(result)));
	}
	return result;
}

export async function stopAllProcessesImpl(): Promise<CallToolResult> {
	log.info(null, "Attempting to stop all active processes...");
	const details: z.infer<
		typeof schemas.StopAllProcessesPayloadSchema
	>["details"] = [];
	let stoppedCount = 0;
	let skippedCount = 0;
	let errorCount = 0;

	const labels = Array.from(managedShells.keys());

	for (const label of labels) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		const currentStatus = processInfo?.status ?? "not_found";
		const pid = processInfo?.pid;

		if (currentStatus === "running" || currentStatus === "verifying") {
			log.debug(label, "Stopping process as part of stop_all...");
			try {
				const stopResult = await stopProcess(label, false);
				const resultText = getResultText(stopResult);
				let resultJson: { status?: string; message?: string } = {};
				try {
					if (resultText !== null) {
						resultJson = JSON.parse(resultText);
					}
				} catch (e) {
					/* ignore */
				}
				details.push({
					label,
					status: resultJson.status ?? "unknown",
					message: resultJson.message ?? "Stop signal sent.",
					is_error: !!stopResult.isError,
				});
				if (stopResult.isError) {
					errorCount++;
				} else {
					stoppedCount++;
				}
			} catch (error) {
				log.error(
					label,
					"Error stopping process during stop_all",
					error instanceof Error ? error.message : "Unknown error",
				);
				details.push({
					label,
					status: currentStatus,
					message: `Failed to stop: ${error instanceof Error ? error.message : "Unknown error"}`,
					is_error: true,
				});
				errorCount++;
			}
		} else {
			log.debug(
				label,
				`Skipping stop_all for process in state: ${currentStatus}`,
			);
			details.push({
				label,
				status: currentStatus,
				message: `Skipped (status was ${currentStatus}).`,
				is_error: false,
			});
			skippedCount++;
		}
	}

	const payload: z.infer<typeof schemas.StopAllProcessesPayloadSchema> = {
		stopped_count: stoppedCount,
		skipped_count: skippedCount,
		error_count: errorCount,
		details: details,
	};

	log.info(
		null,
		`Stop all request completed. Stopped: ${stoppedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`,
	);
	return ok(textPayload(JSON.stringify(payload)));
}

export async function restartProcessImpl(
	params: RestartProcessParams,
): Promise<CallToolResult> {
	const { label } = params;
	log.info(label, "Tool invoked: restart_shell");

	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		log.warn(label, `Process with label "${label}" not found for restart.`);
		const errorPayload: z.infer<typeof schemas.RestartErrorPayloadSchema> = {
			error: `Process with label "${label}" not found.`,
			label,
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}

	log.debug(label, "Stopping process before restart...");
	const stopResult = await stopProcess(label, false);
	if (stopResult.isError) {
		log.error(
			label,
			"Failed to stop process cleanly during restart. Aborting restart.",
			{ payload: stopResult.payload },
		);
		const errorPayload: z.infer<typeof schemas.RestartErrorPayloadSchema> = {
			error: `Failed to stop existing process: ${getResultText(stopResult)}`,
			label,
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}
	log.debug(label, "Process stopped successfully.");

	await new Promise((resolve) => setTimeout(resolve, 250));

	log.debug(label, "Starting process again...");
	const verificationPattern = processInfo.verificationPattern;
	let startResult: CallToolResult;
	if (
		verificationPattern ||
		processInfo.verificationTimeoutMs ||
		processInfo.retryDelayMs ||
		processInfo.maxRetries
	) {
		startResult = await startShellWithVerification(
			label,
			processInfo.command,
			processInfo.args,
			processInfo.cwd,
			processInfo.host,
			verificationPattern,
			processInfo.verificationTimeoutMs,
			processInfo.retryDelayMs,
			processInfo.maxRetries,
			true,
		);
	} else {
		startResult = await startShell(
			label,
			processInfo.command,
			processInfo.args,
			processInfo.cwd,
			processInfo.host,
			true,
		);
	}

	if (startResult.isError) {
		log.error(label, "Failed to start process during restart.", {
			payload: startResult.payload,
		});
		const errorPayload: z.infer<typeof schemas.RestartErrorPayloadSchema> = {
			error: `Failed to start process after stopping: ${getResultText(startResult)}`,
			label,
		};
		return fail(textPayload(JSON.stringify(errorPayload)));
	}

	log.info(label, "Process restarted successfully.");
	if (
		typeof startResult === "object" &&
		startResult !== null &&
		!Array.isArray(startResult) &&
		"payload" in startResult &&
		Array.isArray(startResult.payload) &&
		startResult.payload[0]?.content
	) {
		try {
			const parsed = JSON.parse(startResult.payload[0].content);
			return ok(textPayload(JSON.stringify(parsed)));
		} catch {
			return ok(textPayload(startResult.payload[0].content));
		}
	}
	return startResult;
}

export async function waitForProcessImpl(
	params: WaitForProcessParams,
): Promise<CallToolResult> {
	const { label, target_status, timeout_seconds, check_interval_seconds } =
		params;
	const timeoutMs = timeout_seconds * 1000;
	const checkIntervalMs = check_interval_seconds * 1000;
	const startTime = Date.now();

	log.info(
		label,
		`Waiting for process to reach status '${target_status}' (timeout: ${timeout_seconds}s, interval: ${check_interval_seconds}s)`,
	);

	while (true) {
		const processInfo = await checkAndUpdateProcessStatus(label);

		if (!processInfo) {
			const message = `Process with label "${label}" not found during wait.`;
			log.warn(label, message);
			const payload: z.infer<typeof schemas.WaitForProcessPayloadSchema> = {
				label,
				final_status: "error",
				message,
			};
			return fail(textPayload(JSON.stringify(payload)));
		}

		const currentStatus = processInfo.status;
		log.debug(label, `Current status during wait: ${currentStatus}`);

		if (currentStatus === target_status) {
			const duration = (Date.now() - startTime) / 1000;
			const message = `Process reached target status '${target_status}' after ${duration.toFixed(1)} seconds.`;
			log.info(label, message);
			const payload: z.infer<typeof schemas.WaitForProcessPayloadSchema> = {
				label,
				final_status: currentStatus,
				message,
				timed_out: false,
			};
			return ok(textPayload(JSON.stringify(payload)));
		}

		if (
			currentStatus === "stopped" ||
			currentStatus === "crashed" ||
			currentStatus === "error"
		) {
			if (currentStatus !== target_status) {
				const duration = (Date.now() - startTime) / 1000;
				const message = `Process reached terminal status '${currentStatus}' after ${duration.toFixed(1)}s, but target was '${target_status}'.`;
				log.warn(label, message);
				const payload: z.infer<typeof schemas.WaitForProcessPayloadSchema> = {
					label,
					final_status: currentStatus,
					message,
				};
				return ok(textPayload(JSON.stringify(payload)));
			}
		}

		if (Date.now() - startTime > timeoutMs) {
			const message = `Timed out after ${timeout_seconds} seconds waiting for process to reach status '${target_status}'. Final status was '${currentStatus}'.`;
			log.warn(label, message);
			const payload: z.infer<typeof schemas.WaitForProcessPayloadSchema> = {
				label,
				final_status: currentStatus,
				message,
				timed_out: true,
			};
			return ok(textPayload(JSON.stringify(payload)));
		}

		await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
	}
}

export async function getAllLoglinesImpl(
	params: GetAllLoglinesParams,
): Promise<CallToolResult> {
	const { label } = params;
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		log.warn(
			label,
			`Process with label "${label}" not found for getAllLoglines.`,
		);
		return fail(
			textPayload(JSON.stringify({ error: `Process "${label}" not found.` })),
		);
	}

	const allLogs = logsToArray(processInfo.logs || []);
	const logContents = allLogs.map((l) => l.content);
	const lineCount = logContents.length;
	const isTruncated = lineCount >= cfg.maxStoredLogLines;

	const message = isTruncated
		? `Returned all ${lineCount} stored log lines (storage limit reached).`
		: `Returned all ${lineCount} stored log lines.`;

	const payload: z.infer<typeof schemas.GetAllLoglinesPayloadSchema> = {
		label,
		logs: logContents,
		message,
		line_count: lineCount,
		is_truncated: isTruncated,
	};

	log.info(
		label,
		`getAllLoglines returning ${lineCount} lines. Truncated: ${isTruncated}`,
	);
	return ok(textPayload(JSON.stringify(payload)));
}

export async function sendInputImpl(
	label: string,
	input: string,
	appendNewline = true,
): Promise<CallToolResult> {
	log.info(label, "Tool invoked: send_input");
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo || !processInfo.shell) {
		const status = processInfo?.status ?? "not_found";
		const message = `Process "${label}" not running or not found (status: ${status}). Cannot send input.`;
		log.warn(label, message);
		return fail(textPayload(JSON.stringify({ error: message })));
	}

	if (processInfo.status !== "running" && processInfo.status !== "verifying") {
		const message = `Process "${label}" is not in a running or verifying state (status: ${processInfo.status}). Cannot reliably send input.`;
		log.warn(label, message);
		return fail(textPayload(JSON.stringify({ error: message })));
	}

	try {
		const inputToSend = appendNewline ? `${input}\r` : input;
		log.debug(
			label,
			`Sending input to PTY: "${stripAnsiAndControlChars(inputToSend)}"`,
		);
		await writeToPty(processInfo.shell, inputToSend, label);
		addLogEntry(label, `[MCP_INPUT] ${input}`);

		const message = `Input sent successfully to process "${label}".`;
		log.info(label, message);
		return ok(textPayload(JSON.stringify({ message })));
	} catch (error) {
		const message = `Failed to send input to process "${label}".`;
		log.error(label, message, (error as Error).message);
		const errorMsg =
			error instanceof Error ? error.message : "Unknown PTY write error";
		return fail(
			textPayload(JSON.stringify({ error: `${message}: ${errorMsg}` })),
		);
	}
}

export async function healthCheckImpl(): Promise<CallToolResult> {
	const payload: z.infer<typeof schemas.HealthCheckPayloadSchema> = {
		status: "ok",
		server_name: cfg.serverName,
		server_version: cfg.serverVersion,
		active_shells: managedShells.size,
		is_zombie_check_active: isZombieCheckActive(),
	};
	return ok(textPayload(JSON.stringify(payload)));
}
