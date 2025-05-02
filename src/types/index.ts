import type { BlobResource, TextResource } from "./resource.js"; // Add .js extension

export interface TextContent {
	readonly type: "text";
	text: string;
	[key: string]: unknown;
}

export interface ImageContent {
	readonly type: "image";
	/** base-64 payload */
	data: string;
	mimeType: string;
	[key: string]: unknown;
}

export interface AudioContent {
	readonly type: "audio";
	/** base-64 payload */
	data: string;
	mimeType: string;
	[key: string]: unknown;
}

export interface ResourceContent {
	readonly type: "resource";
	resource: TextResource | BlobResource;
	[key: string]: unknown;
}

export type ToolContent =
	| TextContent
	| ImageContent
	| AudioContent
	| ResourceContent;

/** Result structure for tool calls, matching SDK expectation. */
export interface CallToolResult {
	isError?: boolean; // Optional as per SDK
	content: ToolContent[]; // Array of ToolContent objects
	[key: string]: unknown; // Add index signature
}
