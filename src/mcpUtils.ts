import type {
	AudioContent,
	CallToolResult,
	EmbeddedResource,
	ImageContent,
	TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

// Union type for tool content
export type ToolContent =
	| TextContent
	| ImageContent
	| AudioContent
	| EmbeddedResource;

export const textPayload = (text: string): TextContent =>
	({ type: "text", text }) as const;

// NEW ok() function
export const ok = (
	...contentItems: readonly (
		| TextContent
		| ImageContent
		| AudioContent
		| EmbeddedResource
	)[]
): CallToolResult => {
	return {
		content: [...contentItems],
		isError: false,
	};
};

// NEW fail() function
export const fail = (
	...contentItems: readonly (
		| TextContent
		| ImageContent
		| AudioContent
		| EmbeddedResource
	)[]
): CallToolResult => {
	return {
		content: [...contentItems],
		isError: true,
	};
};

export const shape = <T extends ZodRawShape>(x: T) => x;

export const safeSubstring = (v: unknown, len = 100): string =>
	typeof v === "string" ? v.substring(0, len) : "";

export const isRunning = (status: string) =>
	status === "running" || status === "verifying";

// UPDATED getResultText to read from the new structure
export const getResultText = (result: CallToolResult): string | null => {
	if (result.content && result.content.length > 0) {
		const firstTextContent = result.content.find(
			(item): item is TextContent => (item as TextContent).type === "text",
		);
		if (firstTextContent) {
			return firstTextContent.text;
		}
		return null;
	}
	return null;
};
