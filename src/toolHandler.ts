import {
	type CallToolResult,
	fail,
	getResultText,
	safeSubstring,
	textPayload,
} from "./types.js";
import { log, stripAnsiSafe } from "./utils.js";

export async function handleToolCall<T extends Record<string, unknown>>(
	label: string | null,
	toolName: string,
	params: T,
	handlerFn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
	log.info(label, `Tool invoked: ${toolName}`, { params });
	try {
		const result = await handlerFn();
		if (!result.isError) {
			const summary = safeSubstring(getResultText(result), 100);
			log.info(label, `Tool successful: ${toolName}`, {
				responseSummary: `${summary}...`,
			});
		} else {
			log.warn(label, `Tool returned error: ${toolName}`, {
				response: getResultText(result),
			});
		}
		return result;
	} catch (error: unknown) {
		const errorMessage = stripAnsiSafe(
			error instanceof Error ? error.message : String(error),
		);
		log.error(label, `Tool execution failed: ${toolName}`, {
			error: errorMessage,
		});
		return fail(
			textPayload(
				JSON.stringify(
					{ error: `Tool execution failed: ${errorMessage}` },
					null,
					2,
				),
			),
		);
	}
}
