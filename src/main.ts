import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cfg } from "./constants/index.js";
import { stopAllShellsOnExit } from "./process/retry.js";
import {
	clearZombieCheckInterval,
	setZombieCheckInterval,
} from "./processSupervisor.js";
import { registerToolDefinitions } from "./toolDefinitions.js";
import { log } from "./utils.js";

// [MCP-TEST-LOG STEP 1.1] Log server start with timestamp
const startTimestamp = new Date().toISOString();
log.error(
	null,
	`[MCP-TEST-LOG STEP 1.1] Server main.ts started at: ${startTimestamp}`,
);

// Add a global variable (or pass it down) to store the log directory path
export let serverLogDirectory: string | null = null; // Export for potential use elsewhere

async function main() {
	log.info(null, "MCP Process Manager Tool running...");
	log.info(null, `Version: ${cfg.serverVersion}`);

	// --- Create Log Directory ---
	try {
		// Create a unique directory based on PID within the OS temp dir
		const tempDir = os.tmpdir();
		log.info(null, `[Diag] os.tmpdir() returned: ${tempDir}`);
		const logDirName = `mcp-shell-yeah-logs-${process.pid}`;
		log.info(null, `[Diag] Log directory name component: ${logDirName}`);
		// Revert back to path.join as it was on main
		serverLogDirectory = path.join(tempDir, logDirName);
		log.info(null, `[Diag] path.join result: ${serverLogDirectory}`);

		if (!fs.existsSync(serverLogDirectory)) {
			fs.mkdirSync(serverLogDirectory, { recursive: true });
			log.info(null, `Created log directory: ${serverLogDirectory}`);
		} else {
			log.info(null, `Using existing log directory: ${serverLogDirectory}`);
			// Optional: Clean up old files here if desired on restart, but be careful
		}
	} catch (error) {
		log.error(null, "Failed to create log directory", (error as Error).message);
		// Decide if this is fatal? For now, we'll log and continue, file logging will fail later.
		serverLogDirectory = null;
	}
	// --- End Log Directory Creation ---

	const server = new McpServer({
		name: cfg.serverName,
		version: cfg.serverVersion,
		noAutoExit: true,
	});

	// Register tools
	registerToolDefinitions(server);

	// Start periodic zombie check
	if (cfg.zombieCheckIntervalMs > 0) {
		setZombieCheckInterval(cfg.zombieCheckIntervalMs);
	} else {
		log.warn(null, "Zombie process check is disabled (interval set to 0).");
	}

	// Start listening
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info(null, "MCP Server connected and listening via stdio.");

	// Graceful shutdown
	const cleanup = () => {
		log.info(null, "Initiating graceful shutdown...");
		clearZombieCheckInterval();
		stopAllShellsOnExit();
		log.info(null, "Cleanup complete. Exiting.");
		process.exit(0);
	};

	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGUSR2", cleanup);

	process.on("exit", () => log.info(null, "Process exiting..."));
}

main().catch((error) => {
	log.error(null, "Unhandled error in main function", (error as Error).message);
	process.exit(1);
});
