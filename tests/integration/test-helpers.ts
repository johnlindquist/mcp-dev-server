import path from "node:path";

export const SERVER_EXECUTABLE = "node";
export const SERVER_SCRIPT_PATH = path.resolve(
	__dirname,
	"../../build/index.mjs",
);
export const SERVER_ARGS: string[] = [];
export const SERVER_READY_OUTPUT =
	"MCP Server connected and listening via stdio.";
export const STARTUP_TIMEOUT = 20000;
export const TEST_TIMEOUT = STARTUP_TIMEOUT + 10000;

export const IS_VERBOSE = process.env.MCP_TEST_VERBOSE === "1";
export function logVerbose(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.log("[VERBOSE]", ...args);
	}
}
export function logVerboseError(...args: unknown[]) {
	if (IS_VERBOSE) {
		console.error("[VERBOSE_ERR]", ...args);
	}
}

export type MCPResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

export type CallToolResult = {
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content: Array<{ type: "text"; text: string }>;
};

export type ProcessStatusResult = {
	label: string;
	status: "running" | "stopped" | "starting" | "error" | "crashed";
	pid?: number;
	command?: string;
	args?: string[];
	cwd?: string;
	exitCode?: number | null;
	signal?: string | null;
	logs?: string[];
	log_hint?: string;
	message?: string;
};
