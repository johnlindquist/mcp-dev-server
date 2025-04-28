import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	DEFAULT_LOG_LINES,
	DEFAULT_RETRY_DELAY_MS,
	DEFAULT_VERIFICATION_TIMEOUT_MS,
	MAX_RETRIES,
	MAX_STORED_LOG_LINES,
	SERVER_NAME,
	SERVER_VERSION,
} from "./constants.js";
import { _startProcess, _stopProcess } from "./processLogic.js";
import {
	addLogEntry,
	checkAndUpdateProcessStatus,
	managedProcesses,
	zombieCheckIntervalId,
} from "./state.js";
import { handleToolCall } from "./toolHandler.js";
import { type CallToolResult, fail, ok, shape, textPayload } from "./types.js";
import type { ProcessStatus } from "./types.ts";
import {
	formatLogsForResponse,
	log,
	stripAnsiAndControlChars,
} from "./utils.js";

const labelSchema = z
	.string()
	.min(1, "Label cannot be empty.")
	.describe("A unique identifier for the process.");

const StartProcessParams = z.object(
	shape({
		label: labelSchema
			.optional()
			.describe(
				"Optional unique identifier for the process. If omitted, one will be generated based on the working directory and command (e.g., '/path/to/project:npm run dev') and returned.",
			),
		command: z
			.string()
			.min(1, "Command cannot be empty.")
			.describe("The command to execute (e.g., 'npm run dev')."),
		args: z
			.array(z.string())
			.optional()
			.default([])
			.describe("Optional arguments for the command."),
		workingDirectory: z
			.string()
			.describe(
				"MANDATORY: The **absolute** working directory to run the command from. **Do not use relative paths like '.' or '../'**. Provide the full path (e.g., '/Users/me/myproject'). This setting is required.",
			),
		verification_pattern: z
			.string()
			.optional()
			.describe(
				"Optional regex pattern (JS syntax) to verify successful startup from stdout.",
			),
		verification_timeout_ms: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				`Optional timeout for verification in milliseconds (default: ${DEFAULT_VERIFICATION_TIMEOUT_MS}ms).`,
			),
		retry_delay_ms: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				`Optional delay before restarting a crashed process in milliseconds (default: ${DEFAULT_RETRY_DELAY_MS}ms).`,
			),
		max_retries: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				`Optional maximum number of restart attempts for a crashed process (default: ${MAX_RETRIES}). 0 disables restarts.`,
			),
	}),
);

const CheckProcessStatusParams = z.object(
	shape({
		label: labelSchema,
		log_lines: z
			.number()
			.int()
			.min(0)
			.optional()
			.default(DEFAULT_LOG_LINES)
			.describe(
				`Number of recent log lines to *request*. Default: ${DEFAULT_LOG_LINES}. Max stored: ${MAX_STORED_LOG_LINES}. Use 'getAllLoglines' for the full stored history (up to ${MAX_STORED_LOG_LINES} lines).`,
			),
	}),
);

const StopProcessParams = z.object(
	shape({
		label: labelSchema,
		force: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Force kill (SIGKILL) the process instead of graceful termination (SIGTERM).",
			),
	}),
);

const ListProcessesParams = z.object(
	shape({
		log_lines: z
			.number()
			.int()
			.min(0)
			.optional()
			.default(0)
			.describe(
				"Number of recent log lines to include for each process (0 for none).",
			),
	}),
);

const RestartProcessParams = z.object(
	shape({
		label: labelSchema,
	}),
);

const WaitForProcessParams = z.object(
	shape({
		label: labelSchema,
		target_status: z
			.enum(["running", "stopped", "crashed", "error"])
			.optional()
			.default("running")
			.describe("The target status to wait for."),
		timeout_seconds: z
			.number()
			.positive()
			.optional()
			.default(60)
			.describe("Maximum time to wait in seconds."),
		check_interval_seconds: z
			.number()
			.positive()
			.optional()
			.default(2)
			.describe("Interval between status checks in seconds."),
	}),
);

const GetAllLoglinesParams = z.object(
	shape({
		label: labelSchema,
	}),
);

