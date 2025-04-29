import type { ZodRawShape } from "zod";
import type { CallToolResult, TextContent, ToolContent } from "./types.js"; // Import necessary types

export const textPayload = (text: string): TextContent =>
	({ type: "text", text }) as const;

export const ok = (...c: readonly ToolContent[]): CallToolResult => ({
	content: [...c],
});

export const fail = (...c: readonly ToolContent[]): CallToolResult => ({
	isError: true,
	content: [...c],
});

export const shape = <T extends ZodRawShape>(x: T) => x;

export const safeSubstring = (v: unknown, len = 100): string =>
	typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
	status === "running" || status === "verifying";

export const getResultText = (result: CallToolResult): string | null => {
	for (const item of result.content) {
		if (item.type === "text") {
			return item.text;
		}
	}
	return null;
};
