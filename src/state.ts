// src/state.ts

import type { IPty } from 'node-pty';
import type { ServerInfo, ServerStatus } from './types.js';
import { log, stripAnsiSafe } from './utils.js';
import { MAX_STORED_LOG_LINES, MAX_RETRIES, INITIAL_RETRY_DELAY_MS, BACKOFF_FACTOR, CRASH_LOOP_DETECTION_WINDOW_MS, DEFAULT_RETURN_LOG_LINES } from './constants.js';
import { _startServer } from './serverLogic.js'; // Import _startServer

// State
export const runningServers: Map<string, ServerInfo> = new Map();
let _zombieCheckIntervalId: NodeJS.Timeout | null = null;

export function getZombieCheckIntervalId(): NodeJS.Timeout | null {
    return _zombieCheckIntervalId;
}

export function setZombieCheckIntervalId(id: NodeJS.Timeout | null): void {
    _zombieCheckIntervalId = id;
}

// State Management Functions

export function addLogEntry(label: string, source: 'pty' | 'system' | 'error' | 'warn', logLine: string): void {
    const serverInfo = runningServers.get(label);
    const trimmedLog = logLine.trim();
    if (!trimmedLog) return;

    const timestampedLog = `[${new Date().toISOString()}] [${source}] ${trimmedLog}`;

    if (serverInfo) {
        serverInfo.logs.push(timestampedLog);
        if (serverInfo.logs.length > MAX_STORED_LOG_LINES) {
            serverInfo.logs.shift();
        }
        if (source === 'system' || source === 'error' || source === 'warn') {
            const strippedMessage = stripAnsiSafe(trimmedLog);
            if (source === 'error') log.error(label, strippedMessage);
            else if (source === 'warn') log.warn(label, strippedMessage);
            else log.info(label, strippedMessage);
        }
    } else {
        log.warn(label, `Attempted to add log but server info missing: ${timestampedLog}`);
    }
}

export function updateServerStatus(label: string, status: ServerStatus, details: Partial<Pick<ServerInfo, 'exitCode' | 'error' | 'process'>> = {}): void {
    const serverInfo = runningServers.get(label);
    if (serverInfo) {
        const oldStatus = serverInfo.status;
        const strippedError = details.error ? stripAnsiSafe(details.error) : undefined;

        if (oldStatus !== status) {
            log.info(label, `Status changing from ${oldStatus} to ${status}`, details.exitCode !== undefined ? { exitCode: details.exitCode } : {});
            addLogEntry(label, 'system', `Status changed to ${status}${strippedError ? ` (Error: ${strippedError})` : details.exitCode !== null && details.exitCode !== undefined ? ` (Exit Code: ${details.exitCode})` : ''}`);
        }

        serverInfo.status = status;
        if (details.exitCode !== undefined) serverInfo.exitCode = details.exitCode;
        if (details.error !== undefined) serverInfo.error = strippedError ?? null;

        if (status === 'stopped' || status === 'crashed' || status === 'error') {
            serverInfo.process = null;
            serverInfo.pid = null;
        }

        if (status === 'running' && oldStatus !== 'running') {
            serverInfo.retryCount = 0;
            serverInfo.lastAttemptTime = null;
            addLogEntry(label, 'system', 'Server reached stable running state, retry count reset.');
        }

        if (status === 'crashed' && oldStatus !== 'crashed') {
            handleCrashAndRetry(label);
        }

    } else {
        log.warn(label, `Attempted to update status to ${status}, but server info not found.`);
    }
}

