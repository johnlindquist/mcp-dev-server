import defaultShell from "default-shell";
import fkill from "fkill";
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

export async function killPtyProcess(
	ptyProcess: pty.IPty,
	label: string,
	signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<boolean> {
	if (ptyProcess.pid === undefined) {
		log.warn(label, "Attempted to kill PTY process, but PID is undefined.");
		return false; // Or handle as appropriate, maybe true if already dead?
	}
	try {
		await fkill(ptyProcess.pid, { tree: true, force: signal === "SIGKILL" });
		log.debug(label, `fkill sent (${signal}) to ${ptyProcess.pid}`);
		return true;
	} catch (err) {
		log.error(label, "fkill failed", err);
		return false;
	}
}
