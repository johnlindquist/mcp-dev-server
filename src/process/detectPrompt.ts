// Utility to detect if a process is waiting for user input based on log lines
// Supports OSC 133 shell integration and common prompt patterns

const OSC_133_B = `${String.fromCharCode(27)}]133;B${String.fromCharCode(7)}`; // \x1b]133;B\x07
const OSC_133_B_ALT = `${String.fromCharCode(27)}]133;B${String.fromCharCode(27)}\\`; // \x1b]133;B\x1b\\

export function detectPromptInLogs(logs: string[]): {
	isWaiting: boolean;
	matchedLine?: string;
} {
	// Common shell prompt patterns: $ , # , > , ? at end of line, or question/input/password prompts
	const promptRegex =
		/(?:\n|^)[^\n]*[#$>\?] $|(?:\binput\b|\bpassword\b|\bpassphrase\b|\benter\b|\bplease\b).*[:?]\s*$/i;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (logs[i].includes(OSC_133_B) || logs[i].includes(OSC_133_B_ALT)) {
			return { isWaiting: true, matchedLine: logs[i] };
		}
		if (promptRegex.test(logs[i]))
			return { isWaiting: true, matchedLine: logs[i] };
	}
	return { isWaiting: false };
}
