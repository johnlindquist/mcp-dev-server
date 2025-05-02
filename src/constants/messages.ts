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
	return `Now that the process has started, invoke a ${command} command in a background terminal named after the process label ('${label}') to monitor this process.`;
};

export const PROCESS_STARTED_MESSAGE = (label: string, status: string) =>
	`Process '${label}' started successfully. Current status: ${status}.`;

export const PROCESS_ALREADY_TERMINAL = (status: string) =>
	`Process already in terminal state: ${status}.`;

export const PROCESS_ALREADY_TERMINAL_NO_ACTION = (status: string) =>
	`Process already in terminal state: ${status}. No action needed.`;

export const PROCESS_NO_ACTIVE_HANDLE =
	"Process found but has no active process handle or PID.";

// Add more messages here as needed
