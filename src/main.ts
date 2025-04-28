import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	SERVER_NAME,
	SERVER_VERSION,
	ZOMBIE_CHECK_INTERVAL_MS,
} from "./constants.js";
import {
	setZombieCheckInterval,
	stopAllProcessesOnExit,
	zombieCheckIntervalId,
} from "./state.js";
import { registerToolDefinitions } from "./toolDefinitions.js";
import { log } from "./utils.js";

async function main() {
	log.info(null, "MCP Process Manager Tool running...");
	log.info(null, `Version: ${SERVER_VERSION}`);

	const server = new McpServer({
		name: SERVER_NAME,
		version: SERVER_VERSION,
		noAutoExit: true,
	});

	// Register tools
	registerToolDefinitions(server);

	// Setup zombie process check interval
	setZombieCheckInterval(ZOMBIE_CHECK_INTERVAL_MS);

	// Start listening
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info(null, "MCP Server connected and listening via stdio.");

	// Graceful shutdown
	const cleanup = async (signal: string) => {
		log.info(null, `Received ${signal}. Shutting down...`);
		if (zombieCheckIntervalId) {
			clearInterval(zombieCheckIntervalId);
		}
		stopAllProcessesOnExit();
		log.info(null, "Attempted final termination for managed processes.");
		await server.close();
		log.info(null, "MCP Process Manager process exiting.");
		process.exit(0);
	};

	process.on("SIGINT", () => cleanup("SIGINT"));
	process.on("SIGTERM", () => cleanup("SIGTERM"));
	process.on("exit", () => log.info(null, "Process exiting..."));
}

main().catch((error) => {
	log.error(null, "Unhandled error in main function", error);
	process.exit(1);
});
