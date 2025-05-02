import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, z } from "zod";
import { startProcess, stopProcess } from "./process/lifecycle.js";
import { handleToolCall } from "./toolHandler.js";
import {
	checkProcessStatusImpl,
	getAllLoglinesImpl,
	healthCheckImpl,
	listProcessesImpl,
	restartProcessImpl,
	sendInputImpl,
	stopAllProcessesImpl,
	waitForProcessImpl,
} from "./toolImplementations.js";
import type { ToolContent } from "./types/index.js";
import * as schemas from "./types/schemas.js";
import { log } from "./utils.js";

const shape = <T extends ZodRawShape>(shape: T): T => shape;

export type StartProcessParamsType = z.infer<typeof schemas.StartProcessParams>;
export type CheckProcessStatusParamsType = z.infer<
	typeof schemas.CheckProcessStatusParams
>;
export type StopProcessParamsType = z.infer<typeof schemas.StopProcessParams>;
export type ListProcessesParamsType = z.infer<
	typeof schemas.ListProcessesParams
>;
export type RestartProcessParamsType = z.infer<
	typeof schemas.RestartProcessParams
>;
export type WaitForProcessParamsType = z.infer<
	typeof schemas.WaitForProcessParams
>;
export type GetAllLoglinesParamsType = z.infer<
	typeof schemas.GetAllLoglinesParams
>;
export type SendInputParamsType = z.infer<typeof schemas.SendInputParams>;

function toMcpSdkResponse(result: Awaited<ReturnType<typeof handleToolCall>>): {
	content: ToolContent[];
	payload: { content: string }[];
	rawPayload: { content: string }[];
	isError?: boolean;
} {
	// Always serialize payload content to JSON string if not already a string
	const payloadArr = Array.isArray(result.payload)
		? result.payload.map((p) => {
				if (typeof p === "string") return { content: p };
				if (
					typeof p === "object" &&
					p !== null &&
					"content" in p &&
					typeof p.content === "string"
				) {
					return { content: p.content };
				}
				return { content: JSON.stringify(p) };
			})
		: result.payload
			? [
					{
						content:
							typeof result.payload === "string"
								? result.payload
								: JSON.stringify(result.payload),
					},
				]
			: [];

	return {
		content: payloadArr.map((p) => ({ type: "text", text: p.content })),
		payload: payloadArr,
		rawPayload: payloadArr,
		isError: result.isError,
	};
}

export function registerToolDefinitions(server: McpServer): void {
	server.tool(
		"start_process",
		"Starts a background process (like a dev server or script) and manages it.",
		shape(schemas.StartProcessParams.shape),
		(params: StartProcessParamsType) => {
			const cwdForLabel = params.workingDirectory;
			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;
			const hostValue = params.host;

			log.info(
				effectiveLabel,
				`Determined label for start_process: ${effectiveLabel}`,
			);

			return handleToolCall(
				effectiveLabel,
				"start_process",
				params,
				async () => {
					const verificationPattern = params.verification_pattern
						? new RegExp(params.verification_pattern)
						: undefined;

					return await startProcess(
						effectiveLabel,
						params.command,
						params.args,
						params.workingDirectory,
						hostValue,
						verificationPattern,
						params.verification_timeout_ms,
						params.retry_delay_ms,
						params.max_retries,
						false,
					);
				},
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"check_process_status",
		"Checks the status and retrieves recent logs of a managed background process.",
		shape(schemas.CheckProcessStatusParams.shape),
		(params: CheckProcessStatusParamsType) => {
			return handleToolCall(
				params.label,
				"check_process_status",
				params,
				async () => await checkProcessStatusImpl(params),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"stop_process",
		"Stops a specific background process.",
		shape(schemas.StopProcessParams.shape),
		(params: StopProcessParamsType) => {
			return handleToolCall(
				params.label,
				"stop_process",
				params,
				async () => await stopProcess(params.label, params.force),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"stop_all_processes",
		"Attempts to gracefully stop all active background processes.",
		{},
		(params: Record<string, unknown>) => {
			return handleToolCall(
				null,
				"stop_all_processes",
				{},
				async () => await stopAllProcessesImpl(),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"list_processes",
		"Lists all managed background processes and their statuses.",
		shape(schemas.ListProcessesParams.shape),
		(params: ListProcessesParamsType) => {
			return handleToolCall(
				null,
				"list_processes",
				params,
				async () => await listProcessesImpl(params),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"restart_process",
		"Restarts a specific background process by stopping and then starting it again.",
		shape(schemas.RestartProcessParams.shape),
		(params: RestartProcessParamsType) => {
			return handleToolCall(
				params.label,
				"restart_process",
				params,
				async () => await restartProcessImpl(params),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"wait_for_process",
		"Waits for a specific background process to reach a target status (e.g., running).",
		shape(schemas.WaitForProcessParams.shape),
		(params: WaitForProcessParamsType) => {
			return handleToolCall(
				params.label,
				"wait_for_process",
				params,
				async () => await waitForProcessImpl(params),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"get_all_loglines",
		"Retrieves the complete remaining log history for a specific managed process.",
		shape(schemas.GetAllLoglinesParams.shape),
		(params: GetAllLoglinesParamsType) => {
			return handleToolCall(
				params.label,
				"get_all_loglines",
				params,
				async () => await getAllLoglinesImpl(params),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"send_input",
		"Sends input to a specific managed process.",
		shape(schemas.SendInputParams.shape),
		(params: SendInputParamsType) => {
			return handleToolCall(
				params.label,
				"send_input",
				params,
				async () =>
					await sendInputImpl(
						params.label,
						params.input,
						params.append_newline,
					),
			).then(toMcpSdkResponse);
		},
	);

	server.tool(
		"health_check",
		"Provides a health status summary of the MCP Process Manager itself.",
		{},
		(params: Record<string, unknown>) => {
			return handleToolCall(
				null,
				"health_check",
				{},
				async () => await healthCheckImpl(),
			).then(toMcpSdkResponse);
		},
	);

	log.info(null, "Registered all MCP-PM tool definitions.");
}
