import packageInfo from "../../package.json" with { type: "json" };

// --- FAST MODE --- Set MCP_PM_FAST=1 to use reduced timings
const FAST = process.env.MCP_PM_FAST === "1";
export function ms(normal: number, fast: number): number {
	return FAST ? fast : normal;
}
// -----------------

export const cfg = {
	/** Maximum number of log lines to store in memory per process. */
	maxStoredLogLines: 1000,

	/** Default number of log lines returned by check_shell and list_shelles if not specified. */
	defaultReturnLogLines: 50, // Used in lifecycle.ts

	/** Duration (ms) to wait for graceful process termination before forcing kill. */
	stopWaitDurationMs: ms(3000, 150), // Used in lifecycle.ts

	/** Interval (ms) for checking if a process has become a zombie (no longer responding). */
	zombieCheckIntervalMs: ms(15000, 0), // Disable in tests

	/** Internal server name identifier. */
	serverName: "mcp-pm",

	/** Server version, sourced from package.json. */
	serverVersion: packageInfo.version,

	/** Default maximum number of automatic restarts for a crashed process. */
	maxRetries: 3,

	/** Initial delay (ms) before the first restart attempt. */
	initialRetryDelayMs: ms(1000, 50),

	/** Factor by which the retry delay increases after each failed restart attempt. */
	backoffFactor: 2,

	/** Delay (ms) after process start before initiating verification checks. */
	startupVerificationDelayMs: ms(2000, 75), // Not currently used explicitly?

	/** Time window (ms) within which multiple crashes are considered a crash loop. */
	crashLoopDetectionWindowMs: ms(60000, 500),

	/** Default number of log lines requested by check_shell if log_lines is unspecified. */
	defaultCheckStatusLogLines: 20, // Used in toolImplementations.ts

	/** Timeout (ms) before assuming a verification pattern won't match. -1 disables the timer. */
	defaultVerificationTimeoutMs: -1, // Keep disabled for now

	/** Default delay (ms) before restarting a crashed process if retry_delay_ms is unspecified. */
	defaultRetryDelayMs: ms(1000, 50),

	// Constants for start_shell log settling (used in verify.ts)
	/** Duration (ms) of inactivity in logs required to consider the process startup settled. */
	logSettleDurationMs: ms(2000, 75),

	/** Maximum time (ms) to wait for log settling before considering startup complete or failed. */
	overallLogWaitTimeoutMs: ms(15000, 500),

	/** Duration (ms) to potentially wait during check_shell for active processes (if needed). */
	checkStatusWaitDurationMs: ms(2000, 50), // Not currently used explicitly?
} as const;

// Type helper for consumers
export type ConfigType = typeof cfg;
