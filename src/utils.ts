// src/utils.ts

import stripAnsi from "strip-ansi";
import { SERVER_NAME } from "./constants.js";

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
		// First remove specific control chars we don't want
		let cleanedInput = input.replace(CONTROL_CHAR_REGEX, "");
		// Then remove null bytes if any
		cleanedInput = cleanedInput.replace(NULL_BYTE_REGEX, "");
		// Finally, strip standard ANSI escape sequences
		return stripAnsi(cleanedInput);
	} catch (e: unknown) {
		log.error(
			null,
			`Error stripping ANSI/Control Chars: ${e instanceof Error ? e.message : String(e)}`,
			{ originalInput: `${input.substring(0, 100)}...` }, // Log snippet on error
		);
		// Fallback to original or partially cleaned
		return typeof input === "string"
			? input.replace(CONTROL_CHAR_REGEX, "").replace(NULL_BYTE_REGEX, "")
			: input;
	}
}

export function formatLogsForResponse(
	logs: string[],
	lineCount: number,
): string[] {
	const recentLogs = logs.slice(-lineCount);
	// Use the enhanced stripping function
	return recentLogs.map(stripAnsiAndControlChars);
}
