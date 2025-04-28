import { spawn as spawnPty, type IPty } from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { type CallToolResult, ok, fail, textPayload, type ServerInfo, type ServerStatus } from './types.js';
import { MAX_STORED_LOG_LINES, STARTUP_VERIFICATION_DELAY_MS, MAX_RETRIES, STOP_WAIT_DURATION } from './constants.js';
import { log, stripAnsiSafe, formatLogsForResponse } from './utils.js';
import { runningServers, addLogEntry, updateServerStatus, handleExit, doesProcessExist, checkAndUpdateStatus } from './state.js';

// --- Internal Core Logic Functions ---

export async function _startServer(
    label: string,
    command: string,
    cwdInput: string | undefined,
    logLines: number
): Promise<CallToolResult> {

    const effectiveCwd = cwdInput
        ? path.resolve(cwdInput)
        : process.env.MCP_WORKSPACE_ROOT || process.cwd();

    log.info(label, `Starting server process... Command: "${command}", CWD Input: "${cwdInput}", Effective CWD: "${effectiveCwd}"`);

    let existingServer = runningServers.get(label);
    if (existingServer?.pid && !doesProcessExist(existingServer.pid)) {
        log.warn(label, `Server entry found, but process PID ${existingServer.pid} does not exist. Clearing stale entry.`);
        updateServerStatus(label, 'stopped', { error: "Stale process detected during start.", exitCode: null });
        existingServer = undefined;
    } else if (existingServer && existingServer.status === 'running') {
        const errorMsg = `Server with label "${label}" is already running (PID: ${existingServer.pid}).`;
        log.warn(label, errorMsg);
        return ok(textPayload(JSON.stringify({
            warning: errorMsg, status: 'already_running', label: existingServer.label,
            pid: existingServer.pid, command: existingServer.command, cwd: existingServer.cwd,
            startTime: existingServer.startTime.toISOString(),
            logs: formatLogsForResponse(existingServer.logs, Math.min(logLines, MAX_STORED_LOG_LINES)),
        }, null, 2)));
    }
    if (existingServer) {
        log.warn(label, `Removing previous terminal entry (status: ${existingServer.status}) before starting.`);
        runningServers.delete(label);
    }

    let ptyProcess: IPty | null = null; // Changed type

    log.debug(label, `Verifying existence of cwd: ${effectiveCwd}`);
    if (!fs.existsSync(effectiveCwd)) {
        const errorMsg = `Working directory does not exist: ${effectiveCwd}`;
        log.error(label, errorMsg);
        return fail(textPayload(JSON.stringify({
            error: `Failed to start server "${label}": ${errorMsg}`, error_type: "invalid_cwd",
            status: 'error', retry_hint: "Check the 'cwd' parameter provided. No automatic retry.",
        }, null, 2)));
    }
    log.debug(label, `CWD verified: ${effectiveCwd}`);

    const serverInfo: ServerInfo = {
        label: label, process: null, command: command, cwd: effectiveCwd,
        startTime: new Date(), status: 'starting', pid: null, logs: [], exitCode: null, error: null,
        retryCount: 0, lastAttemptTime: Date.now(),
        workspacePath: effectiveCwd
    };
    runningServers.set(label, serverInfo);
    addLogEntry(label, 'system', `Attempting to start: "${command}" in "${effectiveCwd}"`);

    let startupOutput = ''; // Combined stdout/stderr for pty
    let closedDuringStartup = false;
    let closeDetails: { exitCode: number, signal?: number } | null = null; // Use node-pty exit signature

    try {
        // --- Spawn with node-pty ---
        try {
            const cmdParts = command.split(' ');
            const cmdName = cmdParts[0];
            const cmdArgs = cmdParts.slice(1);

            log.debug(label, `Preparing to spawn with node-pty: '${cmdName}', args: [${cmdArgs.join(', ')}]`, {
                cwd: effectiveCwd,
                name: 'xterm-256color', // Standard terminal type
                cols: 80, // Default size, can be adjusted if needed
                rows: 24,
                env: { ...process.env } // Pass environment
            });

            // Use spawnPty from node-pty
            ptyProcess = spawnPty(cmdName, cmdArgs, {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: effectiveCwd,
                env: { ...process.env } as { [key: string]: string }, // node-pty needs string values for env
            });
            log.debug(label, `node-pty spawn function called for command: '${cmdName}'. Pty process object created (or threw error).`);

        } catch (spawnError: unknown) {
            log.error(label, '!!! INNER CATCH BLOCK: node-pty spawn call failed synchronously !!!');
            log.error(label, 'Spawn Error Object:', spawnError);
            const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
            const errorMsg = `Failed to spawn command '${command.split(' ')[0]}' using node-pty: ${spawnErrorMessage}`;
            log.error(label, `Formatted Error Msg: ${errorMsg}`);

            const errorType = "spawn_exception";
            const hint = "Check command, cwd, PATH, permissions, and node-pty installation. Manual intervention likely required.";
            // node-pty might not provide specific error codes like ENOENT/EACCES as easily

            const statusBeforeUpdate = runningServers.get(label)?.status;
            log.debug(label, `Inner Catch: Status before update: ${statusBeforeUpdate}. Updating to 'error'.`);
            updateServerStatus(label, 'error', { error: errorMsg });
            const statusAfterUpdate = runningServers.get(label)?.status;
            log.debug(label, `Inner Catch: Status after update: ${statusAfterUpdate}.`);

            const response = fail(textPayload(JSON.stringify({
                error: `Failed to start server "${label}": ${errorMsg}`, error_type: errorType,
                status: 'error', retry_hint: hint,
            }, null, 2)));
            log.error(label, 'Inner Catch: Returning error response:', response);
            return response;
        }
        // --- End node-pty spawn ---

        if (!ptyProcess || typeof ptyProcess.pid !== 'number') { // Check pid is number
            const errorMsg = "node-pty spawn seemed to succeed but failed to return a valid process/PID.";
            log.error(label, errorMsg);
            updateServerStatus(label, 'error', { error: errorMsg });
            return fail(textPayload(JSON.stringify({
                error: `Failed to start server "${label}": ${errorMsg}`, error_type: "spawn_internal_error_no_pid",
                status: 'error', retry_hint: "Internal error during node-pty spawn. Check logs.",
            }, null, 2)));
        }

        const pid = ptyProcess.pid;
        serverInfo.process = ptyProcess; // Store the IPty process
        serverInfo.pid = pid;
        addLogEntry(label, 'system', `Process spawned with PID: ${pid}`);

        // Temporary listeners for startup phase
        const tempOutputListener = (data: string): void => { startupOutput += data; addLogEntry(label, 'pty', data); };
        // node-pty does not have a separate 'error' event like child_process for spawn failures
        const tempExitListener = (details: { exitCode: number, signal?: number }): void => {
            closedDuringStartup = true;
            closeDetails = details;
        };

        const dataDisposable = ptyProcess.onData(tempOutputListener);
        const exitDisposable = ptyProcess.onExit(tempExitListener);

        // Verification period
        updateServerStatus(label, 'verifying');
        addLogEntry(label, 'system', `Waiting ${STARTUP_VERIFICATION_DELAY_MS}ms for verification...`);
        await new Promise(resolve => setTimeout(resolve, STARTUP_VERIFICATION_DELAY_MS));

        // Remove temporary listeners using disposables
        dataDisposable.dispose();
        exitDisposable.dispose();

        // Check for immediate exit during verification period
        if (closedDuringStartup && closeDetails) {
            const { exitCode, signal } = closeDetails;
            const reason = signal !== undefined ? `Process exited during verification (Signal: ${signal})` : `Process exited during verification (Code: ${exitCode})`;
            const capturedOutput = `Startup PTY Output (last 500 chars):\n${stripAnsiSafe(startupOutput).slice(-500)}`;
            const finalError = `${reason}\n\n${capturedOutput}`;

            updateServerStatus(label, 'crashed', { error: finalError, exitCode: exitCode });
            const currentServerInfo = runningServers.get(label);
            const retryHint = currentServerInfo && currentServerInfo.retryCount < MAX_RETRIES
                ? `Attempting automatic restart (attempt ${currentServerInfo.retryCount + 1}/${MAX_RETRIES})...`
                : `Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;

            return fail(textPayload(JSON.stringify({
                error: `Failed to start server "${label}": ${reason}`, error_type: "startup_crash",
                status: 'crashed', exitCode: exitCode, signal: signal, retry_hint: retryHint,
                startup_output_stripped: stripAnsiSafe(startupOutput).slice(-500),
            }, null, 2)));
        }

        // If still alive after verification, assume running
        updateServerStatus(label, 'running', { error: null, exitCode: null });
        serverInfo.retryCount = 0;

        // Attach persistent listeners
        ptyProcess.onData((data: string) => addLogEntry(label, 'pty', data));
        ptyProcess.onExit(({ exitCode, signal }) => {
            log.info(label, `Process exit event: Code ${exitCode}, Signal ${signal}`);
            handleExit(label, exitCode, signal);
        });

        const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
        const initialLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);

        log.debug(label, `_startServer: Successfully started and verified server with node-pty. PID: ${pid}`);
        return ok(textPayload(JSON.stringify({
            label: label, pid: pid, status: 'running',
            message: `Development server labeled "${label}" started successfully and is running.`,
            initialLogs: initialLogs, logLinesReturned: initialLogs.length,
            monitoring_hint: `Use 'check_dev_server_status' for updates. Max ${MAX_STORED_LOG_LINES} logs stored.`
        }, null, 2)));

    } catch (error: unknown) { // Outer catch for errors *after* successful spawn call
        log.error(label, '!!! OUTER CATCH BLOCK: Error occurred after successful node-pty spawn call !!!');
        log.error(label, 'Outer Catch Error Object:', error);
        const finalErrorMsg = stripAnsiSafe(error instanceof Error ? error.message : String(error));
        let currentStatus: ServerStatus = 'error';
        let errorType = "startup_exception_after_spawn";
        let retryHint = "Manual intervention likely required.";

        log.error(label, `Formatted Outer Catch Error Msg: ${finalErrorMsg}`);

        if (runningServers.has(label)) {
            const currentInfo = runningServers.get(label);
            const statusBeforeUpdate = currentInfo?.status;
            log.debug(label, `Outer Catch: Status before update: ${statusBeforeUpdate}. Updating to '${currentStatus}'.`);
            if (currentInfo && (currentInfo.status === 'starting' || currentInfo.status === 'verifying')) {
                updateServerStatus(label, 'crashed', { error: finalErrorMsg }); // Treat post-spawn errors as crashes for retry
                currentStatus = runningServers.get(label)?.status ?? 'crashed';
                const statusAfterUpdate = currentStatus;
                log.debug(label, `Outer Catch: Status after update: ${statusAfterUpdate}.`);

                if (currentStatus === 'crashed' && currentInfo.retryCount < MAX_RETRIES) {
                    retryHint = `Startup failed after spawn. Attempting automatic restart (attempt ${currentInfo.retryCount + 1}/${MAX_RETRIES})...`;
                } else if (currentStatus === 'crashed') {
                    retryHint = `Startup failed after spawn. Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;
                }
            } else if (currentInfo) {
                currentStatus = currentInfo.status;
            }
        } else {
            log.error(label, `Outer Catch: Server info missing for label '${label}'. Cannot determine retry status.`);
            currentStatus = 'error';
            errorType = "startup_exception_no_info";
            retryHint = "Startup failed and server info lost. Manual check required.";
        }

        const response = fail(textPayload(JSON.stringify({
            error: `Failed to start server with label "${label}". Reason: ${finalErrorMsg}`,
            error_type: errorType, status: currentStatus, retry_hint: retryHint,
            startup_output_stripped: stripAnsiSafe(startupOutput).slice(-500),
        }, null, 2)));
        log.error(label, 'Outer Catch: Returning error response:', response);
        return response;
    }
}

