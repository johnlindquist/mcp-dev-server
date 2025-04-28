#!/usr/bin/env node
// src/devserver.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // Removed CallToolResult type import
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs'; // Import fs module
import stripAnsi from 'strip-ansi'; // Import the library
import path from 'node:path';
// Use type import for CallToolResult, add .js extension
import { type CallToolResult, textPayload, ok, fail, shape, safeSubstring, getResultText } from "./types.js";

// --- Constants ---
const MAX_STORED_LOG_LINES = 200;
const DEFAULT_RETURN_LOG_LINES = 50;
const STOP_WAIT_DURATION = 3000;
const ZOMBIE_CHECK_INTERVAL = 15000;
const SERVER_NAME = "dev-server-manager";
const SERVER_VERSION = "1.9.0"; // Incremented version for robust async handling

// --- Interfaces and Types ---
// Updated Statuses: Added Verifying, Restarting, Crashed. Error used for fatal/unrecoverable.
type ServerStatus = 'starting' | 'verifying' | 'running' | 'stopping' | 'stopped' | 'restarting' | 'crashed' | 'error';

interface ServerInfo {
  label: string;
  process: ChildProcess | null;
  command: string;
  cwd: string; // Keep as string, represents the resolved path
  startTime: Date;
  status: ServerStatus;
  pid: number | null;
  logs: string[]; // Stores raw, timestamped log lines
  exitCode: number | null;
  error: string | null; // Stores stripped error message
  // Retry logic state
  retryCount: number;
  lastAttemptTime: number | null;
  workspacePath: string; // Ensure this is assigned
}

// --- State Management ---
const runningServers: Map<string, ServerInfo> = new Map();
let zombieCheckIntervalId: NodeJS.Timeout | null = null;

// --- Configuration ---
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const BACKOFF_FACTOR = 2;
const STARTUP_VERIFICATION_DELAY_MS = 2000; // Time to wait before assuming 'running' after spawn
const CRASH_LOOP_DETECTION_WINDOW_MS = 60000; // Detect rapid crashes within this window

