// Central location for user-facing and instructional message strings

export const CURSOR_TAIL_INSTRUCTION = (
	logFile: string,
	label: string,
	os: "mac" | "linux" | "windows",
) => {
	let command = `tail -f ${logFile}`;
	if (os === "windows") {
		command = `Get-Content ${logFile} -Wait`;
	}
	return `Now that the process has started, invoke a run_terminal_cmd ${command} command in a background terminal. This allows the user to monitor the process output in real time.`;
};

export const PROCESS_STARTED_MESSAGE = (label: string, status: string) =>
	`Process '${label}' started successfully. Current status: ${status}.`;

export const PROCESS_ALREADY_TERMINAL = (status: string) =>
	`Process already in terminal state: ${status}.`;

export const PROCESS_ALREADY_TERMINAL_NO_ACTION = (status: string) =>
	`Process already in terminal state: ${status}. No action needed.`;

export const PROCESS_NO_ACTIVE_HANDLE =
	"Process found but has no active process handle or PID.";

export const WORKING_DIRECTORY_NOT_FOUND = (cwd: string) =>
	`Working directory does not exist: ${cwd}`;

export const COMPOSITE_LABEL_CONFLICT = (
	label: string,
	cwd: string,
	command: string,
	status: string,
	pid: number | undefined,
) =>
	`An active process with the same label ('${label}'), working directory ('${cwd}'), and command ('${command}') already exists with status '${status}' (PID: ${pid}). Stop the existing process or use a different label.`;

export const TERMINATED_GRACEFULLY_AFTER_SIGTERM = (pid: number) =>
	`Process ${pid} terminated gracefully after SIGTERM.`;

export const DID_NOT_TERMINATE_GRACEFULLY_SIGKILL = (pid: number) =>
	`Process ${pid} did not terminate gracefully. SIGKILL sent.`;

export const NO_NOTABLE_EVENTS_MSG = "No notable events since last check.";

// Add more messages here as needed
