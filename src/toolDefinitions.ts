import type { McpServer, RequestHandlerExtra } from "@modelcontextprotocol/sdk";
import { z } from "zod";
import {
	DEFAULT_LOG_LINES,
	DEFAULT_RETRY_DELAY_MS,
	DEFAULT_VERIFICATION_TIMEOUT_MS,
	MAX_RETRIES,
	MAX_STORED_LOG_LINES,
} from "./constants.js";
import { _startProcess, _stopProcess } from "./processLogic.js";
import { handleToolCall } from "./toolHandler.js";
import {
	checkProcessStatusImpl,
	getAllLoglinesImpl,
	healthCheckImpl,
	listProcessesImpl,
	restartProcessImpl,
	sendInputImpl,
	stopAllProcessesImpl,
	waitForProcessImpl,
} from "./toolImplementations.js";
import { HostEnum } from "./types.js";
import { log } from "./utils.js";

export const labelSchema = z
	.string()
	.min(1)
	.regex(
		/^[a-zA-Z0-9_\-.:/]+$/,
		"Label can only contain letters, numbers, underscores, hyphens, periods, colons, and forward slashes.",
	);

const shape = <T extends z.ZodRawShape>(shape: T): T => shape;

const StartProcessParams = z.object(
	shape({
		label: labelSchema
			.optional()
			.describe(
				"Optional human-readable identifier (e.g. 'dev-server'). Leave blank to let the server generate one based on CWD and command.",
			),
		command: z
			.string()
			.min(1)
			.describe("The command to execute. e.g., 'npm' or some other runner"),
		args: z
			.array(z.string())
			.optional()
			.default([])
			.describe(
				"Optional arguments for the command, e.g. 'npm run dev' would be ['run', 'dev']",
			),
		workingDirectory: z
			.string()
			.min(1)
			.describe(
				"The absolute working directory to run the command from. This setting is required. Do not use relative paths like '.' or '../'. Provide the full path (e.g., /Users/me/myproject).",
			),
		host: HostEnum.optional()
			.default("unknown")
			.describe(
				"Identifier for the client initiating the process (e.g., 'cursor', 'claude', 'vscode'). Defaults to 'unknown'.",
			),
		verification_pattern: z
			.string()
			.optional()
			.describe(
				"Optional regex pattern to match in stdout/stderr to verify successful startup. e.g., 'running on port 3000' or 'localhost'",
			),
		verification_timeout_ms: z
			.number()
			.int()
			.min(-1)
			.optional()
			.default(DEFAULT_VERIFICATION_TIMEOUT_MS)
			.describe(
				"Milliseconds to wait for the verification pattern. -1 disables the timer (default).",
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

export type StartProcessParamsType = z.infer<typeof StartProcessParams>;

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
				`Number of recent log lines to request. Default: ${DEFAULT_LOG_LINES}. Max stored: ${MAX_STORED_LOG_LINES}. Use 'getAllLoglines' for the full stored history (up to ${MAX_STORED_LOG_LINES} lines).`,
			),
	}),
);

export type CheckProcessStatusParams = z.infer<typeof CheckProcessStatusParams>;

const StopProcessParams = z.object(
	shape({
		label: labelSchema,
		force: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Use SIGKILL to force kill the process instead of SIGTERM for graceful termination. Defaults to false.",
			),
	}),
);

export type StopProcessParams = z.infer<typeof StopProcessParams>;

const ListProcessesParams = z.object(
	shape({
		log_lines: z
			.number()
			.int()
			.min(0)
			.optional()
			.default(0)
			.describe(
				"Number of recent log lines to include for each process (default: 0 for none).",
			),
	}),
);

export type ListProcessesParams = z.infer<typeof ListProcessesParams>;

const RestartProcessParams = z.object(
	shape({
		label: labelSchema,
	}),
);

export type RestartProcessParams = z.infer<typeof RestartProcessParams>;

const WaitForProcessParams = z.object(
	shape({
		label: labelSchema,
		target_status: z
			.enum(["running", "stopped", "crashed", "error"])
			.optional()
			.default("running")
			.describe(
				"The target status to wait for (e.g., 'running', 'stopped'). Defaults to 'running'.",
			),
		timeout_seconds: z
			.number()
			.positive()
			.optional()
			.default(5)
			.describe("Maximum time to wait in seconds. Defaults to 5."),
		check_interval_seconds: z
			.number()
			.positive()
			.optional()
			.default(2)
			.describe("Interval between status checks in seconds. Defaults to 2."),
	}),
);

export type WaitForProcessParams = z.infer<typeof WaitForProcessParams>;

