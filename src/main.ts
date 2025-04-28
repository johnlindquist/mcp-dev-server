import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// Add a global variable (or pass it down) to store the log directory path
export let serverLogDirectory: string | null = null; // Export for potential use elsewhere

async function main() {
	log.info(null, "MCP Process Manager Tool running...");
	log.info(null, `Version: ${SERVER_VERSION}`);

	// --- Create Log Directory ---
	try {
		// Create a unique directory based on PID within the OS temp dir
		const tempDir = os.tmpdir();
		const logDirName = `mcp-pm-logs-${process.pid}`;
		serverLogDirectory = path.join(tempDir, logDirName);

		if (!fs.existsSync(serverLogDirectory)) {
			fs.mkdirSync(serverLogDirectory, { recursive: true });
			log.info(null, `Created log directory: ${serverLogDirectory}`);
		} else {
			log.info(null, `Using existing log directory: ${serverLogDirectory}`);
			// Optional: Clean up old files here if desired on restart, but be careful
		}
	} catch (error) {
		log.error(null, "Failed to create log directory", error);
		// Decide if this is fatal? For now, we'll log and continue, file logging will fail later.
		serverLogDirectory = null;
	}
	// --- End Log Directory Creation ---

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
		stopAllProcessesOnExit(); // This should now also close log streams
		log.info(null, "Attempted final termination for managed processes.");
		// Optional: Clean up the log directory itself?
		// if (serverLogDirectory && fs.existsSync(serverLogDirectory)) {
		//     log.info(null, `Removing log directory: ${serverLogDirectory}`);
		//     fs.rmSync(serverLogDirectory, { recursive: true, force: true });
		// }
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
