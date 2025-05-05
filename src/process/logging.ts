import * as fs from "node:fs";
import * as path from "node:path";
import { serverLogDirectory } from "../main.js"; // Adjust path
import { addLogEntry, managedShells } from "../state.js"; // Adjust path
import type { ShellInfo } from "../types/process.js"; // Adjust path
import { log, sanitizeLabelForFilename } from "../utils.js"; // Adjust path

/**
 * Sets up the log file stream for a given shell.
 * Updates the shellInfo object with the path and stream.
 *
 * @param shellInfo The shell information object (will be mutated).
 */
export function setupLogFileStream(shellInfo: ShellInfo): void {
	const { label } = shellInfo;

	if (!serverLogDirectory) {
		log.warn(
			label,
			"Log directory not configured, persistent file logging disabled.",
		);
		shellInfo.logFilePath = null;
		shellInfo.logFileStream = null;
		return;
	}

	try {
		const safeFilename = sanitizeLabelForFilename(label);
		const logFilePath = path.join(serverLogDirectory, safeFilename);
		log.info(label, `Setting up log file stream: ${logFilePath}`);

		const logFileStream = fs.createWriteStream(logFilePath, { flags: "a" });

		logFileStream.on("error", (err) => {
			log.warn(label, `Error writing to log file ${logFilePath}:`, err);
			const currentInfo = managedShells.get(label); // Get potentially updated info
			if (currentInfo) {
				currentInfo.logFileStream?.end(); // Attempt to close
				currentInfo.logFileStream = null; // Prevent further writes
				currentInfo.logFilePath = null; // Clear path as it's unusable
			}
		});

		logFileStream.on("open", () => {
			log.debug(label, `Log file stream opened: ${logFilePath}`);
			// Write initial marker AFTER stream is confirmed open
			addLogEntry(
				label,
				`--- Process Started (${new Date().toISOString()}) ---`,
			);
		});

		// Update shellInfo directly
		shellInfo.logFilePath = logFilePath;
		shellInfo.logFileStream = logFileStream;
		log.info(label, `Logging shell output to: ${logFilePath}`);
	} catch (error) {
		log.warn(label, "Failed to create or open log file stream", error);
		shellInfo.logFilePath = null; // Ensure path/stream are null if setup failed
		shellInfo.logFileStream = null;
	}
}