export function handleCrashAndRetry(label: string): void {
    const serverInfo = runningServers.get(label);
    if (!serverInfo || serverInfo.status !== 'crashed') {
        log.warn(label, `handleCrashAndRetry called but server not found or not in crashed state (${serverInfo?.status}).`);
        return;
    }

    const now = Date.now();
    let isRapidCrash = false;
    if (serverInfo.lastAttemptTime && (now - serverInfo.lastAttemptTime < CRASH_LOOP_DETECTION_WINDOW_MS)) {
        isRapidCrash = true;
        // Note: isRapidCrash is calculated but not currently used in the logic below.
        // Consider adding logic here if needed, e.g., increasing delay or stopping retries.
        log.debug(label, 'Rapid crash detected.', { lastAttemptTime: serverInfo.lastAttemptTime, now, window: CRASH_LOOP_DETECTION_WINDOW_MS });
    }

    if (serverInfo.retryCount < MAX_RETRIES) {
        serverInfo.retryCount++;
        const delay = INITIAL_RETRY_DELAY_MS * (BACKOFF_FACTOR ** (serverInfo.retryCount - 1));
        addLogEntry(label, 'warn', `Crash detected (attempt ${serverInfo.retryCount}/${MAX_RETRIES}). Retrying in ${delay}ms...`);
        updateServerStatus(label, 'restarting');
        serverInfo.lastAttemptTime = Date.now();

        setTimeout(async () => {
            const currentInfo = runningServers.get(label);
            if (currentInfo && currentInfo.status === 'restarting') {
                log.info(label, `Executing scheduled restart (attempt ${currentInfo.retryCount}).`);
                if (currentInfo.command && currentInfo.cwd) {
                    // TODO: Call _startServer - requires importing or passing it
                    // This will cause a runtime error until serverLogic.ts is created and imported
                    // log.error(label, "_startServer call is currently commented out in state.ts handleCrashAndRetry"); // Remove TODO comment
                    await _startServer(label, currentInfo.command, currentInfo.cwd, DEFAULT_RETURN_LOG_LINES); // Uncomment the call
                } else {
                    log.error(label, "Cannot execute scheduled restart: original command or cwd missing.");
                    updateServerStatus(label, 'error', { error: "Cannot restart: missing original command/cwd." });
                }
            } else {
                log.warn(label, `Scheduled restart for ${label} skipped, status is now ${currentInfo?.status ?? 'not found'}.`);
            }
        }, delay);
    } else {
        addLogEntry(label, 'error', `Crash detected, but retry limit (${MAX_RETRIES}) reached. Server will not be restarted automatically.`);
        updateServerStatus(label, 'error', { error: `Retry limit reached (${MAX_RETRIES}). Last error: ${serverInfo.error}` });
    }
}

export function handleExit(label: string, exitCode: number, signal?: number): void {
    const serverInfo = runningServers.get(label);
    if (!serverInfo) {
        log.error(label, 'handleExit called but server info not found.');
        return;
    }
    // Prevent duplicate processing if exit is handled close to a manual stop/crash update
    if (serverInfo.status === 'stopped' || serverInfo.status === 'crashed' || serverInfo.status === 'error') {
        log.info(label, `handleExit: Exit detected but status already terminal (${serverInfo.status}). Ignoring.`);
        return;
    }

    const exitReason = signal !== undefined ? `Signal ${signal}` : `Exit code ${exitCode}`; // Use signal number if present
    const logMsg = `Process exited (${exitReason})`;
    addLogEntry(label, 'system', logMsg);

    let finalStatus: ServerStatus;
    let errorMsg: string | null = serverInfo.error; // Preserve existing error if any

    if (serverInfo.status === 'stopping') {
        finalStatus = 'stopped';
        // Only log as warning if exit was non-zero and not due to standard termination signals
        if (exitCode !== 0 && signal !== 15 /* SIGTERM */ && signal !== 2 /* SIGINT */ && signal !== 9 /* SIGKILL */) {
            errorMsg = errorMsg || `Exited abnormally during stop (${exitReason})`;
            addLogEntry(label, 'warn', `Process exited non-gracefully during stopping phase (${exitReason}).`);
        }
    } else if (exitCode === 0 || signal === 15 /* SIGTERM */ || signal === 2 /* SIGINT */ || signal === 9 /* SIGKILL */) {
        // Consider clean exit if code is 0 or terminated by standard signals
        finalStatus = 'stopped';
    } else {
        finalStatus = 'crashed';
        errorMsg = errorMsg || `Process exited unexpectedly (${exitReason})`;
    }

    updateServerStatus(label, finalStatus, { exitCode: exitCode, error: errorMsg });
}

