// src/utils.ts

// Import MAX_STORED_LOG_LINES if needed for formatLogsForResponse logic refinement
// import { MAX_STORED_LOG_LINES } from "./constants.js";
// import * as path from 'node:path'; // Remove unused import
// REMOVE: import { Signale } from "signale";
import stripAnsi from "strip-ansi";
import { cfg } from "./constants/index.js"; // Update path

// Set up Signale logger
// REMOVE: const isDev = process.env.NODE_ENV !== "production";
// REMOVE: const signale = new Signale({
// 	types: {
// 		info: { badge: "ℹ️", color: "blue", label: "info" },
// 		warn: { badge: "⚠️", color: "yellow", label: "warn" },
// 		error: { badge: "❌", color: "red", label: "error" },
// 		debug: { badge: "🐞", color: "magenta", label: "debug" },
// 	},
// });

// Minimal custom logger for ESM compatibility
export const log = {
	info: (label: string | null, message: string, data?: unknown) =>
		console.log(
			`[${cfg.serverName}${label ? ` ${label}` : ""}] INFO: ${message}`,
			data ?? "",
		),
	warn: (label: string | null, message: string, data?: unknown) =>
		console.warn(
			`[${cfg.serverName}${label ? ` ${label}` : ""}] WARN: ${message}`,
			data ?? "",
		),
	error: (label: string | null, message: string, error?: unknown) =>
		console.error(
			`[${cfg.serverName}${label ? ` ${label}` : ""}] ERROR: ${message}`,
			error ?? "",
		),
	debug: (label: string | null, message: string, data?: unknown) =>
		console.debug(
			`[${cfg.serverName}${label ? ` ${label}` : ""}] DEBUG: ${message}`,
			data ?? "",
		),
};

