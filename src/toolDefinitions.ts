import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, z } from "zod";
import {
	startShell,
	startShellWithVerification,
	stopProcess,
} from "./process/lifecycle.js";
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
import * as schemas from "./types/schemas.js";
import { log } from "./utils.js";
// If needed, import SDK types for tool content/results:
// import type { CallToolResult, TextContent, ImageContent, AudioContent, EmbeddedResource } from "@modelcontextprotocol/sdk/types.js";

const shape = <T extends ZodRawShape>(shape: T): T => shape;

export type StartProcessParamsType = z.infer<typeof schemas.StartShellParams>;
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

export function registerToolDefinitions(server: McpServer): void {
	server.tool(
		"start_shell",
		"Starts a shell (e.g. dev server, test runner) in a managed environment. If any URLs are found in logs, extract and return them as markdown links for the user.",
		shape(schemas.StartShellParams.shape),
		(params: StartProcessParamsType) => {
			const cwdForLabel = params.workingDirectory;
			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;
			const hostValue = params.host;

			log.info(
				effectiveLabel,
				`Determined label for start_shell: ${effectiveLabel}`,
			);

			return handleToolCall(effectiveLabel, "start_shell", params, async () => {
				return await startShell(
					effectiveLabel,
					params.command,
					params.args,
					params.workingDirectory,
					hostValue,
					false,
				);
			});
		},
	);

	server.tool(
		"start_shell_with_verification",
		"Starts a shell with verification (pattern, timeout, retries). Useful for dev servers, tests, or scripts that print a specific line when ready. Returns monitoring commands and all shell output for inspection.",
		shape(schemas.StartShellWithVerificationParams.shape),
		(params: schemas.StartProcessWithVerificationParamsType) => {
			const cwdForLabel = params.workingDirectory;
			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;
			const hostValue = params.host;

			log.info(
				effectiveLabel,
				`Determined label for start_shell_with_verification: ${effectiveLabel}`,
			);

			return handleToolCall(
				effectiveLabel,
				"start_shell_with_verification",
				params,
				async () => {
					const verificationPattern = params.verification_pattern
						? new RegExp(params.verification_pattern)
						: undefined;
					return await startShellWithVerification(
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
			);
		},
	);

	server.tool(
		"check_shell",
		"Checks the status and recent logs of a managed shell. If any URLs are found in logs, extract and return them as markdown links for the user.",
		shape(schemas.CheckProcessStatusParams.shape),
		(params: CheckProcessStatusParamsType) => {
			return handleToolCall(
				params.label,
				"check_shell",
				params,
				async () => await checkProcessStatusImpl(params),
			);
		},
	);

	server.tool(
		"stop_shell",
		"Stops a specific managed shell. Can forcefully terminate or gracefully stop the shell.",
		shape(schemas.StopProcessParams.shape),
		(params: StopProcessParamsType) => {
			return handleToolCall(
				params.label,
				"stop_shell",
				params,
				async () => await stopProcess(params.label, params.force),
			);
		},
	);

	server.tool(
		"stop_all_shelles",
		"Attempts to gracefully stop all active managed shells.",
		{},
		(params: Record<string, unknown>) => {
			return handleToolCall(
				null,
				"stop_all_shelles",
				{},
				async () => await stopAllProcessesImpl(),
			);
		},
	);

	server.tool(
		"list_shelles",
		"Lists all managed shells and their statuses, including recent output lines for each shell.",
		shape(schemas.ListProcessesParams.shape),
		(params: ListProcessesParamsType) => {
			return handleToolCall(
				null,
				"list_shelles",
				params,
				async () => await listProcessesImpl(params),
			);
		},
	);

	server.tool(
		"restart_shell",
		"Restarts a specific managed shell by stopping and then starting it again. Useful for refreshing dev servers or test shells.",
		shape(schemas.RestartProcessParams.shape),
		(params: RestartProcessParamsType) => {
			return handleToolCall(
				params.label,
				"restart_shell",
				params,
				async () => await restartProcessImpl(params),
			);
		},
	);

	server.tool(
		"wait_for_shell",
		"Waits for a specific managed shell to reach a target status (e.g., running). Use this to synchronize with shell readiness.",
		shape(schemas.WaitForProcessParams.shape),
		(params: WaitForProcessParamsType) => {
			return handleToolCall(
				params.label,
				"wait_for_shell",
				params,
				async () => await waitForProcessImpl(params),
			);
		},
	);

	server.tool(
		"get_all_loglines",
		"Retrieves the complete log/output history for a specific managed shell. Useful for debugging or reviewing all shell output.",
		shape(schemas.GetAllLoglinesParams.shape),
		(params: GetAllLoglinesParamsType) => {
			return handleToolCall(
				params.label,
				"get_all_loglines",
				params,
				async () => await getAllLoglinesImpl(params),
			);
		},
	);

	server.tool(
		"send_input",
		"Sends input to a specific managed shell, simulating user interaction (e.g., responding to prompts in the shell).",
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
			);
		},
	);

	server.tool(
		"health_check",
		"Provides a health status summary of the MCP Shell Manager itself.",
		{},
		(params: Record<string, unknown>) => {
			return handleToolCall(
				null,
				"health_check",
				{},
				async () => await healthCheckImpl(),
			);
		},
	);

	log.info(null, "Registered all MCP-PM tool definitions.");
}
