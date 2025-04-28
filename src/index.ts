#!/usr/bin/env node

import { main, setupSignalHandlers } from "./main.js";
import { log } from "./utils.js"; // Import log first for potential early errors

// Set up signal handlers early
setupSignalHandlers();

// Run the main application logic
main().catch((error) => {
	log.error(null, "Fatal error during application startup:", error);
	process.exit(1);
});
