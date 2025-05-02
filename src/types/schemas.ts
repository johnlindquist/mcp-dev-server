import { z } from "zod";
import { cfg } from "../constants/index.js"; // Update path
import { HostEnum } from "./process.js"; // Import HostEnum from process types

// Helper to keep shape definition clean
const shape = <T extends z.ZodRawShape>(shape: T): T => shape;

// Label Schema (used across multiple param schemas)
export const labelSchema = z
	.string()
	.min(1)
	.regex(
		/^[a-zA-Z0-9_\-.:/]+$/,
		"Label can only contain letters, numbers, underscores, hyphens, periods, colons, and forward slashes.",
	);

// --- Parameter Schemas ---

export const StartProcessParams = z.object(
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
			.default(cfg.defaultVerificationTimeoutMs)
			.describe(
				"Milliseconds to wait for the verification pattern. -1 disables the timer (default).",
			),
		retry_delay_ms: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				`Optional delay before restarting a crashed process in milliseconds (default: ${cfg.defaultRetryDelayMs}ms).`,
			),
		max_retries: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				`Optional maximum number of restart attempts for a crashed process (default: ${cfg.maxRetries}). 0 disables restarts.`,
			),
	}),
);
export type StartProcessParamsType = z.infer<typeof StartProcessParams>;

export const CheckProcessStatusParams = z.object(
	shape({
		label: labelSchema,
		log_lines: z
			.number()
			.int()
			.min(0)
			.optional()
			.default(cfg.defaultCheckStatusLogLines)
			.describe(
				`Number of recent log lines to request. Default: ${cfg.defaultCheckStatusLogLines}. Max stored: ${cfg.maxStoredLogLines}. Use 'getAllLoglines' for the full stored history (up to ${cfg.maxStoredLogLines} lines).`,
			),
	}),
);
export type CheckProcessStatusParamsType = z.infer<
	typeof CheckProcessStatusParams
>;

