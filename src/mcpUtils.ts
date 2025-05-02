import type { ZodRawShape } from "zod";
import type {
	CallToolResult,
	TextContent,
	ToolContent,
} from "./types/index.js"; // Update path

export const textPayload = (text: string): TextContent =>
	({ type: "text", text }) as const;

// Helper to create the payload structure
function createPayload(
	isError: boolean,
	...content: readonly (ToolContent | string)[]
): CallToolResult {
	let payloadContent: string;
	let contentType: "application/json" | "text/plain";
	let finalIsError = isError; // Use a local variable

	if (content.length === 0) {
		payloadContent = "";
		contentType = "text/plain";
	} else {
		const [firstContent] = content;
		if (typeof firstContent === "string") {
			payloadContent = firstContent;
			contentType = "text/plain";
		} else {
			try {
				payloadContent = JSON.stringify(firstContent);
				contentType = "application/json";
			} catch (error) {
				payloadContent = "Error: Could not serialize tool result content.";
				contentType = "text/plain";
				finalIsError = true; // Assign to the local variable
			}
		}
	}

	return {
		isError: finalIsError, // Return the local variable's value
		payload: [{ contentType, content: payloadContent }],
	};
}

export const ok = (...c: readonly ToolContent[]): CallToolResult =>
	createPayload(false, ...c);

export const fail = (...c: readonly ToolContent[]): CallToolResult =>
	createPayload(true, ...c);

export const shape = <T extends ZodRawShape>(x: T) => x;

export const safeSubstring = (v: unknown, len = 100): string =>
	typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
	status === "running" || status === "verifying";

// Update getResultText to access the correct structure
export const getResultText = (result: CallToolResult): string | null => {
	if (result.payload && result.payload.length > 0) {
		const firstPayload = result.payload[0];
		if (firstPayload?.content) {
			return firstPayload.content;
		}
	}
	return null;
};
