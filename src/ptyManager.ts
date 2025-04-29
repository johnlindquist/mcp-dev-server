import defaultShell from "default-shell";
import * as pty from "node-pty";
import { log } from "./utils.js";

export function spawnPtyProcess(
	_shell: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	label: string,
	cols = 80,
	rows = 30,
): pty.IPty {
	const shell = defaultShell || process.env.ComSpec || "cmd.exe";
	try {
		const ptyProcess = pty.spawn(shell, [], {
			name: "xterm-color",
			cols: cols,
			rows: rows,
			cwd: cwd,
			env: env,
			encoding: "utf8",
		});
		log.debug(label, `PTY process spawned with PID: ${ptyProcess.pid}`);
		return ptyProcess;
	} catch (error: unknown) {
		const errorMsg = `Failed to spawn PTY process: ${error instanceof Error ? error.message : String(error)}`;
		log.error(label, errorMsg);
		// Re-throw or handle appropriately – maybe return null or throw a custom error
		throw new Error(errorMsg); // Or return null and check in caller
	}
}

export function writeToPty(
	ptyProcess: pty.IPty,
	data: string,
	label: string,
): boolean {
	try {
		ptyProcess.write(data);
		log.debug(label, `Wrote to PTY: ${data.length} chars`);
		return true;
	} catch (error) {
		log.error(label, `Failed to write to PTY process ${ptyProcess.pid}`, error);
		return false;
	}
}

export function killPtyProcess(
	ptyProcess: pty.IPty,
	label: string,
	signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): boolean {
	try {
		log.info(
			label,
			`Sending ${signal} to PTY process PID ${ptyProcess.pid}...`,
		);
		ptyProcess.kill(signal);
		return true;
	} catch (error) {
		log.error(
			label,
			`Failed to send ${signal} to PTY process ${ptyProcess.pid}`,
			error,
		);
		return false;
	}
}