export async function _stopServer(
    label: string,
    force: boolean,
    logLines: number
): Promise<CallToolResult> {
    let serverInfo = await checkAndUpdateStatus(label);

    if (!serverInfo) {
        return fail(textPayload(JSON.stringify({ error: `Server with label "${label}" not found.`, error_type: "not_found", status: 'not_found' }, null, 2)));
    }
    if (serverInfo.status === 'stopped' || serverInfo.status === 'crashed' || serverInfo.status === 'error') {
        const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
        const finalLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);
        const message = serverInfo.status === 'stopped'
            ? `Server "${label}" is already stopped.`
            : `Server "${label}" is already in a terminal state: ${serverInfo.status}.`;
        return ok(textPayload(JSON.stringify({ message: message, status: serverInfo.status, exitCode: serverInfo.exitCode, error: serverInfo.error, recentLogs: finalLogs, logLinesReturned: finalLogs.length }, null, 2)));
    }
    if (serverInfo.status === 'stopping') {
        return ok(textPayload(JSON.stringify({ message: `Server "${label}" is already stopping. Check status again shortly.`, status: serverInfo.status, hint: "wait_and_check_status" }, null, 2)));
    }
    if (serverInfo.status === 'restarting' || serverInfo.status === 'starting' || serverInfo.status === 'verifying') {
        return fail(textPayload(JSON.stringify({ error: `Cannot stop server "${label}" while it is ${serverInfo.status}. Wait for it to become stable or use restart.`, status: serverInfo.status, error_type: "invalid_state_for_stop" }, null, 2)));
    }
    if (!serverInfo.process || !serverInfo.pid) { // Check both process object and pid
        const errorMsg = "Cannot stop server: State is active but process handle or PID is missing.";
        updateServerStatus(label, 'error', { error: errorMsg });
        return fail(textPayload(JSON.stringify({ error: errorMsg, error_type: "internal_error_no_process_handle", status: 'error' }, null, 2)));
    }

    // Use string signal names compatible with node-pty kill
    const signal: 'SIGTERM' | 'SIGKILL' = force ? 'SIGKILL' : 'SIGTERM';
    let stopError: string | null = null;
    let signalSent = false;
    const initialPid = serverInfo.pid; // Store pid before potentially nulling process handle

    try {
        updateServerStatus(label, 'stopping');
        addLogEntry(label, 'system', `Sending ${signal} signal.`);
        if (!doesProcessExist(initialPid)) throw new Error(`Process PID ${initialPid} does not exist (already stopped?).`);

        // Use node-pty's kill method
        serverInfo.process.kill(signal);
        signalSent = true;
        addLogEntry(label, 'system', `${signal} signal sent successfully.`);
    } catch (error: unknown) {
        addLogEntry(label, 'error', `Error sending ${signal} signal: ${error instanceof Error ? error.message : String(error)}`);
        stopError = `Failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`;
        // node-pty kill doesn't throw ESRCH, check existence before sending
        // If it failed, update status to error
        updateServerStatus(label, 'error', { error: `Error during stop signal: ${stopError}` });
    }

    let finalStatus: ServerStatus = serverInfo.status;
    let verificationMessage = "";

    if (signalSent) { // Only wait if signal was actually sent
        const waitDuration = force ? 100 : STOP_WAIT_DURATION;
        addLogEntry(label, 'system', `Waiting ${waitDuration}ms for process termination confirmation...`);
        await new Promise(resolve => setTimeout(resolve, waitDuration));

        const finalServerInfo = await checkAndUpdateStatus(label);
        if (finalServerInfo) {
            serverInfo = finalServerInfo;
            finalStatus = serverInfo.status;
            if (finalStatus !== 'stopped' && finalStatus !== 'crashed' && finalStatus !== 'error') {
                if (!force) {
                    verificationMessage = `Process (PID: ${initialPid}) status is still '${finalStatus}' after SIGTERM and wait. Consider using 'force: true' (SIGKILL).`;
                    addLogEntry(label, 'warn', verificationMessage);
                    stopError = stopError || `Server did not stop gracefully within ${waitDuration}ms. Current status: ${finalStatus}.`;
                } else {
                    verificationMessage = `Process (PID: ${initialPid}) status is '${finalStatus}' even after SIGKILL and wait. Manual intervention may be required.`;
                    addLogEntry(label, 'error', verificationMessage);
                    stopError = stopError || `Server did not terminate after SIGKILL. Current status: ${finalStatus}.`;
                    updateServerStatus(label, 'error', { error: stopError });
                    finalStatus = 'error';
                }
            } else {
                verificationMessage = `Process (PID: ${initialPid}) successfully reached status '${finalStatus}'.`;
                addLogEntry(label, 'system', verificationMessage);
                if (finalStatus === 'stopped' || finalStatus === 'crashed' || finalStatus === 'error') {
                    stopError = null;
                }
            }
        } else {
            finalStatus = 'stopped';
            stopError = `${stopError ? `${stopError}; ` : ""}Server info disappeared after stop attempt.`;
            verificationMessage = "Server info missing after stop attempt. Assuming stopped.";
            addLogEntry(label, 'warn', verificationMessage);
        }
    } else {
        finalStatus = serverInfo.status;
        verificationMessage = `Signal sending failed. Reason: ${stopError}`;
        if ((finalStatus as ServerStatus) !== 'stopped' && (finalStatus as ServerStatus) !== 'crashed') {
            finalStatus = 'error';
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
        isErrorResponse = true;
    } else {
        responseMessage = `Stop attempt for server "${label}" (PID: ${initialPid}) processed. Final verified status: ${finalStatus}.`;
        if (finalStatus === 'stopped') hint = "server_stopped_successfully";
        else if (finalStatus === 'crashed') hint = "server_crashed_during_stop";
    }

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    // Use final serverInfo if available, otherwise create empty object
    const logsSource = runningServers.get(label)?.logs ?? serverInfo?.logs ?? [];
    const finalLogs = formatLogsForResponse(logsSource, linesToReturn);


    const payload = {
        message: responseMessage,
        status: finalStatus,
        label: label,
        pid: initialPid,
        exitCode: serverInfo?.exitCode ?? null,
        error: serverInfo?.error ?? stopError,
        error_type: errorType,
        hint: hint,
        recentLogs: finalLogs,
        logLinesReturned: finalLogs.length,
        logLinesHint: `Returned last ${finalLogs.length} log lines (ANSI stripped). Max stored: ${MAX_STORED_LOG_LINES}.`
    };
    const result = {
        content: [textPayload(JSON.stringify(payload, null, 2))],
        isError: isErrorResponse,
    };
    return result;
} 