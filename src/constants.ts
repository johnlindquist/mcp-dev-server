// src/constants.ts

export const MAX_STORED_LOG_LINES = 200;
export const DEFAULT_RETURN_LOG_LINES = 50;
export const STOP_WAIT_DURATION = 3000;
export const ZOMBIE_CHECK_INTERVAL = 15000;
export const SERVER_NAME = "dev-server-manager";
export const SERVER_VERSION = "1.10.0"; // Incremented version for node-pty change

export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const BACKOFF_FACTOR = 2;
export const STARTUP_VERIFICATION_DELAY_MS = 2000;
export const CRASH_LOOP_DETECTION_WINDOW_MS = 60000;
