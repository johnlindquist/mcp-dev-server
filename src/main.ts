// src/main.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from './utils.js';
import { reapZombies, getZombieCheckIntervalId, setZombieCheckIntervalId, stopAllProcessesOnExit } from './state.js';
import { ZOMBIE_CHECK_INTERVAL, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { registerToolDefinitions } from './toolDefinitions.js';

// MCP Server Setup
const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
});

// --- Server Start and Cleanup ---

export async function main() {
    if (getZombieCheckIntervalId()) clearInterval(getZombieCheckIntervalId() as NodeJS.Timeout);
    setZombieCheckIntervalId(setInterval(reapZombies, ZOMBIE_CHECK_INTERVAL));
    log.info(null, `Started zombie process check interval (${ZOMBIE_CHECK_INTERVAL}ms).`);

    // Register tools
    registerToolDefinitions(server);

    // Connect transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info(null, "MCP Dev Server Manager Tool running on stdio");
}

export function cleanup(signal: string) {
    log.warn(null, `Received ${signal}. Shutting down...`);
    const intervalId = getZombieCheckIntervalId();
    if (intervalId) {
        clearInterval(intervalId);
        setZombieCheckIntervalId(null);
        log.info(null, "Stopped zombie check interval.");
    }

    stopAllProcessesOnExit(); // Use the extracted state function
    log.warn(null, "Attempted final termination for managed servers. Exiting.");
    process.exit(0);
}

// Setup Signal Handlers
export function setupSignalHandlers() {
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('exit', (code) => {
        log.info(null, `MCP Server process exiting with code ${code}.`);
        const intervalId = getZombieCheckIntervalId();
        if (intervalId) clearInterval(intervalId); // Clear interval on exit too
    });
} 