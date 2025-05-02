import type { ZodRawShape } from "zod";
import type {
	CallToolResult,
	TextContent,
	ToolContent,
} from "./types/index.js"; // Use local types

export const textPayload = (text: string): TextContent =>
	({ type: "text", text }) as const;

// Helper creates the payload structure matching the (now correct) local CallToolResult type
function createPayload(
	isError: boolean,
	...content: readonly (ToolContent | string)[]
): CallToolResult {
	const processedContent: ToolContent[] = content.map((item) => {
		if (typeof item === "string") {
			return textPayload(item);
		}
		return item;
	});

	return {
		isError: isError,
		content: processedContent,
	};
}

// Ensure ok/fail use the updated createPayload
export const ok = (...c: readonly (ToolContent | string)[]): CallToolResult =>
	createPayload(false, ...c);

export const fail = (...c: readonly (ToolContent | string)[]): CallToolResult =>
	createPayload(true, ...c);

export const shape = <T extends ZodRawShape>(x: T) => x;

export const safeSubstring = (v: unknown, len = 100): string =>
	typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
	status === "running" || status === "verifying";

// getResultText now works with the correctly typed CallToolResult
export const getResultText = (result: CallToolResult): string | null => {
	if (result.content && result.content.length > 0) {
		const firstContent = result.content[0];
		if (
			firstContent?.type === "text" &&
			typeof firstContent.text === "string"
		) {
			return firstContent.text;
		}
		try {
			return JSON.stringify(firstContent);
		} catch {}
	}
	return null;
};