async function _checkProcessStatus(
	params: z.infer<typeof CheckProcessStatusParams>,
): Promise<CallToolResult> {
	const { label, log_lines } = params;
	const processInfo = await checkAndUpdateProcessStatus(label);

	if (!processInfo) {
		return fail(
			textPayload(
				JSON.stringify({
					error: `Process with label "${label}" not found.`,
					status: "not_found",
					pid: null,
				}),
			),
		);
	}

	const formattedLogs = formatLogsForResponse(
		processInfo.logs.map((l) => l.content),
		log_lines,
	);
	const actualReturnedLines = formattedLogs.length;
	const totalStoredLogs = processInfo.logs.length;

	const responsePayload = {
		label: processInfo.label,
		status: processInfo.status,
		pid: processInfo.pid,
		command: processInfo.command,
		args: processInfo.args,
		cwd: processInfo.cwd,
		exitCode: processInfo.exitCode,
		signal: processInfo.signal,
		logs: formattedLogs,
	};

	let hint = `Process is ${processInfo.status}.`;
	if (processInfo.status === "restarting") {
		hint += ` Attempt ${processInfo.restartAttempts ?? "?"}/${processInfo.maxRetries ?? "?"}.`;
	}
	if (processInfo.status === "crashed") {
		hint += ` Exited with code ${processInfo.exitCode ?? "N/A"}${processInfo.signal ? ` (signal ${processInfo.signal})` : ""}. Will ${processInfo.maxRetries && processInfo.maxRetries > 0 ? "attempt restart" : "not restart"}.`;
	}
	if (processInfo.status === "error") {
		hint += " Unrecoverable error occurred. Check logs.";
	}

	const storedLimitReached = totalStoredLogs >= MAX_STORED_LOG_LINES;
	if (log_lines > 0 && totalStoredLogs > actualReturnedLines) {
		const hiddenLines = totalStoredLogs - actualReturnedLines;
		hint += ` Returned the latest ${actualReturnedLines} log lines. ${hiddenLines} older lines exist${storedLimitReached ? ` (storage limit: ${MAX_STORED_LOG_LINES}, older logs may have been discarded)` : ""}. Use 'getAllLoglines' for the full stored history.`;
	} else if (log_lines === 0 && totalStoredLogs > 0) {
		hint += ` ${totalStoredLogs} log lines are stored${storedLimitReached ? ` (storage limit: ${MAX_STORED_LOG_LINES})` : ""}. Use 'getAllLoglines' or specify 'log_lines' > 0.`;
	} else if (log_lines > 0 && totalStoredLogs > 0) {
		hint += ` Returned all ${actualReturnedLines} stored log lines${storedLimitReached ? ` (storage limit: ${MAX_STORED_LOG_LINES})` : ""}.`;
	}

	return ok(textPayload(JSON.stringify({ ...responsePayload, hint }, null, 2)));
}

async function _listProcesses(
	params: z.infer<typeof ListProcessesParams>,
): Promise<CallToolResult> {
	const { log_lines } = params;
	if (managedProcesses.size === 0) {
		return ok(textPayload("No background processes are currently managed."));
	}

	const processList = [];
	for (const label of managedProcesses.keys()) {
		const processInfo = await checkAndUpdateProcessStatus(label);
		if (processInfo) {
			let formattedLogs: string[] | undefined = undefined;
			let logHint: string | undefined = undefined;

			if (log_lines > 0) {
				const totalStoredLogs = processInfo.logs.length;
				formattedLogs = formatLogsForResponse(
					processInfo.logs.map((l) => l.content),
					log_lines,
				);
				const actualReturnedLines = formattedLogs.length;
				const storedLimitReached = totalStoredLogs >= MAX_STORED_LOG_LINES;

				if (totalStoredLogs > actualReturnedLines) {
					const hiddenLines = totalStoredLogs - actualReturnedLines;
					logHint = `Returned latest ${actualReturnedLines} lines. ${hiddenLines} older lines exist${storedLimitReached ? ` (limit: ${MAX_STORED_LOG_LINES})` : ""}. Use 'getAllLoglines'.`;
				} else if (totalStoredLogs > 0) {
					logHint = `Returned all ${actualReturnedLines} stored lines${storedLimitReached ? ` (limit: ${MAX_STORED_LOG_LINES})` : ""}.`;
				}
			} else if (log_lines === 0 && processInfo.logs.length > 0) {
				const totalStoredLogs = processInfo.logs.length;
				const storedLimitReached = totalStoredLogs >= MAX_STORED_LOG_LINES;
				logHint = `${totalStoredLogs} lines stored${storedLimitReached ? ` (limit: ${MAX_STORED_LOG_LINES})` : ""}. Use 'getAllLoglines' or 'log_lines' > 0.`;
			}

			processList.push({
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
			});
		}
	}

	const message = `Found ${processList.length} managed processes.`;
	return ok(
		textPayload(
			JSON.stringify(
				{ message, processes: processList },
				(key, value) => (value === undefined ? null : value),
				2,
			),
		),
	);
}