// --- Logging ---
// Centralized logger using console.error (stderr) to avoid interfering with MCP stdio transport
const log = {
  info: (label: string | null, message: string, data?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] INFO: ${message}`, data ?? ''),
  warn: (label: string | null, message: string, data?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] WARN: ${message}`, data ?? ''),
  error: (label: string | null, message: string, error?: unknown) => console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] ERROR: ${message}`, error ?? ''),
  debug: (label: string | null, message: string, data?: unknown) => {
    // Optional: Add an env variable check for debug logging if needed
    // if (process.env.MCP_DEBUG) {
    console.error(`[${SERVER_NAME}${label ? ` ${label}` : ''}] DEBUG: ${message}`, data ?? '');
    // }
  }
};

// --- Helper Functions ---

function stripAnsiSafe(input: string): string {
  if (typeof input !== 'string') return input;
  try {
    const cleanedInput = input.replace(/\\u0000/g, ''); // Use double backslash for regex escape
    return stripAnsi(cleanedInput);
  } catch (e: unknown) {
    log.error(null, `Error stripping ANSI: ${e instanceof Error ? e.message : String(e)}`, { originalInput: input });
    return input; // Return original on error
  }
}

function addLogEntry(label: string, source: 'stdout' | 'stderr' | 'system' | 'error' | 'warn', logLine: string): void {
  const serverInfo = runningServers.get(label);
  const trimmedLog = logLine.trim();
  if (!trimmedLog) return;

  const timestampedLog = `[${new Date().toISOString()}] [${source}] ${trimmedLog}`;

  if (serverInfo) {
    serverInfo.logs.push(timestampedLog); // Store raw log with timestamp and source
    if (serverInfo.logs.length > MAX_STORED_LOG_LINES) {
      serverInfo.logs.shift();
    }
    // Log significant events (stripped) to MCP server's console
    if (source === 'system' || source === 'error' || source === 'warn') {
      const strippedMessage = stripAnsiSafe(trimmedLog);
      // Use appropriate log level based on source
      if (source === 'error') log.error(label, strippedMessage);
      else if (source === 'warn') log.warn(label, strippedMessage);
      else log.info(label, strippedMessage); // system logs as info
    }
  } else {
    // Log even if serverInfo is gone, might be relevant
    log.warn(label, `Attempted to add log but server info missing: ${timestampedLog}`);
  }
}


function updateServerStatus(label: string, status: ServerStatus, details: Partial<Pick<ServerInfo, 'exitCode' | 'error' | 'process'>> = {}): void {
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
    if (details.error !== undefined) serverInfo.error = strippedError ?? null; // Store stripped error

    // Clear process handle when definitively stopped, crashed or errored
    if (status === 'stopped' || status === 'crashed' || status === 'error') {
      serverInfo.process = null;
      serverInfo.pid = null; // Also clear PID when process is gone
    }

    // Reset retry count if it reaches a stable running state
    if (status === 'running' && oldStatus !== 'running') {
      serverInfo.retryCount = 0;
      serverInfo.lastAttemptTime = null; // Reset last attempt time
      addLogEntry(label, 'system', 'Server reached stable running state, retry count reset.');
    }

    // --- Trigger Retry Logic on Crash --- (Moved from handleExit)
    if (status === 'crashed' && oldStatus !== 'crashed') {
      handleCrashAndRetry(label);
    }

  } else {
    log.warn(label, `Attempted to update status to ${status}, but server info not found.`);
  }
}

// Centralized function to handle crash state and initiate retry
function handleCrashAndRetry(label: string): void {
  const serverInfo = runningServers.get(label);
  if (!serverInfo || serverInfo.status !== 'crashed') {
    log.warn(label, `handleCrashAndRetry called but server not found or not in crashed state (${serverInfo?.status}).`);
    return;
  }

  // Check for rapid crash loop
  const now = Date.now();
  let isRapidCrash = false;
  if (serverInfo.lastAttemptTime && (now - serverInfo.lastAttemptTime < CRASH_LOOP_DETECTION_WINDOW_MS)) {
    isRapidCrash = true; // Crashed shortly after the last attempt/start
  }

  if (serverInfo.retryCount < MAX_RETRIES) {
    serverInfo.retryCount++;
    const delay = INITIAL_RETRY_DELAY_MS * (BACKOFF_FACTOR ** (serverInfo.retryCount - 1));
    addLogEntry(label, 'warn', `Crash detected (attempt ${serverInfo.retryCount}/${MAX_RETRIES}). Retrying in ${delay}ms...`);
    updateServerStatus(label, 'restarting');
    serverInfo.lastAttemptTime = Date.now(); // Record time before scheduling next attempt

    setTimeout(async () => {
      const currentInfo = runningServers.get(label);
      // Only proceed if it's still in restarting state (hasn't been manually stopped/started)
      if (currentInfo && currentInfo.status === 'restarting') {
        log.info(label, `Executing scheduled restart (attempt ${currentInfo.retryCount}).`);
        // Use _startServer directly, logLines might not be available easily, use default
        // Need original command/cwd - they are in serverInfo
        if (currentInfo.command && currentInfo.cwd) {
          await _startServer(label, currentInfo.command, currentInfo.cwd, DEFAULT_RETURN_LOG_LINES);
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

// Simplified handleExit: mainly logs and sets the terminal state (stopped or crashed)
// The retry logic is now triggered by updateServerStatus when state becomes 'crashed'.
function handleExit(label: string, code: number | null, signal: NodeJS.Signals | null): void {
  const serverInfo = runningServers.get(label);
  if (!serverInfo) {
    log.error(label, 'handleExit called but server info not found.');
    return;
  }
  // Avoid double handling if already stopped/crashed/error
  if (serverInfo.status === 'stopped' || serverInfo.status === 'crashed' || serverInfo.status === 'error') {
    log.info(label, `handleExit: Exit detected but status already terminal (${serverInfo.status}). Ignoring.`);
    return;
  }

  const exitReason = signal ? `Signal ${signal}` : `Exit code ${code}`;
  const logMsg = `Process exited (${exitReason})`;
  addLogEntry(label, 'system', logMsg);

  // Determine if it was a clean stop or a crash
  // Treat unexpected exits (non-zero code, unexpected signals) while not stopping as crashes.
  // Treat expected exits (code 0, SIGTERM/SIGINT) or any exit during 'stopping' phase as 'stopped'.
  let finalStatus: ServerStatus;
  let errorMsg: string | null = serverInfo.error; // Preserve existing error if any

  if (serverInfo.status === 'stopping') {
    finalStatus = 'stopped'; // Assume intended stop if in stopping phase
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      errorMsg = errorMsg || `Exited abnormally during stop (${exitReason})`;
      addLogEntry(label, 'warn', `Process exited non-gracefully during stopping phase (${exitReason}).`);
    }
  } else if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
    finalStatus = 'stopped'; // Clean exit
  } else {
    finalStatus = 'crashed'; // Assume crash for any other exit
    errorMsg = errorMsg || `Process exited unexpectedly (${exitReason})`;
  }

  updateServerStatus(label, finalStatus, { exitCode: code, error: errorMsg });
  // Note: If finalStatus is 'crashed', updateServerStatus will trigger handleCrashAndRetry.
}

function doesProcessExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // Type check error code
    return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'EPERM';
  }
}

// Gets the last N lines and strips ANSI codes
function formatLogsForResponse(logs: string[], lineCount: number): string[] {
  const recentLogs = logs.slice(-lineCount);
  return recentLogs.map(stripAnsiSafe);
}

async function checkAndUpdateStatus(label: string): Promise<ServerInfo | null> {
  const serverInfo = runningServers.get(label);
  if (!serverInfo) return null;

  // Check process liveness only if it's supposed to be running/starting/stopping/verifying
  if (serverInfo.pid && (
    serverInfo.status === 'running' ||
    serverInfo.status === 'starting' ||
    serverInfo.status === 'stopping' ||
    serverInfo.status === 'verifying' ||
    serverInfo.status === 'restarting' // Check even if restarting, pid might exist transiently
  )) {
    if (!doesProcessExist(serverInfo.pid)) {
      const errorMsg = serverInfo.error || "Process termination detected externally.";
      log.warn(label, `Correcting status: Process PID ${serverInfo.pid} not found, but status was '${serverInfo.status}'.`);
      addLogEntry(label, 'system', `External termination detected (PID ${serverInfo.pid}).`);

      // If it was stopping, transition to stopped.
      // Otherwise, it's an unexpected termination -> crashed.
      const newStatus: ServerStatus = serverInfo.status === 'stopping' ? 'stopped' : 'crashed';
      // Update status to trigger potential retry logic if crashed
      updateServerStatus(label, newStatus, { error: errorMsg, exitCode: serverInfo.exitCode ?? null }); // Use existing exit code if known
      return runningServers.get(label) ?? null; // Return the updated info, ensuring null if undefined
    }
  }
  // No change needed or process not expected to exist
  return serverInfo; // Return the current info
}

function reapZombies(): void {
  log.debug(null, "Running zombie check...");
  for (const [label, serverInfo] of runningServers.entries()) {
    if (serverInfo.pid && (
      serverInfo.status === 'running' ||
      serverInfo.status === 'starting' ||
      serverInfo.status === 'verifying'
      // Don't reap if stopping or restarting, might just be slow
    )) {
      if (!doesProcessExist(serverInfo.pid)) {
        const errorMsg = "Process termination detected externally (zombie reaper).";
        log.warn(label, `Correcting status via zombie check: Process PID ${serverInfo.pid} not found, but status was '${serverInfo.status}'.`);
        addLogEntry(label, 'system', errorMsg);
        // Transition to crashed to trigger retry logic
        updateServerStatus(label, 'crashed', { error: errorMsg, exitCode: null });
      }
    }
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// --- Tool Definitions ---

// Helper to log tool calls and responses safely
async function handleToolCall<T extends Record<string, unknown>>(
  label: string | null, // Use null if label isn't applicable (like list_servers)
  toolName: string,
  params: T,
  handlerFn: () => Promise<CallToolResult> // Expect handler to return Promise<CallToolResult>
): Promise<CallToolResult> { // Return Promise<CallToolResult>
  log.info(label, `Tool invoked: ${toolName}`, { params });
  try {
    const result = await handlerFn(); // Result is now CallToolResult
    // Log success only if not an error response
    if (!result.isError) {
      // Use safeSubstring from types.ts
      const summary = safeSubstring(getResultText(result), 100);
      log.info(label, `Tool successful: ${toolName}`, { responseSummary: `${summary}...` });
    } else {
      log.warn(label, `Tool returned error: ${toolName}`, { response: getResultText(result) });
    }
    return result;
  } catch (error: unknown) { // Use unknown for catch clause variable
    // Type check error message
    const errorMessage = stripAnsiSafe(error instanceof Error ? error.message : String(error));
    log.error(label, `Tool execution failed: ${toolName}`, { error: errorMessage });
    // Ensure the error returned to MCP is also stripped
    // Return a valid CallToolResult error structure using helpers
    return fail(textPayload(JSON.stringify({ error: `Tool execution failed: ${errorMessage}` }, null, 2)));
  }
}

// --- Internal Core Logic Functions ---

// Internal function to handle the core logic of starting a server
// Separated to be reusable by start_dev_server and restart_dev_server tools
async function _startServer(
  label: string,
  command: string,
  cwdInput: string | undefined, // Allow undefined here
  logLines: number
): Promise<CallToolResult> { // Return type matches tool response structure

  // Determine the effective CWD
  const effectiveCwd = cwdInput
    ? path.resolve(cwdInput) // Resolve relative to current working dir or use absolute
    : process.env.MCP_WORKSPACE_ROOT || process.cwd(); // Default to workspace root or process CWD

  log.info(label, `Starting server process... Command: "${command}", CWD Input: "${cwdInput}", Effective CWD: "${effectiveCwd}"`);

  // --- Check if server already exists ---
  let existingServer = runningServers.get(label);
  // Check process liveliness if server info exists
  if (existingServer?.pid && !doesProcessExist(existingServer.pid)) {
    log.warn(label, `Server entry found, but process PID ${existingServer.pid} does not exist. Clearing stale entry.`);
    updateServerStatus(label, 'stopped', { error: "Stale process detected during start.", exitCode: null });
    // Consider logging this as an error if unexpected
    existingServer = undefined; // Treat as if it doesn't exist
  } else if (existingServer && existingServer.status === 'running') {
    const errorMsg = `Server with label "${label}" is already running (PID: ${existingServer.pid}).`;
    log.warn(label, errorMsg);
    // Use helpers for CallToolResult
    return ok(textPayload(JSON.stringify({
      warning: errorMsg,
      status: 'already_running',
      label: existingServer.label,
      pid: existingServer.pid,
      command: existingServer.command,
      cwd: existingServer.cwd,
      startTime: existingServer.startTime.toISOString(),
      logs: formatLogsForResponse(existingServer.logs, Math.min(logLines, MAX_STORED_LOG_LINES)),
    }, null, 2)));
  }
  // Clear previous terminal states (stopped, crashed, error)
  if (existingServer) {
    log.warn(label, `Removing previous terminal entry (status: ${existingServer.status}) before starting.`);
    runningServers.delete(label);
  }
  if (existingServer) {
    log.warn(label, `Removing previous stopped/error/crashed entry (status: ${existingServer.status}) before starting.`);
    runningServers.delete(label);
  }

  let child: ChildProcess | null = null;

  // --- Add CWD Check --- 
  log.debug(label, `Verifying existence of cwd: ${effectiveCwd}`);
  if (!fs.existsSync(effectiveCwd)) {
    const errorMsg = `Working directory does not exist: ${effectiveCwd}`;
    log.error(label, errorMsg);
    // Do not add to runningServers if CWD is invalid
    // updateServerStatus(label, 'error', { error: errorMsg }); // Set server to error state
    // runningServers.delete(label); // Clean up server info immediately
    // Use helpers for CallToolResult
    return fail(textPayload(JSON.stringify({
      error: `Failed to start server "${label}": ${errorMsg}`,
      error_type: "invalid_cwd",
      status: 'error',
      retry_hint: "Check the 'cwd' parameter provided. No automatic retry.",
    }, null, 2)));
  }
  log.debug(label, `CWD verified: ${effectiveCwd}`);
  // --- End CWD Check --- 

  const serverInfo: ServerInfo = {
    label: label, process: null, command: command, cwd: effectiveCwd,
    startTime: new Date(), status: 'starting', pid: null, logs: [], exitCode: null, error: null,
    retryCount: 0, lastAttemptTime: Date.now(), // Initialize retry state
    workspacePath: effectiveCwd // Assign workspacePath
  };
  runningServers.set(label, serverInfo); // Add early for logging context
  addLogEntry(label, 'system', `Attempting to start: "${command}" in "${effectiveCwd}"`);

  let startupStdout = '';
  let startupStderr = '';
  let startupError: Error | null = null;
  let closedDuringStartup = false;
  let closeDetails: { code: number | null, signal: NodeJS.Signals | null } | null = null;
  // Define shellPath outside the try block to be accessible in catch
  // const shellPath = process.env.SHELL || os.userInfo().shell || '/bin/sh'; // No longer using explicit shell

  try {
    // --- Inner try-catch specifically for spawn ---
    try {
      // Spawn WITHOUT explicit shell option
      log.debug(label, `Preparing to spawn command directly: '${command}'`, {
        cwd: effectiveCwd,
        shell: false, // Explicitly false
        envProvided: true // Indicating we passed env explicitly
      });
      child = spawn(command.split(' ')[0], command.split(' ').slice(1), { // Split command and args
        cwd: effectiveCwd,
        // shell: shellPath, // REMOVED explicit shell path
        shell: false, // Explicitly disable shell
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env } // Explicitly inherit/pass parent environment
      });
      log.debug(label, `Spawn function called for command: '${command}'. Child process object created (or threw error).`);
    } catch (spawnError: unknown) {
      // --- Log details within INNER CATCH --- 
      log.error(label, '!!! INNER CATCH BLOCK: Spawn call failed synchronously !!!');
      log.error(label, 'Spawn Error Object:', spawnError);
      // Update error message context
      const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
      const spawnErrorCode = typeof spawnError === 'object' && spawnError !== null && (spawnError as { code?: string }).code;
      const spawnErrorSyscall = typeof spawnError === 'object' && spawnError !== null && (spawnError as { syscall?: string }).syscall;
      const spawnErrorPath = typeof spawnError === 'object' && spawnError !== null && (spawnError as { path?: string }).path;

      const errorMsg = `Failed to spawn command '${command.split(' ')[0]}' directly: ${spawnErrorMessage}`;
      log.error(label, `Formatted Error Msg: ${errorMsg}`, { code: spawnErrorCode, syscall: spawnErrorSyscall, path: spawnErrorPath });

      let errorType = "spawn_exception";
      let hint = "Check command, cwd, PATH, and permissions. Manual intervention likely required.";
      if (spawnErrorCode === 'ENOENT') {
        errorType = "spawn_enoent";
        hint = "Command or shell not found. Check command path and environment. No automatic retry.";
      } else if (spawnErrorCode === 'EACCES') {
        errorType = "spawn_eacces";
        hint = "Permission denied executing command. Check file permissions. No automatic retry.";
      }
      // Update status to fatal error, as spawn itself failed
      const statusBeforeUpdate = runningServers.get(label)?.status;
      log.debug(label, `Inner Catch: Status before update: ${statusBeforeUpdate}. Updating to 'error'.`);
      updateServerStatus(label, 'error', { error: errorMsg });
      const statusAfterUpdate = runningServers.get(label)?.status;
      log.debug(label, `Inner Catch: Status after update: ${statusAfterUpdate}.`);

      // Log the response being returned
      // Use helpers for CallToolResult
      const response = fail(textPayload(JSON.stringify({
        error: `Failed to start server "${label}": ${errorMsg}`,
        error_code: spawnErrorCode,
        error_type: errorType,
        status: 'error',
        retry_hint: hint,
      }, null, 2)));
      log.error(label, 'Inner Catch: Returning error response:', response);
      return response;
    }
    // --- End inner try-catch ---

    if (!child || !child.pid) {
      // This case should ideally not be reached if spawn succeeded, but handle defensively
      const errorMsg = "Spawn seemed to succeed but failed to return a valid process/PID.";
      log.error(label, errorMsg);
      updateServerStatus(label, 'error', { error: errorMsg });
      // No retry for this internal error
      // Use helpers for CallToolResult
      return fail(textPayload(JSON.stringify({
        error: `Failed to start server "${label}": ${errorMsg}`,
        error_type: "spawn_internal_error_no_pid",
        status: 'error',
        retry_hint: "Internal error during spawn. Check logs.",
      }, null, 2)));
      // Original line: throw new Error("Failed to spawn process, PID is undefined."); -> Now handled above
    }

    const pid = child.pid;
    serverInfo.process = child;
    serverInfo.pid = pid;
    addLogEntry(label, 'system', `Process spawned with PID: ${pid}`);

    // Temporary listeners for startup phase with explicit types
    const tempStdoutListener = (data: Buffer): void => { startupStdout += data.toString(); addLogEntry(label, 'stdout', data.toString()); };
    const tempStderrListener = (data: Buffer): void => { startupStderr += data.toString(); addLogEntry(label, 'stderr', data.toString()); };
    const tempErrorListener = (err: Error): void => { startupError = err; };
    const tempCloseListener = (code: number | null, signal: NodeJS.Signals | null): void => { closedDuringStartup = true; closeDetails = { code, signal }; };

    child.stdout?.on('data', tempStdoutListener);
    child.stderr?.on('data', tempStderrListener);
    child.once('error', tempErrorListener);
    child.once('close', tempCloseListener);

    // Verification period
    updateServerStatus(label, 'verifying');
    addLogEntry(label, 'system', `Waiting ${STARTUP_VERIFICATION_DELAY_MS}ms for verification...`);
    await new Promise(resolve => setTimeout(resolve, STARTUP_VERIFICATION_DELAY_MS));

    // Remove temporary listeners
    child.stdout?.off('data', tempStdoutListener);
    child.stderr?.off('data', tempStderrListener);
    child.off('error', tempErrorListener);
    child.off('close', tempCloseListener);

    // Check for immediate crash/error during verification period
    if (startupError || closedDuringStartup) {
      // Safely determine exit reason, code, and signal
      let reason: string;
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;

      if (startupError) {
        reason = (startupError as Error).message; // Assert type as Error
        // Use closeDetails if available, otherwise null
        // Type assertion needed if closeDetails might also be 'never'
        exitCode = (closeDetails as { code: number | null, signal: NodeJS.Signals | null } | null)?.code ?? null;
        signal = (closeDetails as { code: number | null, signal: NodeJS.Signals | null } | null)?.signal ?? null;
      } else if (closedDuringStartup && closeDetails) {
        // closedDuringStartup=true implies closeDetails is non-null here
        // Assert type explicitly
        const details = closeDetails as { code: number | null, signal: NodeJS.Signals | null };
        reason = `Process exited during verification (Code: ${details.code ?? 'unknown'}, Signal: ${details.signal ?? 'unknown'})`;
        exitCode = details.code;
        signal = details.signal;
      } else {
        // Should be unreachable if logic is sound, but handle defensively
        reason = "Unknown startup failure: closedDuringStartup flag set but closeDetails missing";
        log.error(label, reason); // Log this unexpected state
      }

      const capturedOutput = `Startup STDOUT (last 500 chars):\n${stripAnsiSafe(startupStdout).slice(-500)}\n\nStartup STDERR (last 500 chars):\n${stripAnsiSafe(startupStderr).slice(-500)}`;
      const finalError = `${reason}\n\n${capturedOutput}`;
      // Transition to crashed, updateServerStatus will trigger retry logic
      updateServerStatus(label, 'crashed', { error: finalError, exitCode: exitCode });
      // The response should reflect the crash and hint at automatic retry
      const currentServerInfo = runningServers.get(label);
      const retryHint = currentServerInfo && currentServerInfo.retryCount < MAX_RETRIES
        ? `Attempting automatic restart (attempt ${currentServerInfo.retryCount + 1}/${MAX_RETRIES})...`
        : `Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;
      // Use helpers for CallToolResult
      return fail(textPayload(JSON.stringify({
        error: `Failed to start server "${label}": Process exited during verification. Reason: ${reason}`,
        error_type: "startup_crash",
        status: 'crashed',
        exitCode: exitCode,
        signal: signal,
        retry_hint: retryHint,
        startup_stdout_stripped: stripAnsiSafe(startupStdout).slice(-500),
        startup_stderr_stripped: stripAnsiSafe(startupStderr).slice(-500),
      }, null, 2)));
    }

    // If still alive after verification, assume running
    updateServerStatus(label, 'running', { error: null, exitCode: null }); // Clear any previous error/exit code
    serverInfo.retryCount = 0; // Reset retry count on successful start

    // Attach persistent listeners
    child.stdout?.on('data', (data: Buffer) => addLogEntry(label, 'stdout', data.toString()));
    child.stderr?.on('data', (data: Buffer) => addLogEntry(label, 'stderr', data.toString()));
    child.on('error', (err: Error) => {
      log.error(label, `Process error event: ${err.message}`);
      // Transition to crashed, letting handleExit manage retries/final state
      updateServerStatus(label, 'crashed', { error: err.message });
      addLogEntry(label, 'error', `Process error event: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      log.info(label, `Process close event: Code ${code}, Signal ${signal}`);
      handleExit(label, code, signal); // handleExit will manage state and retries
    });

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const initialLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);

    log.debug(label, `_startServer: Successfully started and verified server. PID: ${pid}`);
    // Use helpers for CallToolResult
    return ok(textPayload(JSON.stringify({
      label: label,
      pid: pid,
      status: 'running', // Confirmed running after verification
      message: `Development server labeled "${label}" started successfully and is running.`, // Updated message
      initialLogs: initialLogs,
      logLinesReturned: initialLogs.length,
      monitoring_hint: `Use 'check_dev_server_status' for updates. Max ${MAX_STORED_LOG_LINES} logs stored.`
    }, null, 2)));
  } catch (error: unknown) { // This outer catch handles errors *after* successful spawn
    // --- Log details within OUTER CATCH --- 
    log.error(label, '!!! OUTER CATCH BLOCK: Error occurred after successful spawn !!!');
    log.error(label, 'Outer Catch Error Object:', error);
    const finalErrorMsg = stripAnsiSafe(error instanceof Error ? error.message : String(error));
    let currentStatus: ServerStatus = 'error';
    let errorType = "startup_exception_after_spawn";
    let retryHint = "Manual intervention likely required.";

    log.error(label, `Formatted Outer Catch Error Msg: ${finalErrorMsg}`, { code: typeof error === 'object' && error !== null && (error as { code?: string }).code });

    // Since spawn succeeded, assume other errors might be retryable -> crashed
    currentStatus = 'crashed';

    // Ensure status reflects failure
    if (runningServers.has(label)) {
      const currentInfo = runningServers.get(label);
      const statusBeforeUpdate = currentInfo?.status;
      log.debug(label, `Outer Catch: Status before update: ${statusBeforeUpdate}. Updating to '${currentStatus}'.`);
      // Only update status if it's still in a pre-running state
      if (currentInfo && (currentInfo.status === 'starting' || currentInfo.status === 'verifying')) {
        updateServerStatus(label, currentStatus, { error: finalErrorMsg }); // Update with determined status
        currentStatus = runningServers.get(label)?.status ?? currentStatus; // Get potentially updated status
        const statusAfterUpdate = currentStatus;
        log.debug(label, `Outer Catch: Status after update: ${statusAfterUpdate}.`);

        // Provide retry hint if crashed
        if (currentStatus === 'crashed' && currentInfo.retryCount < MAX_RETRIES) {
          retryHint = `Startup failed after spawn. Attempting automatic restart (attempt ${currentInfo.retryCount + 1}/${MAX_RETRIES})...`;
        } else if (currentStatus === 'crashed') {
          retryHint = `Startup failed after spawn. Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;
        } else {
          // Fallback hint if status is unexpected
          retryHint = `Startup failed after spawn. Server status: ${currentStatus}. Check logs.`;
        }
      } else if (currentInfo) {
        currentStatus = currentInfo.status; // Reflect actual status if already changed
      }
    } else {
      // Server info missing, cannot determine retry state, treat as error
      log.error(label, `Outer Catch: Server info missing for label '${label}'. Cannot determine retry status.`);
      currentStatus = 'error';
      errorType = "startup_exception_no_info";
      retryHint = "Startup failed and server info lost. Manual check required.";
    }

    // Log the response being returned
    // Use helpers for CallToolResult
    const response = fail(textPayload(JSON.stringify({
      error: `Failed to start server with label "${label}".
Reason: ${finalErrorMsg}`,
      error_code: typeof error === 'object' && error !== null && (error as { code?: string }).code,
      error_type: errorType,
      status: currentStatus, // Report current known status
      retry_hint: retryHint, // Add hint
      startup_stdout_stripped: stripAnsiSafe(startupStdout).slice(-500),
      startup_stderr_stripped: stripAnsiSafe(startupStderr).slice(-500),
    }, null, 2)));
    log.error(label, 'Outer Catch: Returning error response:', response);
    return response;
  }
}


