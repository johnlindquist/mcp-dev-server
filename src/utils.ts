// src/utils.ts

import stripAnsi from "strip-ansi";
import { SERVER_NAME } from "./constants.js";
// Import MAX_STORED_LOG_LINES if needed for formatLogsForResponse logic refinement
// import { MAX_STORED_LOG_LINES } from "./constants.js";

// Logging
export const log = {
	info: (label: string | null, message: string, data?: unknown) =>
		console.error(
			`[${SERVER_NAME}${label ? ` ${label}` : ""}] INFO: ${message}`,
			data ?? "",
		),
	warn: (label: string | null, message: string, data?: unknown) =>
		console.error(
			`[${SERVER_NAME}${label ? ` ${label}` : ""}] WARN: ${message}`,
			data ?? "",
		),
	error: (label: string | null, message: string, error?: unknown) =>
		console.error(
			`[${SERVER_NAME}${label ? ` ${label}` : ""}] ERROR: ${message}`,
			error ?? "",
		),
	debug: (label: string | null, message: string, data?: unknown) => {
		console.error(
			`[${SERVER_NAME}${label ? ` ${label}` : ""}] DEBUG: ${message}`,
			data ?? "",
		);
	},
};

// Helper Functions
export function stripAnsiSafe(input: string): string {
	if (typeof input !== "string") return input;
	try {
		const cleanedInput = input.replace(/\\u0000/g, "");
		return stripAnsi(cleanedInput);
	} catch (e: unknown) {
		log.error(
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
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Targeting non-printable range
		// cleanedInput = cleanedInput.replace(/[x00-x08x0Bx0Cx0E-x1Fx7F]/g, ''); // Example, adjust as needed

		return cleanedInput;
	} catch (e: unknown) {
		log.error(
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
const BACKSPACE_REGEX = /.x08/g; // Match any character followed by ASCII backspace (x08)
// Explicitly list troublesome control chars often not part of ANSI sequences handled by strip-ansi
// Includes carriage return (\r or x0D) and bell (\u0007 or x07)
// biome-ignore lint/suspicious/noControlCharactersInRegex: Need to match specific control chars
const OTHER_CONTROL_CHARS_REGEX = /[\rx07]/g;

export function formatLogsForResponse(
	logs: string[],
	lineCount: number,
): string[] {
	if (lineCount <= 0) {
		return []; // Return empty if 0 or negative lines requested
	}

	// Get the requested number of most recent raw log lines
	const recentRawLogs = logs.slice(-lineCount);

	// Process logs: strip, trim, filter
	const cleanedLogs = recentRawLogs
		.map(stripAnsiAndControlChars) // Apply the enhanced stripping function
		.map((line) => line.trim()) // Trim leading/trailing whitespace from each line
		.filter((line) => line.length > 0); // Remove lines that are now empty after stripping/trimming

	return cleanedLogs;
}
