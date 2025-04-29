// src/constants.ts
import packageInfo from "../package.json" with { type: "json" };

/** Maximum number of log lines to store in memory per process. */
export const MAX_STORED_LOG_LINES = 1000;

/** Default number of log lines returned by check_process_status and list_processes if not specified. */
export const DEFAULT_RETURN_LOG_LINES = 50;

/** Duration (ms) to wait for graceful process termination before forcing kill. */
export const STOP_WAIT_DURATION = 3000;

/** Interval (ms) for checking if a process has become a zombie (no longer responding). */
export const ZOMBIE_CHECK_INTERVAL = 15000;

/** Internal server name identifier. */
export const SERVER_NAME = "mcp-pm";

/** Server version, sourced from package.json. */
export const SERVER_VERSION = packageInfo.version;

/** Default maximum number of automatic restarts for a crashed process. */
export const MAX_RETRIES = 3;

/** Initial delay (ms) before the first restart attempt. */
export const INITIAL_RETRY_DELAY_MS = 1000;

/** Factor by which the retry delay increases after each failed restart attempt. */
export const BACKOFF_FACTOR = 2;

/** Delay (ms) after process start before initiating verification checks. */
export const STARTUP_VERIFICATION_DELAY_MS = 2000;

/** Time window (ms) within which multiple crashes are considered a crash loop. */
export const CRASH_LOOP_DETECTION_WINDOW_MS = 60000;

/** Default number of log lines requested by check_process_status if log_lines is unspecified. */
export const DEFAULT_LOG_LINES = 20;

/** Timeout (ms) before assuming a verification pattern won't match. -1 disables the timer. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = -1;

/** Default delay (ms) before restarting a crashed process if retry_delay_ms is unspecified. */
export const DEFAULT_RETRY_DELAY_MS = 1000;

/** Interval (ms) for the zombie process check timer. */
export const ZOMBIE_CHECK_INTERVAL_MS = 60000; // 1 minute

// Constants for start_process log settling
/** Duration (ms) of inactivity in logs required to consider the process startup settled. */
export const LOG_SETTLE_DURATION_MS = 2000;

/** Maximum time (ms) to wait for log settling before considering startup complete or failed. */
export const OVERALL_LOG_WAIT_TIMEOUT_MS = 15000;