async function _stopAllProcesses(): Promise<CallToolResult> {
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

async function _restartProcess(
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

async function _waitForProcess(
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

async function _getAllLoglines(
	params: z.infer<typeof GetAllLoglinesParams>,
): Promise<CallToolResult> {
	const { label } = params;
	// Get directly, no need to check OS process status for logs
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

	// Retrieve ALL stored logs
	const allLogs = processInfo.logs.map((l) => l.content);
	// Clean them consistently
	const cleanedLogs = allLogs.map(stripAnsiAndControlChars); // Use your cleaning function

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

async function _healthCheck(): Promise<CallToolResult> {
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
		zombie_check_active: !!zombieCheckIntervalId,
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

export function registerToolDefinitions(server: McpServer): void {
	server.tool(
		"start_process",
		"Starts a background process (like a dev server or script) and manages it.",
		shape(StartProcessParams.shape),
		(params: z.infer<typeof StartProcessParams>) => {
			const cwdForLabel = params.workingDirectory;
			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;

			log.info(
				effectiveLabel,
				`Determined label for start_process: ${effectiveLabel}`,
			);

			return handleToolCall(
				effectiveLabel,
				"start_process",
				params,
				async () => {
					const verificationPattern = params.verification_pattern
						? new RegExp(params.verification_pattern)
						: undefined;

					return await _startProcess(
						effectiveLabel,
						params.command,
						params.args,
						params.workingDirectory,
						verificationPattern,
						params.verification_timeout_ms,
						params.retry_delay_ms,
						params.max_retries,
						false,
					);
				},
			);
		},
		/**
		 * Example usage: Start a Node.js server
		 * ```json
		 * {
		 *   "label": "my-node-server",
		 *   "command": "node server.js",
		 *   "workingDirectory": "/path/to/project",
		 *   "verification_pattern": "Server running on port",
		 *   "verification_timeout_ms": 10000
		 * }
		 * ```
		 *
		 * Example usage: Run tests in watch mode (no label - one will be generated)
		 * ```json
		 * {
		 *   "command": "jest",
		 *   "args": ["--watch"],
		 *   "workingDirectory": "/path/to/project"
		 * }
		 * ```
		 *
		 * Example usage: Compile TypeScript in watch mode
		 * ```json
		 * {
		 *   "label": "tsc-watch",
		 *   "command": "tsc",
		 *   "args": ["--watch"],
		 *   "workingDirectory": "/path/to/ts-project",
		 *   "verification_pattern": "Watching for file changes"
		 * }
		 * ```
		 *
		 * Example usage: Start a background Python script
		 * ```json
		 * {
		 *   "label": "data-processor",
		 *   "command": "python",
		 *   "args": ["./scripts/data_processor.py"],
		 *   "workingDirectory": "/path/to/repo",
		 *   "max_retries": 0
		 * }
		 * ```
		 */
	);

	server.tool(
		"check_process_status",
		"Checks the status and retrieves recent logs of a managed background process.",
		shape(CheckProcessStatusParams.shape),
		(params: z.infer<typeof CheckProcessStatusParams>) =>
			handleToolCall(params.label, "check_process_status", params, () =>
				_checkProcessStatus(params),
			),
	);

	server.tool(
		"stop_process",
		"Stops a specific background process.",
		shape(StopProcessParams.shape),
		(params: z.infer<typeof StopProcessParams>) =>
			handleToolCall(params.label, "stop_process", params, async () => {
				return await _stopProcess(params.label, params.force);
			}),
	);

	server.tool(
		"list_processes",
		"Lists all managed background processes and their statuses.",
		shape(ListProcessesParams.shape),
		(params: z.infer<typeof ListProcessesParams>) =>
			handleToolCall(null, "list_processes", params, () =>
				_listProcesses(params),
			),
	);

	server.tool(
		"stop_all_processes",
		"Attempts to gracefully stop all active background processes.",
		{},
		(params: Record<string, never>) =>
			handleToolCall(null, "stop_all_processes", params, _stopAllProcesses),
	);

	server.tool(
		"restart_process",
		"Restarts a specific background process by stopping and then starting it again.",
		shape(RestartProcessParams.shape),
		(params: z.infer<typeof RestartProcessParams>) =>
			handleToolCall(params.label, "restart_process", params, () =>
				_restartProcess(params),
			),
	);

	server.tool(
		"wait_for_process",
		"Waits for a specific background process to reach a target status (e.g., running).",
		shape(WaitForProcessParams.shape),
		(params: z.infer<typeof WaitForProcessParams>) =>
			handleToolCall(params.label, "wait_for_process", params, () =>
				_waitForProcess(params),
			),
	);

	server.tool(
		"get_all_loglines",
		"Retrieves the complete remaining log history for a specific managed process.",
		shape(GetAllLoglinesParams.shape),
		(params: z.infer<typeof GetAllLoglinesParams>) =>
			handleToolCall(params.label, "get_all_loglines", params, () =>
				_getAllLoglines(params),
			),
	);

	server.tool(
		"health_check",
		"Provides a health status summary of the MCP Process Manager itself.",
		{},
		(params: Record<string, never>) =>
			handleToolCall(null, "health_check", params, _healthCheck),
	);

	log.info(null, "Tool definitions registered.");
}

function getResultText(result: CallToolResult): string | null {
	if (result.content && result.content.length > 0) {
		const firstContent = result.content[0];
		if (
			firstContent &&
			typeof firstContent === "object" &&
			"type" in firstContent &&
			firstContent.type === "text" &&
			"text" in firstContent &&
			typeof firstContent.text === "string"
		) {
			return firstContent.text;
		}
	}
	return null;
}