export const StopProcessParams = z.object(
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
export type StopProcessParamsType = z.infer<typeof StopProcessParams>;

export const ListProcessesParams = z.object(
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
export type ListProcessesParamsType = z.infer<typeof ListProcessesParams>;

export const RestartProcessParams = z.object(
	shape({
		label: labelSchema,
	}),
);
export type RestartProcessParamsType = z.infer<typeof RestartProcessParams>;

export const WaitForProcessParams = z.object(
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
export type WaitForProcessParamsType = z.infer<typeof WaitForProcessParams>;

export const GetAllLoglinesParams = z.object(
	shape({
		label: labelSchema,
	}),
);
export type GetAllLoglinesParamsType = z.infer<typeof GetAllLoglinesParams>;

export const SendInputParams = z.object(
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
export type SendInputParamsType = z.infer<typeof SendInputParams>;

// --- Response Payload Schemas ---

// Shared schema part for status responses
export const ProcessStatusInfoSchema = z.object({
	label: z.string().describe("The unique identifier for the process."),
	status: z
		.enum([
			"starting",
			"running",
			"verifying",
			"stopped",
			"crashed",
			"error",
			"restarting",
			"stopping",
		])
		.describe("Current status of the process."),
	pid: z
		.number()
		.optional()
		.describe("Process ID if currently running, otherwise undefined."),
	command: z.string().describe("The command executed for this process."),
	args: z.array(z.string()).describe("Arguments passed to the command."),
	cwd: z.string().describe("The working directory of the process."),
	exitCode: z
		.number()
		.nullable()
		.describe("Exit code if the process has terminated, otherwise null."),
	signal: z
		.string()
		.nullable()
		.describe(
			"Signal name if the process was terminated by a signal, otherwise null.",
		),
	log_file_path: z
		.string()
		.nullable()
		.optional()
		.describe("Absolute path to the log file, if logging to file is enabled."),
	tail_command: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Convenience command to tail the log file in a terminal (e.g., 'tail -f /path/to/log').",
		),
});

// start_process success payload
export const StartSuccessPayloadSchema = z
	.object({
		label: z.string(),
		command: z.string(),
		args: z.array(z.string()),
		pid: z.number(),
		workingDirectory: z.string(),
		message: z.string(),
		host: HostEnum.optional(),
		tail_command: z.string().optional(),
		verificationFailureReason: z.string().optional(),
		isVerificationEnabled: z.boolean().optional(),
		verificationPattern: z.string().optional(),
		verificationTimeoutMs: z.number().optional(),
	})
	.describe("Response payload for a successful start_process call.");
export type StartSuccessPayloadType = z.infer<typeof StartSuccessPayloadSchema>; // & { status: ProcessStatus, logs?: string[], monitoring_hint?: string }; // Add complex type if needed

// start_process error payload
export const StartErrorPayloadSchema = z
	.object({
		error: z.string().describe("Description of the error."),
		status: z
			.string()
			.optional()
			.describe("Process status at the time of error."),
		cwd: z.string().optional().describe("Working directory used."),
		error_type: z
			.string()
			.optional()
			.describe(
				"Categorical type of error (e.g., 'working_directory_not_found').",
			),
	})
	.describe("Response payload for a failed start_process call.");
export type StartErrorPayloadType = z.infer<typeof StartErrorPayloadSchema>;

// check_process_status payload
export const CheckStatusPayloadSchema = ProcessStatusInfoSchema.extend({
	logs: z
		.array(z.string())
		.describe(
			"Array of recent log lines (up to the requested limit). Ordered oldest to newest.",
		),
	hint: z
		.string()
		.optional()
		.describe(
			"Hint about the returned logs (e.g., if truncated or if more lines are stored).",
		),
	message: z
		.string()
		.describe(
			"Natural-language summary of everything notable since the last check.",
		),
}).describe("Response payload for a check_process_status call.");
export type CheckStatusPayloadType = z.infer<typeof CheckStatusPayloadSchema>;

// list_processes individual item schema
export const ListProcessDetailSchema = ProcessStatusInfoSchema.extend({
	logs: z
		.array(z.string())
		.describe(
			"Array of log lines requested (up to the limit, if specified). Ordered oldest to newest.",
		),
	log_hint: z
		.string()
		.nullable()
		.optional()
		.describe("Hint about the logs shown (e.g., number stored vs shown)."),
}).describe(
	"Detailed information for a single process in the list_processes response.",
);
export type ListProcessDetailType = z.infer<typeof ListProcessDetailSchema>;

// list_processes payload (array of details)
export const ListProcessesPayloadSchema = z
	.array(ListProcessDetailSchema)
	.describe("Response payload for a list_processes call.");
export type ListProcessesPayloadType = z.infer<
	typeof ListProcessesPayloadSchema
>;

// stop_process payload
export const StopProcessPayloadSchema = z
	.object({
		label: z.string(),
		status: z.string(), // Could refine this enum later
		message: z.string(),
	})
	.describe("Response payload for a stop_process call.");
export type StopProcessPayloadType = z.infer<typeof StopProcessPayloadSchema>;

// stop_all_processes payload
export const StopAllProcessesPayloadSchema = z
	.object({
		stopped_count: z.number().int(),
		skipped_count: z.number().int(),
		error_count: z.number().int(),
		details: z.array(
			z.object({
				label: z.string(),
				status: z.string(), // Could refine
				message: z.string(),
				is_error: z.boolean(),
			}),
		),
	})
	.describe("Response payload for a stop_all_processes call.");
export type StopAllProcessesPayloadType = z.infer<
	typeof StopAllProcessesPayloadSchema
>;

// restart_process error payload
export const RestartErrorPayloadSchema = z
	.object({
		error: z.string(),
		label: z.string().optional(),
	})
	.describe("Error payload for a failed restart_process call.");
export type RestartErrorPayloadType = z.infer<typeof RestartErrorPayloadSchema>;

// wait_for_process payload
export const WaitForProcessPayloadSchema = z
	.object({
		label: z.string(),
		final_status: z.string(), // Could refine
		message: z.string(),
		timed_out: z.boolean().optional(),
	})
	.describe("Response payload for a wait_for_process call.");
export type WaitForProcessPayloadType = z.infer<
	typeof WaitForProcessPayloadSchema
>;

// get_all_loglines payload
export const GetAllLoglinesPayloadSchema = z
	.object({
		label: z.string(),
		logs: z.array(z.string()),
		message: z.string(),
		line_count: z.number().int(),
		is_truncated: z.boolean(),
	})
	.describe("Response payload for a get_all_loglines call.");
export type GetAllLoglinesPayloadType = z.infer<
	typeof GetAllLoglinesPayloadSchema
>;

// health_check payload
export const HealthCheckPayloadSchema = z
	.object({
		status: z
			.string()
			.describe("Overall health status (e.g., 'OK', 'WARNING')."),
		server_name: z.string().describe("Name of the MCP-PM server."),
		server_version: z.string().describe("Version of the MCP-PM server."),
		active_processes: z
			.number()
			.int()
			.describe("Number of currently managed processes."),
		is_zombie_check_active: z
			.boolean()
			.describe("Indicates if the zombie process check is running."),
		message: z
			.string()
			.optional()
			.describe("Additional health information or warnings."),
	})
	.describe("Response payload for a health_check call.");
export type HealthCheckPayloadType = z.infer<typeof HealthCheckPayloadSchema>;

export const BaseRequestSchema = z.object({
	requestId: z.string().uuid().optional(),
});