// Internal function to handle the core logic of stopping a server
async function _stopServer(
  label: string,
  force: boolean,
  logLines: number
): Promise<CallToolResult> {
  let serverInfo = await checkAndUpdateStatus(label); // Check status initially

  if (!serverInfo) {
    // Use helpers for CallToolResult
    return fail(textPayload(JSON.stringify({ error: `Server with label "${label}" not found.`, error_type: "not_found", status: 'not_found' }, null, 2)));
  }
  // Handle terminal states
  if (serverInfo.status === 'stopped' || serverInfo.status === 'crashed' || serverInfo.status === 'error') {
    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const finalLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);
    const message = serverInfo.status === 'stopped'
      ? `Server "${label}" is already stopped.`
      : `Server "${label}" is already in a terminal state: ${serverInfo.status}.`;
    // Use helpers for CallToolResult
    return ok(textPayload(JSON.stringify({ message: message, status: serverInfo.status, exitCode: serverInfo.exitCode, error: serverInfo.error, recentLogs: finalLogs, logLinesReturned: finalLogs.length }, null, 2)));
  }
  // Handle transient states where stop is invalid or redundant
  if (serverInfo.status === 'stopping') {
    // Use helpers for CallToolResult
    return ok(textPayload(JSON.stringify({ message: `Server "${label}" is already stopping. Check status again shortly.`, status: serverInfo.status, hint: "wait_and_check_status" }, null, 2)));
  }
  if (serverInfo.status === 'restarting' || serverInfo.status === 'starting' || serverInfo.status === 'verifying') {
    // Use helpers for CallToolResult
    return fail(textPayload(JSON.stringify({ error: `Cannot stop server "${label}" while it is ${serverInfo.status}. Wait for it to become stable or use restart.`, status: serverInfo.status, error_type: "invalid_state_for_stop" }, null, 2)));
  }
  if (!serverInfo.pid) {
    // This case implies state is running/starting/etc. but pid is missing - correct state to error
    const errorMsg = "Cannot stop server: State is active but PID is missing.";
    updateServerStatus(label, 'error', { error: errorMsg });
    // Use helpers for CallToolResult
    return fail(textPayload(JSON.stringify({ error: errorMsg, error_type: "internal_error_no_pid", status: 'error' }, null, 2)));
  }

  // Proceed with stop logic
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  let stopError: string | null = null;
  let signalSent = false;
  const initialPid = serverInfo.pid;

  try {
    updateServerStatus(label, 'stopping');
    addLogEntry(label, 'system', `Sending ${signal} signal.`);
    if (!doesProcessExist(initialPid)) { throw new Error(`Process PID ${initialPid} does not exist (already stopped?).`); }
    process.kill(initialPid, signal);
    signalSent = true;
    addLogEntry(label, 'system', `${signal} signal sent successfully.`);
  } catch (error: unknown) {
    addLogEntry(label, 'error', `Error sending ${signal} signal: ${error instanceof Error ? error.message : String(error)}`);
    stopError = `Failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`;
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ESRCH') {
      // Process already gone, consider it stopped (might have been stopping anyway)
      updateServerStatus(label, 'stopped', { error: 'Process already exited before stop signal could be sent.' });
      stopError = null; // Clear error as it's effectively stopped
    } else {
      updateServerStatus(label, 'error', { error: `Error during stop signal: ${stopError}` });
      // Keep stopError to report the failure
    }
  }

  let finalStatus: ServerStatus = serverInfo.status;
  let verificationMessage = "";

  // Wait for confirmation only if signal was sent successfully or if ESRCH occurred (meaning it's stopped)
  if (signalSent || stopError === null) {
    const waitDuration = force ? 100 : STOP_WAIT_DURATION; // Shorter wait for SIGKILL
    addLogEntry(label, 'system', `Waiting ${waitDuration}ms for process termination confirmation...`);
    await new Promise(resolve => setTimeout(resolve, waitDuration));

    const finalServerInfo = await checkAndUpdateStatus(label);
    if (finalServerInfo) {
      serverInfo = finalServerInfo; // Update ref for log retrieval and status reporting
      finalStatus = serverInfo.status;
      if (finalStatus !== 'stopped' && finalStatus !== 'crashed' && finalStatus !== 'error') {
        // It didn't stop within the timeout
        if (!force) {
          verificationMessage = `Process (PID: ${initialPid}) status is still '${finalStatus}' after SIGTERM and wait. Consider using 'force: true' (SIGKILL).`;
          addLogEntry(label, 'warn', verificationMessage);
          // Do NOT automatically escalate to SIGKILL here. Let the user/agent decide.
          stopError = stopError || `Server did not stop gracefully within ${waitDuration}ms. Current status: ${finalStatus}.`;
        } else {
          // If SIGKILL was sent and it's still not stopped/crashed/error, something is very wrong
          verificationMessage = `Process (PID: ${initialPid}) status is '${finalStatus}' even after SIGKILL and wait. Manual intervention may be required.`;
          addLogEntry(label, 'error', verificationMessage);
          stopError = stopError || `Server did not terminate after SIGKILL. Current status: ${finalStatus}.`;
          updateServerStatus(label, 'error', { error: stopError }); // Mark as error if SIGKILL fails
          finalStatus = 'error';
        }
      } else {
        verificationMessage = `Process (PID: ${initialPid}) successfully reached status '${finalStatus}'.`;
        addLogEntry(label, 'system', verificationMessage);
        // Clear stopError if the final status is definitively stopped/crashed/error
        if (finalStatus === 'stopped' || finalStatus === 'crashed' || finalStatus === 'error') {
          stopError = null;
        }
      }
    } else {
      // Server info disappeared? Assume stopped but log warning.
      finalStatus = 'stopped';
      stopError = `${stopError ? `${stopError}; ` : ""}Server info disappeared after stop attempt.`;
      verificationMessage = "Server info missing after stop attempt. Assuming stopped.";
      addLogEntry(label, 'warn', verificationMessage);
    }
  } else {
    // Signal sending failed, status is likely 'error'
    finalStatus = serverInfo.status; // Reflect the status set in the catch block
    verificationMessage = `Signal sending failed. Reason: ${stopError}`;
    // Ensure status is terminal if signal failed critically
    if ((finalStatus as ServerStatus) !== 'stopped' && (finalStatus as ServerStatus) !== 'crashed') {
      finalStatus = 'error'; // Mark as error if signal failed
    }
  }

  let responseMessage = '';
  let isErrorResponse = false;
  let errorType: string | undefined = undefined;
  let hint: string | undefined = undefined;

  if (stopError) {
    responseMessage = `Error stopping server "${label}": ${stopError}`;
    if (verificationMessage && finalStatus !== 'stopped' && finalStatus !== 'crashed' && finalStatus !== 'error') {
      responseMessage += ` ${verificationMessage}`;
      errorType = force ? "stop_sigkill_failed" : "stop_timeout";
      hint = force ? "check_manual_intervention" : "retry_with_force";
    } else {
      errorType = "stop_signal_error";
      hint = "check_status_and_logs";
    }
    isErrorResponse = true; // Mark as error if stopError is present
  } else {
    // Successfully stopped or confirmed stopped/crashed
    responseMessage = `Stop attempt for server "${label}" (PID: ${initialPid}) processed. Final verified status: ${finalStatus}.`;
    if (finalStatus === 'stopped') {
      hint = "server_stopped_successfully";
    } else if (finalStatus === 'crashed') {
      hint = "server_crashed_during_stop";
    }
  }


  const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
  const finalLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);

  // Use helpers for CallToolResult
  const payload = {
    message: responseMessage,
    status: finalStatus, // Use finalStatus which reflects outcome
    label: label,
    pid: initialPid, // Report the PID that was targeted
    exitCode: serverInfo?.exitCode ?? null,
    error: serverInfo?.error ?? stopError, // Report latest known error
    error_type: errorType,
    hint: hint, // Add hint for agent guidance
    recentLogs: finalLogs,
    logLinesReturned: finalLogs.length,
    logLinesHint: `Returned last ${finalLogs.length} log lines (ANSI stripped). Max stored: ${MAX_STORED_LOG_LINES}.`
  };
  const result = {
    content: [textPayload(JSON.stringify(payload, null, 2))],
    isError: isErrorResponse,
  }; // Removed 'as const'
  return result;
}

