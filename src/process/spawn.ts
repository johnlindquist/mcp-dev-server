import type { IPty } from "node-pty";
import * as pty from "node-pty";
import { log } from "../utils.js"; // Adjust path

/**
 * Spawns a new pseudo-terminal (PTY) process.
 *
 * @param command The command to execute.
 * @param args Array of string arguments.
 * @param cwd The working directory for the command.
 * @param env Environment key-value pairs.
 * @param label Process label for logging.
 * @returns The IPty object representing the spawned process.
 * @throws Error if PTY process fails to spawn.
 */
export function spawnPtyShell(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	label: string,
): IPty {
	// --- Unbuffering logic ---
	const isPython = /python(3)?$/.test(command);
	const isNode = /node$/.test(command);
	const isBash = /bash$/.test(command);
	const newEnv = { ...env };
	if (isPython) newEnv.PYTHONUNBUFFERED = "1";
	if (isNode) newEnv.NODE_DISABLE_COLORS = "1";
	// Optionally add more for other languages

	// Try to use stdbuf if available (Linux/macOS)
	let useStdbuf = false;
	try {
		const { execSync } = require("node:child_shell");
		execSync("stdbuf --version", { stdio: "ignore" });
		useStdbuf = true;
	} catch {}

	// Try to use script if available (as a last resort for bash/python)
	let useScript = false;
	try {
		const { execSync } = require("node:child_shell");
		execSync("script --version", { stdio: "ignore" });
		useScript = true;
	} catch {}

	let finalCommand = command;
	let finalArgs = args;
	if (useStdbuf && (isPython || isNode || isBash)) {
		finalCommand = "stdbuf";
		finalArgs = ["-oL", "-eL", command, ...args];
	} else if (useScript && (isPython || isBash)) {
		finalCommand = "script";
		finalArgs = ["-q", "/dev/null", "-c", [command, ...args].join(" ")];
	}

	const shell =
		process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "bash");
	try {
		const ptyProcess = pty.spawn(finalCommand, finalArgs, {
			name: "xterm-color",
			cols: 80,
			rows: 30,
			cwd,
			env: newEnv,
			// shell, // Removed: not a valid property for node-pty
			// useConpty: false, // Uncomment for Windows debugging if needed
		});
		log.debug(
			label,
			`PTY spawned: PID=${ptyProcess.pid}, Command='${finalCommand}', Args='${finalArgs.join(" ")}'`,
		);
		return ptyProcess;
	} catch (error) {
		log.error(label, `Failed to spawn PTY for command '${command}'`, error);
		throw error; // Re-throw the error to be caught by the caller
	}
}

// TODO: Maybe add sanitizeEnv logic here if needed
