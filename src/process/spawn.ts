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
export function spawnPtyProcess(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	label: string,
): IPty {
	const shell =
		process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "bash");
	try {
		const ptyProcess = pty.spawn(command, args, {
			name: "xterm-color",
			cols: 80,
			rows: 30,
			cwd,
			env,
			// shell, // Removed: not a valid property for node-pty
			// useConpty: false, // Uncomment for Windows debugging if needed
		});
		log.debug(
			label,
			`PTY spawned: PID=${ptyProcess.pid}, Command='${command}'`,
		);
		return ptyProcess;
	} catch (error) {
		log.error(label, `Failed to spawn PTY for command '${command}'`, error);
		throw error; // Re-throw the error to be caught by the caller
	}
}

// TODO: Maybe add sanitizeEnv logic here if needed
