import type * as fs from "node:fs";
// import type { ProcessInfo as OriginalProcessInfo } from "@cursor/types"; // REMOVE this import
// import type { ProcessInfo as OriginalProcessInfo } from "@cursor/types"; // REMOVED
import type { IDisposable, IPty } from "node-pty";
import { z } from "zod";
import { HostEnum } from "./toolDefinitions.js"; // <-- IMPORT HostEnum Zod object
// REMOVE: import { ProcessInfo as OriginalProcessInfo } from "@cursor/types"; // ADD back temporarily for ProcessInfo extension

/* ------------------------------------------------------------------------ */
/*  1.  MCP payload primitives - RESTORED LOCAL DEFINITIONS                 */
/* ------------------------------------------------------------------------ */
export interface TextContent {
	readonly type: "text";
	text: string;
	[key: string]: unknown;
}

export interface ImageContent {
	readonly type: "image";
	/** base-64 payload */
	data: string;
	// Reverting to mandatory mimeType based on original code and SDK error
	mimeType: string;
	// Removed optional contentType and caption based on original
	[key: string]: unknown;
}

export interface AudioContent {
	readonly type: "audio";
	/** base-64 payload */
	data: string;
	// Reverting to mandatory mimeType based on original code and SDK error
	mimeType: string;
	// Removed optional contentType and caption based on original
	[key: string]: unknown;
}