// --- Tool Definitions --- (Now using internal helpers) ---

// Define schemas for type inference
const startDevServerSchema = z.object({
  label: z.string().min(1).describe("A unique label to identify this server instance (e.g., 'frontend', 'backend-api'). Must be unique."),
  command: z.string().min(1).describe("The command to execute (e.g., 'npm run dev', 'pnpm start', 'yarn serve')"),
  cwd: z.string().optional().describe("The working directory to run the command from. Defaults to the user's home directory."),
  logLines: z.number().int().positive().optional().default(DEFAULT_RETURN_LOG_LINES).describe(`Number of initial log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`)
});
type StartDevServerParams = z.infer<typeof startDevServerSchema>;

server.tool(
  "start_dev_server",
  "Starts a development server in the background using a specified command and assigns it a unique label. Returns status and initial logs (ANSI codes stripped). Handles verification and basic crash detection.",
  shape(startDevServerSchema.shape), // Use shape helper
  (params: StartDevServerParams) => handleToolCall(params.label, "start_dev_server", params, async () => { // Add explicit type
    return await _startServer(params.label, params.command, params.cwd, params.logLines);
  })
);

const checkDevServerStatusSchema = z.object({
  label: z.string().min(1).describe("The unique label of the server to check."),
  logLines: z.number().int().positive().optional().default(DEFAULT_RETURN_LOG_LINES).describe(`Number of recent log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`),
});
type CheckDevServerStatusParams = z.infer<typeof checkDevServerStatusSchema>;