// Helper Functions
export function stripAnsiSafe(input: string): string {
	if (typeof input !== "string") return input;
	try {
		const cleanedInput = input.replace(/\\u0000/g, "");
		return stripAnsi(cleanedInput);
	} catch (e: unknown) {
		console.error(
			null,
			`Error stripping ANSI: ${e instanceof Error ? e.message : String(e)}`,
			{ originalInput: input },
		);
		return input;
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const CONTROL_CHAR_REGEX = /\r|\b|\u0007/g; // Add other chars if needed
// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
const NULL_BYTE_REGEX = /\u0000/g;

export function stripAnsiAndControlChars(input: string): string {
	if (typeof input !== "string") return input;
	try {
		// 1. Handle backspaces crudely: remove the character *before* the backspace.
		//    This should happen BEFORE strip-ansi, which might remove the x08 itself.
		//    Example: "abc\x08d" -> "abd"
		let cleanedInput = input.replace(BACKSPACE_REGEX, "");

		// 2. Remove null bytes which can cause issues.
		cleanedInput = cleanedInput.replace(NULL_BYTE_REGEX, "");

		// 3. Remove other specific problematic control characters (CR, Bell).
		//    Carriage return (\r) often just messes up line splitting without adding value here.
		cleanedInput = cleanedInput.replace(OTHER_CONTROL_CHARS_REGEX, "");

		// 4. Use strip-ansi for standard escape sequences (color, cursor movement, etc.).
		cleanedInput = stripAnsi(cleanedInput);

		// 5. Final pass to remove any remaining non-printable ASCII chars (optional, but can help)
		//    This targets characters in the 0-31 range excluding tab (x09), newline (x0A),
		//    and the ones we explicitly handled or want to keep.
		// cleanedInput = cleanedInput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Example, adjust as needed
		return cleanedInput;
	} catch (e: unknown) {
		console.error(
			null,
			`Error stripping ANSI/Control Chars: ${e instanceof Error ? e.message : String(e)}`,
			{ originalInput: `${input.substring(0, 100)}...` }, // Log snippet on error
		);
		// Fallback: try basic replacements if advanced failed
		try {
			let fallback = input.replace(BACKSPACE_REGEX, "");
			fallback = fallback.replace(NULL_BYTE_REGEX, "");
			fallback = fallback.replace(OTHER_CONTROL_CHARS_REGEX, "");
			// Maybe try stripAnsi again in fallback?
			// fallback = stripAnsi(fallback);
			return fallback; // Return partially cleaned string
		} catch {
			return input; // Give up if everything fails
		}
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Need to match backspace for cleanup
const BACKSPACE_REGEX = /.\x08/g; // Match any character followed by ASCII backspace (x08)
// Explicitly list troublesome control chars often not part of ANSI sequences handled by strip-ansi
// Includes carriage return (\r or x0D) and bell (\u0007 or x07)
// biome-ignore lint/suspicious/noControlCharactersInRegex: Need to match specific control chars
const OTHER_CONTROL_CHARS_REGEX = /[\r\x07]/g;

export function formatLogsForResponse(
	logs:
		| { content: string; source: "tool" | "shell" }[]
		| string[]
		| { toArray: () => any[] },
	lineCount: number,
	source?: "tool" | "shell",
): string[] {
	if (lineCount <= 0) {
		return []; // Return empty if 0 or negative lines requested
	}

	// --- Support LogRingBuffer ---
	if (logs && typeof (logs as any).toArray === "function") {
		logs = (logs as any).toArray();
	}

	let filteredLogs: string[];
	if (
		Array.isArray(logs) &&
		logs.length > 0 &&
		typeof logs[0] === "object" &&
		"source" in logs[0]
	) {
		// logs is LogEntry[]
		const entries = logs as { content: string; source: "tool" | "shell" }[];
		filteredLogs = source
			? entries.filter((l) => l.source === source).map((l) => l.content)
			: entries.map((l) => l.content);
	} else {
		// logs is string[]
		filteredLogs = logs as string[];
	}

	const recentRawLogs = filteredLogs.slice(-lineCount);

	const cleanedLogs = recentRawLogs
		.map(stripAnsiAndControlChars)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	return cleanedLogs;
}

/**
 * Sanitizes a process label to create a safe filename for log files.
 * Replaces characters commonly disallowed in filenames across different operating systems (e.g., /, \, :, *, ?, ", <, >, |) and spaces with underscores.
 * Multiple consecutive underscores are collapsed into one.
 * Ensures the filename is not empty and appends the `.log` extension.
 *
 * @param label The original process label.
 * @returns A sanitized string suitable for use as a filename, ending with `.log`.
 */
export function sanitizeLabelForFilename(label: string): string {
	// Basic replacements for common problematic characters
	let sanitized = label.replace(/[\\/:*?"<>| ]/g, "_");

	// Windows specific: Replace characters that could conflict with device names
	// Example: CON, PRN, AUX, NUL, COM1-9, LPT1-9
	if (process.platform === "win32") {
		sanitized = sanitized.replace(
			/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(_|$)/i,
			"reserved_$1$2",
		);
	}

	// Collapse multiple consecutive underscores
	sanitized = sanitized.replace(/_{2,}/g, "_");
	// Trim leading/trailing underscores
	sanitized = sanitized.replace(/^_+|_+$/g, "");

	// Handle empty or dot-only names after sanitization
	if (!sanitized || sanitized === "." || sanitized === "..") {
		return `process_${Date.now()}`; // Fallback name
	}
	return `${sanitized}.log`;
}

export function getTailCommand(logFilePath: string | null): string | null {
	if (!logFilePath) return null;
	// Windows uses PowerShell's Get-Content
	if (process.platform === "win32") {
		// Escape single quotes in the path for PowerShell
		const escapedPath = logFilePath.replace(/'/g, "''");
		// Use powershell.exe -Command to run the Get-Content command
		return `powershell.exe -Command Get-Content -Path '${escapedPath}' -Wait -Tail 10`;
	}
	// Unix-like systems use tail (no else needed due to return above)
	// Escape double quotes in the path for sh/bash
	const escapedPath = logFilePath.replace(/"/g, '\\"');
	return `tail -f -n 10 "${escapedPath}"`;
}