const GetAllLoglinesParams = z.object(
	shape({
		label: labelSchema,
	}),
);

export type GetAllLoglinesParams = z.infer<typeof GetAllLoglinesParams>;

const SendInputParams = z.object(
	shape({
		label: labelSchema.describe("The label of the target process."),
		input: z.string().describe("The text input to send to the process stdin."),
		append_newline: z
			.boolean()
			.optional()
			.default(true)
			.describe(
				"Whether to automatically append a carriage return character ('\r') after the input, simulating pressing Enter. Defaults to true.",
			),
	}),
);

export type SendInputParams = z.infer<typeof SendInputParams>;

// Define response types (can move to types.ts)
// ... ListProcessDetail interface ...

// Implementation functions moved to src/toolImplementations.ts

export function registerToolDefinitions(server: McpServer): void {
	server.tool(
		"start_process",
		"Starts a background process (like a dev server or script) and manages it.",
		shape(StartProcessParams.shape),
		(
			params: z.infer<typeof StartProcessParams>,
			extra: RequestHandlerExtra,
		) => {
			const cwdForLabel = params.workingDirectory;
			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;
			const hostValue = params.host;

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
						hostValue,
						verificationPattern,
						params.verification_timeout_ms,
						params.retry_delay_ms,
						params.max_retries,
						false,
					);
				},
			);
		},
	);

	server.tool(
		"check_process_status",
		"Checks the status and retrieves recent logs of a managed background process.",
		shape(CheckProcessStatusParams.shape),
		(
			params: z.infer<typeof CheckProcessStatusParams>,
			extra: RequestHandlerExtra,
		) =>
			handleToolCall(params.label, "check_process_status", params, () =>
				checkProcessStatusImpl(params),
			),
	);

	server.tool(
		"stop_process",
		"Stops a specific background process.",
		shape(StopProcessParams.shape),
		(params: z.infer<typeof StopProcessParams>, extra: RequestHandlerExtra) =>
			handleToolCall(params.label, "stop_process", params, async () => {
				return await _stopProcess(params.label, params.force);
			}),
	);

	server.tool(
		"list_processes",
		"Lists all managed background processes and their statuses.",
		shape(ListProcessesParams.shape),
		(params: z.infer<typeof ListProcessesParams>, extra: RequestHandlerExtra) =>
			handleToolCall(null, "list_processes", params, () =>
				listProcessesImpl(params),
			),
	);

	server.tool(
		"stop_all_processes",
		"Attempts to gracefully stop all active background processes.",
		{},
		(params: Record<string, never>, extra: RequestHandlerExtra) =>
			handleToolCall(null, "stop_all_processes", params, stopAllProcessesImpl),
	);

	server.tool(
		"restart_process",
		"Restarts a specific background process by stopping and then starting it again.",
		shape(RestartProcessParams.shape),
		(
			params: z.infer<typeof RestartProcessParams>,
			extra: RequestHandlerExtra,
		) =>
			handleToolCall(params.label, "restart_process", params, () =>
				restartProcessImpl(params),
			),
	);

	server.tool(
		"wait_for_process",
		"Waits for a specific background process to reach a target status (e.g., running).",
		shape(WaitForProcessParams.shape),
		(
			params: z.infer<typeof WaitForProcessParams>,
			extra: RequestHandlerExtra,
		) =>
			handleToolCall(params.label, "wait_for_process", params, () =>
				waitForProcessImpl(params),
			),
	);

	server.tool(
		"get_all_loglines",
		"Retrieves the complete remaining log history for a specific managed process.",
		shape(GetAllLoglinesParams.shape),
		(
			params: z.infer<typeof GetAllLoglinesParams>,
			extra: RequestHandlerExtra,
		) =>
			handleToolCall(params.label, "get_all_loglines", params, () =>
				getAllLoglinesImpl(params),
			),
	);

	server.tool(
		"health_check",
		"Provides a health status summary of the MCP Process Manager itself.",
		{},
		(params: Record<string, never>, extra: RequestHandlerExtra) =>
			handleToolCall(null, "health_check", params, healthCheckImpl),
	);

	server.tool(
		"send_input",
		"Sends input to a specific managed process.",
		shape(SendInputParams.shape),
		(params: z.infer<typeof SendInputParams>, extra: RequestHandlerExtra) =>
			handleToolCall(params.label, "send_input", params, () =>
				sendInputImpl(params.label, params.input, params.append_newline),
			),
	);

	log.info(null, "Tool definitions registered.");
}

export type { SendInputParams };
export type {
	CheckProcessStatusParams,
	GetAllLoglinesParams,
	ListProcessesParams,
	RestartProcessParams,
	WaitForProcessParams,
};
