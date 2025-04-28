import type { IPty } from "node-pty";
import type { ZodRawShape } from "zod";

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
/*  2.  Strongly-typed CallToolResult - RESTORED LOCAL DEFINITION           */
/* ------------------------------------------------------------------------ */
export interface CallToolResult {
	/** Actual tool output; at least one payload required. */
	content: ToolContent[];
	/** Optional metadata – free-form. */
	_meta?: Record<string, unknown>;
	/** Signals a domain-level failure (LLMs can still read `content`). */
	isError?: boolean;
	/** Index signature to match SDK type */
	[key: string]: unknown;
}

export const textPayload = (text: string): TextContent =>
	({ type: "text", text }) as const;

export const ok = (...c: readonly ToolContent[]): CallToolResult => ({
	content: [...c],
});

export const fail = (...c: readonly ToolContent[]): CallToolResult => ({
	isError: true,
	content: [...c],
});

/* ------------------------------------------------------------------------ */
/*  4.  Zod helpers – give server.tool what it actually wants               */
/* ------------------------------------------------------------------------ */
export const shape = <T extends ZodRawShape>(x: T) => x;

/* ------------------------------------------------------------------------ */
/*  5.  Utility guards (optional but nice) - RESTORED from original         */
/* ------------------------------------------------------------------------ */
export const safeSubstring = (v: unknown, len = 100): string =>
	typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
	status === "running" || status === "verifying";

/** Utility fn to extract string content from a CallToolResult, or null */
export const getResultText = (result: CallToolResult): string | null => {
	for (const item of result.content) {
		if (item.type === "text") {
			return item.text;
		}
	}
	return null;
};

// Define LogEntry structure based on usage in state.ts
export interface LogEntry {
	timestamp: number;
	content: string;
}

/**
 * Contains information about a managed background process.
 */
export interface ProcessInfo {
	label: string; // User-defined identifier
	process: IPty | null; // The node-pty process instance
	command: string; // The command used to start the process
	args: string[]; // Arguments for the command
	cwd: string; // Working directory
	pid: number | undefined; // Process ID
	logs: LogEntry[]; // Ring buffer of recent log entries
	status: ProcessStatus;
	exitCode: number | null;
	signal: string | null;
	lastCrashTime?: number; // Timestamp of the last crash
	restartAttempts?: number; // Number of restart attempts in the current crash loop window
	verificationPattern?: RegExp; // Optional pattern to verify successful startup
	verificationTimeoutMs?: number | null; // Timeout for verification (null means disabled)
	verificationTimer?: NodeJS.Timeout; // Timer for verification timeout
	retryDelayMs?: number | null; // Delay before restarting after a crash (null means disabled)
	maxRetries?: number; // Maximum restart attempts before marking as 'error'
}

/**
 * Represents the possible states of a managed background process.
 */
export type ProcessStatus =
	| "starting"
	| "running" // Stable state, optionally after verification
	| "stopping"
	| "stopped" // Clean exit
	| "crashed" // Unexpected exit, potentially restarting
	| "error" // Unrecoverable error during start or operation
	| "verifying" // Optional state after process starts, before confirming 'running'
	| "restarting"; // Actively attempting to restart after a crash
