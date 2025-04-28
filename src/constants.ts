// src/constants.ts
import packageInfo from "../package.json";

export const MAX_STORED_LOG_LINES = 1000;
export const DEFAULT_RETURN_LOG_LINES = 50;
export const STOP_WAIT_DURATION = 3000;
export const ZOMBIE_CHECK_INTERVAL = 15000;
export const SERVER_NAME = "mcp-pm";
export const SERVER_VERSION = packageInfo.version;

export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const BACKOFF_FACTOR = 2;
export const STARTUP_VERIFICATION_DELAY_MS = 2000;
export const CRASH_LOOP_DETECTION_WINDOW_MS = 60000;

export const DEFAULT_LOG_LINES = 50;
export const DEFAULT_RETRY_DELAY_MS = 500;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = -1; // -1 means no verification
export const ZOMBIE_CHECK_INTERVAL_MS = 60000; // 1 minute