// Uses process.kill, which works for pty processes too
export function doesProcessExist(pid: number): boolean {
    try {
        // Signal 0 just checks existence without sending a signal
        process.kill(pid, 0);
        return true;
    } catch (e: unknown) {
        // Check for specific error codes indicating the process doesn't exist
        // or we lack permission (which implies it exists)
        if (typeof e === 'object' && e !== null) {
            const code = (e as { code?: string }).code;
            if (code === 'ESRCH') return false; // No such process
            if (code === 'EPERM') return true; // Operation not permitted, but process exists
        }
        // Rethrow unexpected errors
        // log.error(null, `Unexpected error in doesProcessExist for PID ${pid}`, e);
        return false; // Assume false on other errors
    }
}

export async function checkAndUpdateStatus(label: string): Promise<ServerInfo | null> {
    const serverInfo = runningServers.get(label);
    if (!serverInfo) return null;

    // Only check if process existence matters (i.e., expected to be running/starting/stopping)
    if (serverInfo.pid && (
        serverInfo.status === 'running' ||
        serverInfo.status === 'starting' ||
        serverInfo.status === 'stopping' || // Include stopping
        serverInfo.status === 'verifying' ||
        serverInfo.status === 'restarting'
    )) {
        if (!doesProcessExist(serverInfo.pid)) {
            const errorMsg = serverInfo.error || "Process termination detected externally.";
            log.warn(label, `Correcting status: Process PID ${serverInfo.pid} not found, but status was '${serverInfo.status}'.`);
            addLogEntry(label, 'system', `External termination detected (PID ${serverInfo.pid}).`);

            // If it was stopping, it's now stopped. Otherwise, crashed.
            const newStatus: ServerStatus = serverInfo.status === 'stopping' ? 'stopped' : 'crashed';
            updateServerStatus(label, newStatus, { error: errorMsg, exitCode: serverInfo.exitCode ?? null });
            return runningServers.get(label) ?? null; // Return updated info
        }
    }
    // Return current (potentially updated) info
    return serverInfo;
}

export function reapZombies(): void {
    log.debug(null, "Running zombie check...");
    for (const [label, serverInfo] of runningServers.entries()) {
        // Check potentially active states where a PID should exist
        if (serverInfo.pid && (
            serverInfo.status === 'running' ||
            serverInfo.status === 'starting' ||
            serverInfo.status === 'verifying' ||
            serverInfo.status === 'restarting' // Consider restarting state too
        )) {
            if (!doesProcessExist(serverInfo.pid)) {
                const errorMsg = "Process termination detected externally (zombie reaper).";
                log.warn(label, `Correcting status via zombie check: Process PID ${serverInfo.pid} not found, but status was '${serverInfo.status}'. Marking as crashed.`);
                addLogEntry(label, 'system', errorMsg);
                // Treat unexpected disappearance as a crash
                updateServerStatus(label, 'crashed', { error: errorMsg, exitCode: null });
            }
        }
    }
}

// Added function to handle cleanup
export function stopAllProcessesOnExit(): void {
    log.warn(null, "Stopping all managed dev servers on exit...");
    let killCount = 0;
    for (const [label, serverInfo] of runningServers.entries()) {
        if (serverInfo.process && serverInfo.pid && doesProcessExist(serverInfo.pid)) { // Check handle and existence
            try {
                log.warn(label, `Stopping PID ${serverInfo.pid} on exit with SIGKILL...`);
                serverInfo.process.kill('SIGKILL'); // Use node-pty kill, force kill on exit
                killCount++;
            } catch (e: unknown) {
                // Log error but continue
                log.error(label, `Error stopping PID ${serverInfo.pid} on exit: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    log.warn(null, `Attempted final termination for ${killCount} servers.`);
} 