server.tool(
  "check_dev_server_status",
  "Checks the status and recent logs (ANSI codes stripped) of a development server using its label. Verifies if the process still exists.",
  shape(checkDevServerStatusSchema.shape), // Use shape helper
  (params: CheckDevServerStatusParams) => handleToolCall(params.label, "check_dev_server_status", params, async (): Promise<CallToolResult> => { // Add explicit type
    const { label, logLines } = params;
    const serverInfo = await checkAndUpdateStatus(label);

    if (!serverInfo) {
      // Use helpers for CallToolResult
      return fail(textPayload(JSON.stringify({ error: `Server with label "${label}" not found or was never started.`, status: 'not_found', error_type: "not_found" }, null, 2)));
    }

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const returnedLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);
    let hint = "Server status retrieved.";
    if (serverInfo.status === 'restarting') {
      hint = `Server is restarting (attempt ${serverInfo.retryCount + 1}/${MAX_RETRIES}). Check back shortly.`;
    } else if (serverInfo.status === 'crashed') {
      hint = serverInfo.retryCount < MAX_RETRIES
        ? `Server crashed. Automatic restart pending (attempt ${serverInfo.retryCount + 1}/${MAX_RETRIES}).`
        : `Server crashed. Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;
    } else if (serverInfo.status === 'error') {
      hint = `Server is in unrecoverable error state. ${serverInfo.error || 'Manual intervention likely required.'}`;
    }

    // Use helpers for CallToolResult
    const payload = {
      label: serverInfo.label,
      pid: serverInfo.pid,
      command: serverInfo.command,
      cwd: serverInfo.cwd,
      startTime: serverInfo.startTime.toISOString(),
      status: serverInfo.status,
      exitCode: serverInfo.exitCode,
      error: serverInfo.error,
      retryCount: serverInfo.retryCount, // Include retry info
      hint: hint, // Add contextual hint
      logs: returnedLogs,
      logLinesReturned: returnedLogs.length,
      monitoring_hint: `Returning last ${returnedLogs.length} log lines (ANSI stripped). Max stored is ${MAX_STORED_LOG_LINES}.`
    };
    const result = {
      content: [textPayload(JSON.stringify(payload, null, 2))],
      // isError should reflect if the *status itself* is a failure state
      isError: serverInfo.status === 'error' || serverInfo.status === 'crashed',
    }; // Removed 'as const'
    return result;
  })
);


const stopDevServerSchema = z.object({
  label: z.string().min(1).describe("The unique label of the server to stop."),
  force: z.boolean().optional().default(false).describe("If true, use SIGKILL for immediate termination instead of SIGTERM."),
  logLines: z.number().int().positive().optional().default(DEFAULT_RETURN_LOG_LINES).describe(`Number of recent log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`),
});
type StopDevServerParams = z.infer<typeof stopDevServerSchema>;

server.tool(
  "stop_dev_server",
  "Stops a specific development server using its label and verifies the stop. Returns final status and recent logs (ANSI codes stripped). Handles stop timeouts.",
  shape(stopDevServerSchema.shape), // Use shape helper
  (params: StopDevServerParams) => handleToolCall(params.label, "stop_dev_server", params, async () => { // Add explicit type
    return await _stopServer(params.label, params.force, params.logLines);
  })
);

server.tool(
  "list_dev_servers",
  "Lists all currently managed development servers and their statuses.",
  {}, // Empty schema
  () => handleToolCall(null, "list_dev_servers", {}, async (): Promise<CallToolResult> => { // No params arg needed
    if (runningServers.size === 0) {
      // Use helpers for CallToolResult
      return ok(textPayload(JSON.stringify({ message: "No development servers are currently being managed.", servers: [] }, null, 2)));
    }

    // Run a quick check on servers before listing to potentially update statuses
    for (const label of runningServers.keys()) {
      await checkAndUpdateStatus(label);
    }

    const serverList = Array.from(runningServers.values()).map(info => ({
      label: info.label,
      pid: info.pid,
      command: info.command,
      cwd: info.cwd,
      status: info.status,
      startTime: info.startTime.toISOString(),
      error: info.error, // Last known error
      exitCode: info.exitCode, // Last known exit code
      retryCount: info.retryCount, // Current retry count
    }));

    // Use helpers for CallToolResult
    return ok(textPayload(JSON.stringify({ message: `Found ${serverList.length} managed servers.`, servers: serverList }, null, 2)));
  })
);


const stopAllDevServersSchema = z.object({
  force: z.boolean().optional().default(false).describe("If true, use SIGKILL for immediate termination instead of SIGTERM."),
});
type StopAllDevServersParams = z.infer<typeof stopAllDevServersSchema>;

server.tool(
  "stop_all_dev_servers",
  "Stops all currently running or starting development servers managed by this tool and verifies.",
  shape(stopAllDevServersSchema.shape), // Use shape helper
  (params: StopAllDevServersParams) => handleToolCall(null, "stop_all_dev_servers", params, async (): Promise<CallToolResult> => { // Add explicit type
    const { force } = params;
    const results: { label: string; pid: number | null; initialStatus: ServerStatus; signalSent: boolean; error?: string; finalStatus?: ServerStatus }[] = [];
    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    const activeLabels: string[] = [];

    log.info(null, `Attempting to stop all active servers with ${signal}...`);

    for (const [label, serverInfo] of runningServers.entries()) {
      let sentSignal = false;
      let signalError: string | undefined = undefined;
      const isActive = (serverInfo.status === 'running' || serverInfo.status === 'starting' || serverInfo.status === 'verifying'); // Include verifying

      if (isActive && serverInfo.pid) {
        activeLabels.push(label);
        try {
          updateServerStatus(label, 'stopping');
          addLogEntry(label, 'system', `Sending ${signal} signal (stop_all).`);
          process.kill(serverInfo.pid, signal);
          sentSignal = true;
        } catch (error: unknown) {
          addLogEntry(label, 'error', `Error sending ${signal} signal (stop_all): ${error instanceof Error ? error.message : String(error)}`);
          signalError = `Failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`;
          if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ESRCH') {
            updateServerStatus(label, 'stopped', { error: 'Process already exited (detected during stop_all signal).' });
            signalError = undefined;
          } else {
            updateServerStatus(label, 'error', { error: signalError });
          }
        }
      }
      results.push({ label, pid: serverInfo.pid, initialStatus: serverInfo.status, signalSent: sentSignal, error: signalError }); // Explicitly assign sentSignal value
    }

    if (activeLabels.length > 0) {
      log.info(null, `Waiting ${STOP_WAIT_DURATION}ms after sending signals...`);
      await new Promise(resolve => setTimeout(resolve, STOP_WAIT_DURATION));
      log.info(null, 'Finished waiting. Checking final statuses...'); // Fixed template literal
    } else {
      log.info(null, 'No active servers found to stop.'); // Fixed template literal
    }

    for (const result of results) {
      const finalInfo = await checkAndUpdateStatus(result.label);
      if (finalInfo) {
        result.finalStatus = finalInfo.status;
        if (finalInfo.error && !result.error) { result.error = finalInfo.error; }
        // Check if stop attempt failed
        if (result.signalSent && finalInfo.status !== 'stopped' && finalInfo.status !== 'crashed' && finalInfo.status !== 'error' && !result.error) {
          result.error = `Process still ${finalInfo.status} after ${signal} and wait.`;
          result.finalStatus = finalInfo.status; // Update final status if stop failed
        } else if (!result.signalSent && result.error && finalInfo.status !== 'stopped' && finalInfo.status !== 'crashed' && finalInfo.status !== 'error') {
          // If signal sending failed, ensure status reflects error
          result.finalStatus = 'error';
        }
      } else {
        // Info disappeared, determine status based on whether signal was sent
        result.finalStatus = result.signalSent ? 'stopped' : 'error'; // Assume stopped if signal sent, error otherwise
        result.error = `${result.error ? `${result.error}; ` : ""}Server info disappeared after stop_all attempt.`;
      }
    }

    const summary = results.reduce((acc, r) => {
      const status = r.finalStatus ?? r.initialStatus;
      if (status === 'stopped') acc.stopped++;
      else if (status === 'crashed') acc.crashed++; // Separate crashed count
      else if (status === 'error' || r.error) acc.failed++;
      else if (status === 'running' || status === 'stopping' || status === 'restarting' || status === 'verifying' || status === 'starting') acc.stillActive++; // Broader category
      else acc.other++;
      return acc;
    }, { totalAttempted: results.length, stopped: 0, crashed: 0, failed: 0, stillActive: 0, other: 0 });

    const message = `Stop all attempt finished. Servers processed: ${summary.totalAttempted}. ` +
      `Stopped: ${summary.stopped}, Crashed: ${summary.crashed}, Failed/Error: ${summary.failed}, Still Active: ${summary.stillActive}.`;
    log.info(null, message);

    // Use helpers for CallToolResult
    const payload = {
      message: message,
      summary: summary,
      details: results.map(r => ({
        label: r.label,
        pid: r.pid,
        initialStatus: r.initialStatus,
        signalSent: r.signalSent,
        finalStatus: r.finalStatus,
        error: r.error // Already stripped
      })),
    };
    const result = {
      content: [textPayload(JSON.stringify(payload, null, 2))],
      // Consider error if any failed or are still active after stop attempt
      isError: summary.failed > 0 || summary.stillActive > 0,
    }; // Removed 'as const'
    return result;
  })
);

// --- Tool: restart_dev_server ---
const restartDevServerSchema = z.object({
  label: z.string().min(1).describe("The unique label of the server to restart."),
  force: z.boolean().optional().default(false).describe("If true, use SIGKILL for the stop phase instead of SIGTERM."),
  logLines: z.number().int().positive().optional().default(DEFAULT_RETURN_LOG_LINES).describe(`Number of initial log lines to return from the start phase (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`),
});
type RestartDevServerParams = z.infer<typeof restartDevServerSchema>;

server.tool(
  "restart_dev_server",
  "Stops (if running) and then starts a development server with the same configuration. Returns final status and initial logs from the start phase.",
  shape(restartDevServerSchema.shape), // Use shape helper
  (params: RestartDevServerParams) => handleToolCall(params.label, "restart_dev_server", params, async (): Promise<CallToolResult> => { // Add explicit type
    const { label, force, logLines } = params;
    let startResult: CallToolResult | null = null; // Keep this to return directly on success
    let stopErrorMsg: string | null = null;
    let startErrorMsg: string | null = null; // Declare startErrorMsg here
    let finalMessage = "";
    let originalCommand: string | null = null;
    let originalCwd: string | null = null;
    // Define a type for the parsed stop result
    type StopResultPayload = {
      status?: ServerStatus | 'not_found' | 'already_stopped';
      error?: string | null;
      // Add other potential fields if needed based on JSON structure
    };
    let stopResultJson: StopResultPayload | null = null; // Use the defined type
    let stopStatus: ServerStatus | 'not_found' | 'already_stopped' = 'not_found';

    addLogEntry(label, 'system', `Restart requested (force=${force}).`);

    // --- Stop Phase ---
    const serverInfo = runningServers.get(label); // Use const

    if (serverInfo) {
      originalCommand = serverInfo.command;
      originalCwd = serverInfo.cwd;

      // Check if it needs stopping (running, starting, verifying, stopping)
      if (serverInfo.status === 'running' || serverInfo.status === 'starting' || serverInfo.status === 'verifying' || serverInfo.status === 'stopping') {
        addLogEntry(label, 'system', `Stopping server (status: ${serverInfo.status}) before restart...`);
        const stopResponse = await _stopServer(label, force, 0); // Use internal function, ignore logs for this step

        if (stopResponse.isError) {
          stopErrorMsg = "Unknown stop error during restart";
          const responseText = getResultText(stopResponse);
          if (responseText) {
            try {
              const parsedError = JSON.parse(responseText);
              // Safely access error property after parsing
              stopErrorMsg = typeof parsedError === 'object' && parsedError !== null && typeof parsedError.error === 'string' ? parsedError.error : stopErrorMsg;
            } catch { /* Ignore parse error */ }
          }
          log.error(label, `Stop phase failed during restart: ${stopErrorMsg}`);
          addLogEntry(label, 'error', `Stop phase failed during restart: ${stopErrorMsg}`);
          stopStatus = 'error';
        } else {
          try {
            const responseText = getResultText(stopResponse);
            if (!responseText) throw new Error("Stop response content is missing text");
            const parsedText = JSON.parse(responseText);
            // Type assertion after parsing JSON
            stopResultJson = parsedText as StopResultPayload;
            stopStatus = stopResultJson?.status ?? 'error'; // Use parsed status, default to error if missing
            if (stopStatus === 'stopped' || stopStatus === 'crashed' || stopStatus === 'error') {
              addLogEntry(label, 'system', `Stop phase completed, final status: ${stopStatus}.`);
              stopErrorMsg = stopResultJson?.error ?? null; // Use parsed error
            } else {
              // Stop attempt finished but didn't result in a stopped/crashed/error state
              stopErrorMsg = stopResultJson?.error || `Server status is still '${stopStatus}' after stop attempt. Cannot proceed with start.`;
              addLogEntry(label, 'warn', stopErrorMsg ?? 'Stop phase warning: Unknown error message'); // Provide default if null
            }
          } catch (e) {
            stopErrorMsg = "Failed to parse stop server response during restart.";
            stopStatus = 'error';
            addLogEntry(label, 'error', `${stopErrorMsg} Exception: ${e instanceof Error ? e.message : String(e)}`); // Combine msg and exception
          }
        }
      } else {
        // Already stopped, crashed, or error state
        stopStatus = 'already_stopped'; // Representing it didn't need stopping
        addLogEntry(label, 'system', `Server was already ${serverInfo.status}. Skipping stop signal phase.`);
      }
    } else {
      stopStatus = 'not_found';
      stopErrorMsg = `Server with label "${label}" not found. Cannot restart.`;
      addLogEntry(label, 'warn', stopErrorMsg);
    }

    // --- Start Phase ---
    // Allow starting if the stop phase resulted in stopped/crashed/error or if it was already stopped/crashed/error
    const canStart = !stopErrorMsg || stopStatus === 'stopped' || stopStatus === 'crashed' || stopStatus === 'error' || stopStatus === 'already_stopped';

    if (canStart && originalCommand && originalCwd !== null) {
      // Check if the stop phase actually resulted in an error that should prevent starting
      if (stopErrorMsg && stopStatus !== 'stopped' && stopStatus !== 'crashed' && stopStatus !== 'error') {
        finalMessage = `Restart aborted: Stop phase completed with status '${stopStatus}' and error: ${stopErrorMsg}. Cannot start.`;
        addLogEntry(label, 'warn', finalMessage);
      } else {
        addLogEntry(label, 'system', 'Starting server after stop/check phase...');
        // Use internal start function
        startResult = await _startServer(label, originalCommand, originalCwd, logLines);

        // Check startResult properties safely
        if (startResult.isError) {
          startErrorMsg = "Unknown start error during restart";
          const responseText = getResultText(startResult);
          if (responseText) {
            try {
              const parsedError = JSON.parse(responseText);
              // Safely access error property after parsing
              startErrorMsg = typeof parsedError === 'object' && parsedError !== null && typeof parsedError.error === 'string' ? parsedError.error : startErrorMsg;
            } catch { /* Ignore parse error */ }
          }
          addLogEntry(label, 'error', `Start phase failed during restart: ${startErrorMsg}`);
          finalMessage = `Restart failed: Server stopped (or was already stopped) but failed to start. Reason: ${startErrorMsg}`;
        } else {
          addLogEntry(label, 'system', 'Start phase successful.');
          finalMessage = `Server "${label}" restarted successfully.`;
          // Success - return the start result directly
          // Ensure startResult is not null before returning (though logic implies it shouldn't be)
          if (startResult) {
            return startResult;
          }
          // This case should ideally not be reached
          startErrorMsg = "Internal error: Start phase successful but result is null.";
          addLogEntry(label, 'error', startErrorMsg);
          finalMessage = `Restart failed: ${startErrorMsg}`;
        }
      }
    } else if (canStart && (!originalCommand || originalCwd === null)) {
      startErrorMsg = `Cannot start server "${label}" as original command or cwd was not found (server might not have existed or info was lost).`;
      addLogEntry(label, 'error', startErrorMsg);
      finalMessage = `Restart failed: ${startErrorMsg}`;
    } else {
      // This case means canStart was false, implies stopErrorMsg was set and stopStatus wasn't permissive
      finalMessage = `Restart aborted: Stop phase failed or did not result in a stopped state. Error: ${stopErrorMsg || 'Unknown stop phase issue.'}`;
    }

    // --- Return Error Response ---
    // If we reach here, either stop or start failed, or precondition wasn't met
    // Use helpers for CallToolResult
    return fail(textPayload(JSON.stringify({
      error: finalMessage,
      stopPhase: {
        status: stopStatus, // The status *after* the stop attempt (or initial if not attempted)
        error: stopErrorMsg, // Error encountered during stop attempt
        hint: stopStatus === 'error' ? "check_stop_logs" : (stopStatus !== 'stopped' && stopStatus !== 'crashed') ? "retry_stop_with_force" : "stop_phase_ok",
      },
      startPhase: {
        attempted: canStart && !!originalCommand && originalCwd !== null && (!stopErrorMsg || stopStatus === 'stopped' || stopStatus === 'crashed' || stopStatus === 'error'),
        error: startErrorMsg, // Error encountered during start attempt
        hint: startErrorMsg ? "check_start_logs" : undefined,
      },
      finalStatus: runningServers.get(label)?.status ?? stopStatus // Best guess at the final status
    }, null, 2)));
  })
);

// --- Tool: wait_for_dev_server ---
const waitForDevServerSchema = z.object({
  label: z.string().min(1).describe("The unique label of the server to wait for."),
  timeoutSeconds: z.number().int().positive().optional().default(5).describe("Maximum time in seconds to wait for the server to reach the target status (e.g., allow 5s for reload/startup). Default: 5s."),
  checkIntervalSeconds: z.number().positive().optional().default(1).describe("How often to check the server status in seconds during the wait. Default: 1s."),
  targetStatus: z.string().optional().default('running').describe("The desired status to wait for (e.g., 'running', 'stopped'). Default: 'running'."),
  logLines: z.number().int().positive().optional().default(DEFAULT_RETURN_LOG_LINES).describe(`Number of recent log lines to return upon completion or timeout (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`),
});
type WaitForDevServerParams = z.infer<typeof waitForDevServerSchema>;

server.tool(
  "wait_for_dev_server",
  "Waits for a specific development server to reach a target status (usually 'running' after a start/restart) within a timeout. Checks status periodically. Use this after starting or restarting a server to ensure it's ready before proceeding.",
  shape(waitForDevServerSchema.shape), // Use shape helper
  (params: WaitForDevServerParams) => handleToolCall(params.label, "wait_for_dev_server", params, async (): Promise<CallToolResult> => { // Add explicit type
    const { label, timeoutSeconds, checkIntervalSeconds, targetStatus, logLines } = params;
    const startTime = Date.now();
    const endTime = startTime + timeoutSeconds * 1000;

    addLogEntry(label, 'system', `Waiting up to ${timeoutSeconds}s for status '${targetStatus}' (checking every ${checkIntervalSeconds}s).`);

    let serverInfo = await checkAndUpdateStatus(label);
    if (!serverInfo) {
      // Use helpers for CallToolResult
      return fail(textPayload(JSON.stringify({ error: `Server with label "${label}" not found.`, status: 'not_found', error_type: "not_found" }, null, 2)));
    }

    let timedOut = false;
    let achievedTargetStatus = serverInfo.status === targetStatus;
    let finalHint = "";

    while (!achievedTargetStatus && Date.now() < endTime) {
      await new Promise(resolve => setTimeout(resolve, checkIntervalSeconds * 1000));
      serverInfo = await checkAndUpdateStatus(label); // Re-check status
      if (!serverInfo) { // Server info disappeared during wait?
        addLogEntry(label, 'error', `Server info for "${label}" disappeared during wait.`);
        // Use helpers for CallToolResult
        return fail(textPayload(JSON.stringify({ error: `Server with label "${label}" disappeared during wait. Cannot determine status.`, status: 'unknown', error_type: "disappeared_during_wait" }, null, 2)));
      }
      achievedTargetStatus = serverInfo.status === targetStatus;
      // Exit loop early if server enters a terminal state different from target
      if (serverInfo.status === 'crashed' || serverInfo.status === 'error' || serverInfo.status === 'stopped') {
        if (serverInfo.status !== targetStatus) {
          addLogEntry(label, 'warn', `Wait aborted: Server entered terminal state '${serverInfo.status}' while waiting for '${targetStatus}'.`);
          break; // Stop waiting
        }
      }
    }

    if (!achievedTargetStatus) {
      // Check if it was due to timeout or entering wrong terminal state
      if (Date.now() >= endTime) {
        timedOut = true;
        addLogEntry(label, 'warn', `Timed out after ${timeoutSeconds}s waiting for status '${targetStatus}'. Current status: '${serverInfo.status}'.`);
        finalHint = `Wait timed out. Server is currently ${serverInfo.status}.`;
      } else {
        // Achieved a different terminal status
        finalHint = `Wait ended. Server reached state '${serverInfo.status}' instead of target '${targetStatus}'.`;
      }
    } else {
      addLogEntry(label, 'system', `Successfully reached target status '${targetStatus}'.`);
      finalHint = `Wait successful. Server reached target status '${targetStatus}'.`;
    }

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const finalLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);
    const responsePayload = {
      label: serverInfo.label,
      pid: serverInfo.pid,
      command: serverInfo.command,
      cwd: serverInfo.cwd,
      startTime: serverInfo.startTime.toISOString(),
      status: serverInfo.status, // Final status after wait
      targetStatus: targetStatus,
      waitResult: timedOut ? 'timed_out' : (achievedTargetStatus ? 'success' : 'wrong_state'),
      exitCode: serverInfo.exitCode,
      error: serverInfo.error,
      hint: finalHint,
      waitedSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
      timeoutSetting: timeoutSeconds,
      logs: finalLogs,
      logLinesReturned: finalLogs.length,
      monitoring_hint: `Wait complete. Final status: '${serverInfo.status}'. ${finalHint}`
    };

    // Use helpers for CallToolResult
    const result = {
      content: [textPayload(JSON.stringify(responsePayload, null, 2))],
      // isError should reflect if the final state is an error/crash, or if timed out waiting for non-error state
      isError: serverInfo.status === 'error' || serverInfo.status === 'crashed' || (timedOut && targetStatus !== 'stopped' && targetStatus !== 'crashed' && targetStatus !== 'error'),
    }; // Removed 'as const'
    return result;
  })
);

// --- Server Start and Cleanup ---

async function main() {
  if (zombieCheckIntervalId) clearInterval(zombieCheckIntervalId);
  zombieCheckIntervalId = setInterval(reapZombies, ZOMBIE_CHECK_INTERVAL);
  log.info(null, `Started zombie process check interval (${ZOMBIE_CHECK_INTERVAL}ms).`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(null, "Dev Server Manager MCP Tool running on stdio");
}

function cleanup(signal: string) {
  log.warn(null, `Received ${signal}. Shutting down...`);
  if (zombieCheckIntervalId) {
    clearInterval(zombieCheckIntervalId);
    zombieCheckIntervalId = null;
    log.info(null, "Stopped zombie check interval.");
  }

  log.warn(null, "Stopping all managed dev servers...");
  let killCount = 0;
  for (const [label, serverInfo] of runningServers.entries()) {
    if (serverInfo.pid) {
      try {
        log.warn(label, `Stopping PID ${serverInfo.pid} on exit with SIGKILL...`);
        process.kill(serverInfo.pid, 'SIGKILL');
        killCount++;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && (e as { code?: string }).code !== 'ESRCH') {
          log.error(label, `Error stopping PID ${serverInfo.pid} on exit: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  log.warn(null, `Attempted final termination for ${killCount} servers. Exiting.`);
  process.exit(0);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('exit', (code) => {
  log.info(null, `MCP Server process exiting with code ${code}.`);
  if (zombieCheckIntervalId) clearInterval(zombieCheckIntervalId);
});

main().catch((error) => {
  log.error(null, "Fatal error starting Dev Server Manager:", error);
  if (zombieCheckIntervalId) clearInterval(zombieCheckIntervalId);
  process.exit(1);
});