// Keep local TextResource/BlobResource as they weren't part of the failed SDK import attempt
export interface TextResource {
	/** raw text representation of the resource */
	text: string;
	uri: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface BlobResource {
	/** base-64 blob (files, compressed JSON, etc.) */
	uri: string;
	blob: string;
	mimeType?: string;
	[key: string]: unknown;
}

// Restore local ResourceContent (using Text/BlobResource)
export interface ResourceContent {
	readonly type: "resource";
	// Reverting to original structure with mandatory resource field
	resource: TextResource | BlobResource;
	// Removed optional caption based on original
	[key: string]: unknown;
}

export type ToolContent =
	| TextContent
	| ImageContent
	| AudioContent
	| ResourceContent;

/* ------------------------------------------------------------------------ */
/*  2.  Strongly-typed CallToolResult - KEEPING LOCAL DEFINITION            */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/*  4.  Zod helpers – give server.tool what it actually wants               */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/*  5.  Utility guards (optional but nice) - RESTORED from original         */
/* ------------------------------------------------------------------------ */

/** Represents the current state of a managed process. */
export type ProcessStatus =
	| "starting"
	| "running"
	| "verifying"
	| "stopped"
	| "crashed"
	| "error"
	| "restarting"
	| "stopping";

/** Represents a single log entry with timestamp and content. */
export interface LogEntry {
	timestamp: number;
	content: string;
}

/** Detailed information about a managed process. */
export interface ProcessInfo {
	label: string;
	command: string;
	args: string[];
	cwd: string;
	host: HostEnum;
	status: ProcessStatus;
	logs: LogEntry[];
	pid: number | undefined;
	process: IPty | null;
	dataListener?: IDisposable;
	onExitListener?: IDisposable;
	exitCode: number | null;
	signal: string | null;
	verificationPattern?: RegExp;
	verificationTimeoutMs?: number;
	retryDelayMs?: number;
	maxRetries?: number;
	restartAttempts?: number;
	lastExitTimestamp?: number;
	lastCrashTime?: number;
	isRestarting?: boolean;
	stopRequested?: boolean;
	verificationTimer?: NodeJS.Timeout;
	logFilePath: string | null;
	logFileStream: fs.WriteStream | null;
	lastLogTimestampReturned?: number;
	mainDataListenerDisposable?: IDisposable;
	mainExitListenerDisposable?: IDisposable;
	partialLineBuffer?: string;
}

/** Result structure for tool calls, indicating success or failure. */
export interface CallToolResult {
	isError: boolean;
	payload: {
		contentType: "text/plain" | "application/json";
		content: string;
	};
}

// --- Zod Schemas for Tool Response Payloads ---

// Shared schema for status and log info
const ProcessStatusInfoSchema = z.object({
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

// Schema for start_process success payload
export const StartSuccessPayloadSchema = z
	.object({
		label: z.string(),
		command: z.string(),
		args: z.array(z.string()),
		pid: z.number(),
		workingDirectory: z.string(),
		message: z.string(),
		host: HostEnum.optional(),
		// The below are added during _startProcess but not part of initial definition
		tail_command: z.string().optional(),
		verificationFailureReason: z.string().optional(),
		isVerificationEnabled: z.boolean().optional(),
		verificationPattern: z.string().optional(),
		verificationTimeoutMs: z.number().optional(),
	})
	.describe("Response payload for a successful start_process call.");

// Schema for start_process error payload (specific errors)
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

// Schema for check_process_status payload
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
}).describe("Response payload for check_process_status.");

// Schema for list_processes item payload
export const ListProcessDetailSchema = ProcessStatusInfoSchema.extend({
	logs: z
		.array(z.string())
		.describe(
			"Array of recent log lines (if requested > 0). Ordered oldest to newest.",
		),
	log_hint: z
		.string()
		.nullable()
		.describe("Hint about the included logs or total stored lines."),
}).describe("Details for a single process in the list_processes response.");

// Schema for list_processes response (array of details)
export const ListProcessesPayloadSchema = z
	.array(ListProcessDetailSchema)
	.describe(
		"Response payload for list_processes, containing an array of process details.",
	);

// Schema for stop_process payload
export const StopProcessPayloadSchema = z
	.object({
		label: z.string().describe("The label of the process targeted."),
		status: ProcessStatusInfoSchema.shape.status
			.optional()
			.describe("Final status after stop attempt."),
		message: z
			.string()
			.describe("Summary message of the stop operation outcome."),
		pid: ProcessStatusInfoSchema.shape.pid,
	})
	.describe("Response payload for stop_process.");

// Schema for stop_all_processes item detail
const StopAllDetailSchema = z.object({
	label: z.string().describe("Process label."),
	result: z
		.enum(["SignalSent", "Skipped", "Failed", "NotFound"])
		.describe("Outcome for this specific process (e.g., SignalSent, Skipped)."),
	status: ProcessStatusInfoSchema.shape.status
		.or(z.literal("not_found"))
		.optional()
		.describe("Status before/after stop attempt, or 'not_found'."),
	pid: ProcessStatusInfoSchema.shape.pid,
});

// Schema for stop_all_processes payload
export const StopAllProcessesPayloadSchema = z
	.object({
		summary: z.string().describe("Overall summary of the stop_all operation."),
		details: z
			.array(StopAllDetailSchema)
			.describe("Array containing the outcome for each managed process."),
	})
	.describe("Response payload for stop_all_processes.");

// Schema for restart_process success payload
export const RestartSuccessPayloadSchema = StartSuccessPayloadSchema.extend(
	{},
).describe(
	"Response payload for a successful restart_process call (structure mirrors start_process success).",
);

// Schema for restart_process failure payload
export const RestartErrorPayloadSchema = z
	.object({
		error: z.string().describe("Description of why the restart failed."),
		status: ProcessStatusInfoSchema.shape.status
			.optional()
			.describe("Status at the time of failure."),
		pid: ProcessStatusInfoSchema.shape.pid,
	})
	.describe("Response payload for a failed restart_process call.");

// Schema for wait_for_process payload
export const WaitForProcessPayloadSchema = z
	.object({
		label: z.string().describe("The label of the process waited for."),
		final_status: ProcessStatusInfoSchema.shape.status.describe(
			"The status of the process when the wait concluded.",
		),
		message: z
			.string()
			.describe(
				"Message indicating if the target status was reached or if it timed out.",
			),
		timed_out: z
			.boolean()
			.describe("True if the wait timed out, false otherwise."),
	})
	.describe("Response payload for wait_for_process.");

// Schema for get_all_loglines payload
export const GetAllLoglinesPayloadSchema = z
	.object({
		label: z
			.string()
			.describe("The label of the process whose logs were requested."),
		logs: z
			.array(z.string())
			.describe(
				"Array containing all stored log lines for the process (up to the storage limit). Ordered oldest to newest.",
			),
		count: z.number().int().describe("Total number of log lines returned."),
		storage_limit: z
			.number()
			.int()
			.describe("The maximum number of log lines stored per process."),
	})
	.describe("Response payload for get_all_loglines.");

// Schema for send_input payload
export const SendInputPayloadSchema = z
	.object({
		label: z.string().describe("The label of the process that received input."),
		message: z
			.string()
			.describe("Confirmation message indicating input was sent."),
	})
	.describe("Response payload for send_input.");

// Schema for health_check payload
export const HealthCheckPayloadSchema = z
	.object({
		status: z.literal("ok").describe("Indicates the server is running."),
		server_name: z.string().describe("Name of the process manager server."),
		version: z.string().describe("Version of the process manager server."),
		active_processes: z
			.number()
			.int()
			.describe("Number of currently managed processes."),
		zombie_check_active: z
			.boolean()
			.describe("Indicates if the zombie process check timer is running."),
	})
	.describe("Response payload for health_check.");

export type { HostEnum }; // <-- EXPORT HostEnum

export type StartSuccessPayload = z.infer<typeof StartSuccessPayloadSchema> & {
	status: ProcessStatus;
	logs?: string[];
	monitoring_hint?: string;
	info_message?: string; // ADDED FOR TEMP COMPATIBILITY
};
