import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    DEFAULT_RETURN_LOG_LINES,
    MAX_RETRIES,
    MAX_STORED_LOG_LINES,
    STOP_WAIT_DURATION,
    ZOMBIE_CHECK_INTERVAL,
} from "./constants.js";
import { _startServer, _stopServer } from "./serverLogic.js";
import {
    addLogEntry,
    checkAndUpdateStatus,
    doesProcessExist,
    getZombieCheckIntervalId,
    runningServers,
    updateServerStatus,
} from "./state.js";
import { handleToolCall } from "./toolHandler.js";
import { type CallToolResult, fail, ok, shape, textPayload } from "./types.js";
import type { ServerStatus } from "./types.js";
import { formatLogsForResponse, log } from "./utils.js";
import * as process from "node:process";

async function _checkDevServerStatus(
    label: string,
    logLines: number,
): Promise<CallToolResult> {
    const serverInfo = await checkAndUpdateStatus(label);

    if (!serverInfo) {
        return fail(
            textPayload(
                JSON.stringify(
                    {
                        error: `Server with label "${label}" not found or was never started.`,
                        status: "not_found",
                        error_type: "not_found",
                    },
                    null,
                    2,
                ),
            ),
        );
    }

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const returnedLogs = formatLogsForResponse(serverInfo.logs, linesToReturn);
    let hint = "Server status retrieved.";
    if (serverInfo.status === "restarting") {
        hint = `Server is restarting (attempt ${serverInfo.retryCount + 1}/${MAX_RETRIES}). Check back shortly.`;
    } else if (serverInfo.status === "crashed") {
        hint =
            serverInfo.retryCount < MAX_RETRIES
                ? `Server crashed. Automatic restart pending (attempt ${serverInfo.retryCount + 1}/${MAX_RETRIES}).`
                : `Server crashed. Retry limit reached (${MAX_RETRIES}). Will not restart automatically.`;
    } else if (serverInfo.status === "error") {
        hint = `Server is in unrecoverable error state. ${serverInfo.error || "Manual intervention likely required."}`;
    }

    const payload = {
        label: serverInfo.label,
        pid: serverInfo.pid,
        command: serverInfo.command,
        workingDirectory: serverInfo.cwd,
        startTime: serverInfo.startTime.toISOString(),
        status: serverInfo.status,
        exitCode: serverInfo.exitCode,
        error: serverInfo.error,
        retryCount: serverInfo.retryCount,
        hint: hint,
        logs: returnedLogs,
        logLinesReturned: returnedLogs.length,
        monitoring_hint: `Returning last ${returnedLogs.length} log lines (ANSI stripped). Max stored is ${MAX_STORED_LOG_LINES}.`,
    };
    const result = {
        content: [textPayload(JSON.stringify(payload, null, 2))],
        isError: serverInfo.status === "error" || serverInfo.status === "crashed",
    };
    return result;
}

async function _listDevServers(): Promise<CallToolResult> {
    if (runningServers.size === 0) {
        return ok(
            textPayload(
                JSON.stringify(
                    {
                        message: "No development servers are currently being managed.",
                        servers: [],
                    },
                    null,
                    2,
                ),
            ),
        );
    }

    for (const label of runningServers.keys()) {
        await checkAndUpdateStatus(label);
    }

    const serverList = Array.from(runningServers.values()).map((info) => ({
        label: info.label,
        pid: info.pid,
        command: info.command,
        workingDirectory: info.cwd,
        status: info.status,
        startTime: info.startTime.toISOString(),
        error: info.error,
        exitCode: info.exitCode,
        retryCount: info.retryCount,
    }));

    return ok(
        textPayload(
            JSON.stringify(
                {
                    message: `Found ${serverList.length} managed servers.`,
                    servers: serverList,
                },
                null,
                2,
            ),
        ),
    );
}

async function _stopAllDevServers(force: boolean): Promise<CallToolResult> {
    const results: {
        label: string;
        pid: number | null;
        initialStatus: ServerStatus;
        signalSent: boolean;
        error?: string;
        finalStatus?: ServerStatus;
    }[] = [];
    const signal: "SIGTERM" | "SIGKILL" = force ? "SIGKILL" : "SIGTERM";
    const activeLabels: string[] = [];

    log.info(null, `Attempting to stop all active servers with ${signal}...`);

    for (const [label, serverInfo] of runningServers.entries()) {
        let sentSignal = false;
        let signalError: string | undefined = undefined;
        const isActive =
            serverInfo.status === "running" ||
            serverInfo.status === "starting" ||
            serverInfo.status === "verifying" ||
            serverInfo.status === "stopping" ||
            serverInfo.status === "restarting";

        if (isActive && serverInfo.process && serverInfo.pid) {
            activeLabels.push(label);
            try {
                updateServerStatus(label, "stopping");
                addLogEntry(label, "system", `Sending ${signal} signal (stop_all).`);
                if (doesProcessExist(serverInfo.pid)) {
                    serverInfo.process.kill(signal);
                    sentSignal = true;
                } else {
                    signalError = `Process PID ${serverInfo.pid} not found when attempting stop_all.`;
                    addLogEntry(label, "warn", signalError);
                    updateServerStatus(label, "stopped", { error: signalError });
                }
            } catch (error: unknown) {
                addLogEntry(
                    label,
                    "error",
                    `Error sending ${signal} signal (stop_all): ${error instanceof Error ? error.message : String(error)}`,
                );
                signalError = `Failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`;
                updateServerStatus(label, "error", { error: signalError });
            }
        } else if (isActive && (!serverInfo.process || !serverInfo.pid)) {
            addLogEntry(
                label,
                "warn",
                `Server ${label} is active (${serverInfo.status}) but process handle/PID missing. Cannot stop.`,
            );
            signalError = "Process handle or PID missing for active server.";
            updateServerStatus(label, "error", { error: signalError });
        }
        results.push({
            label,
            pid: serverInfo.pid,
            initialStatus: serverInfo.status,
            signalSent: sentSignal,
            error: signalError,
        });
    }

    if (activeLabels.length > 0) {
        log.info(null, `Waiting ${STOP_WAIT_DURATION}ms after sending signals...`);
        await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_DURATION));
        log.info(null, "Finished waiting. Checking final statuses...");
    } else {
        log.info(null, "No active servers found to stop.");
    }

    for (const result of results) {
        if (result.error && result.finalStatus === "error") continue;

        const finalInfo = await checkAndUpdateStatus(result.label);
        if (finalInfo) {
            result.finalStatus = finalInfo.status;
            if (finalInfo.error && !result.error) {
                result.error = finalInfo.error;
            }
            if (
                result.signalSent &&
                finalInfo.status !== "stopped" &&
                finalInfo.status !== "crashed" &&
                finalInfo.status !== "error" &&
                !result.error
            ) {
                result.error = `Process still ${finalInfo.status} after ${signal} and wait.`;
            }
        } else {
            result.finalStatus = result.signalSent ? "stopped" : "error";
            result.error = `${result.error ? `${result.error}; ` : ""}Server info disappeared after stop_all attempt.`;
        }
    }

    const summary = results.reduce(
        (acc, r) => {
            const status = r.finalStatus ?? r.initialStatus;
            if (status === "stopped") acc.stopped++;
            else if (status === "crashed") acc.crashed++;
            else if (status === "error" || r.error) acc.failed++;
            else if (
                status === "running" ||
                status === "stopping" ||
                status === "restarting" ||
                status === "verifying" ||
                status === "starting"
            )
                acc.stillActive++;
            else acc.other++;
            return acc;
        },
        {
            totalAttempted: results.length,
            stopped: 0,
            crashed: 0,
            failed: 0,
            stillActive: 0,
            other: 0,
        },
    );

    const message =
        `Stop all attempt finished. Servers processed: ${summary.totalAttempted}. ` +
        `Stopped: ${summary.stopped}, Crashed: ${summary.crashed}, Failed/Error: ${summary.failed}, Still Active: ${summary.stillActive}, Other: ${summary.other}.`;
    log.info(null, message);

    const payload = {
        message: message,
        summary: summary,
        details: results.map((r) => ({
            label: r.label,
            pid: r.pid,
            initialStatus: r.initialStatus,
            signalSent: r.signalSent,
            finalStatus: r.finalStatus,
            error: r.error,
        })),
    };
    const result = {
        content: [textPayload(JSON.stringify(payload, null, 2))],
        isError: summary.failed > 0 || summary.stillActive > 0,
    };
    return result;
}

async function _restartDevServer(
    label: string,
    force: boolean,
    logLines: number,
): Promise<CallToolResult> {
    let startResult: CallToolResult | null = null;
    let stopErrorMsg: string | null = null;
    let startErrorMsg: string | null = null;
    let finalMessage = "";
    let originalCommand: string | null = null;
    let originalWorkingDirectory: string | null = null;
    type StopResultPayload = {
        status?: ServerStatus | "not_found" | "already_stopped";
        error?: string | null;
        message?: string;
    };
    let stopResultJson: StopResultPayload | null = null;
    let stopStatus: ServerStatus | "not_found" | "already_stopped" | "error" =
        "not_found";

    addLogEntry(label, "system", `Restart requested (force=${force}).`);

    const serverInfo = runningServers.get(label);

    if (serverInfo) {
        originalCommand = serverInfo.command;
        originalWorkingDirectory = serverInfo.cwd;

        if (
            serverInfo.status === "running" ||
            serverInfo.status === "starting" ||
            serverInfo.status === "verifying" ||
            serverInfo.status === "stopping" ||
            serverInfo.status === "restarting" ||
            serverInfo.status === "crashed"
        ) {
            addLogEntry(
                label,
                "system",
                `Stopping server (status: ${serverInfo.status}) before restart...`,
            );
            const stopResponse = await _stopServer(label, force, 0);

            try {
                const responseText =
                    stopResponse.content[0]?.type === "text"
                        ? stopResponse.content[0].text
                        : null;
                if (!responseText)
                    throw new Error("Stop response content is missing or not text");
                stopResultJson = JSON.parse(responseText) as StopResultPayload;
                stopStatus = stopResultJson?.status ?? "error";
                stopErrorMsg = stopResultJson?.error ?? null;

                if (stopResponse.isError && !stopErrorMsg) {
                    stopErrorMsg =
                        stopResultJson?.message || "Unknown stop error during restart";
                }

                if (
                    stopStatus === "stopped" ||
                    stopStatus === "crashed" ||
                    stopStatus === "error"
                ) {
                    addLogEntry(
                        label,
                        "system",
                        `Stop phase completed, final status: ${stopStatus}.`,
                    );
                } else {
                    stopErrorMsg =
                        stopErrorMsg ||
                        `Server status is still '${stopStatus}' after stop attempt. Cannot proceed with restart.`;
                    addLogEntry(label, "warn", stopErrorMsg);
                    stopStatus = "error";
                }
            } catch (e) {
                stopErrorMsg = `Failed to process stop server response during restart. ${e instanceof Error ? e.message : String(e)}`;
                stopStatus = "error";
                addLogEntry(label, "error", stopErrorMsg);
            }
        } else {
            stopStatus = "already_stopped";
            addLogEntry(
                label,
                "system",
                `Server was already ${serverInfo.status}. Skipping stop signal phase.`,
            );
        }
    } else {
        stopStatus = "not_found";
        stopErrorMsg = `Server with label "${label}" not found. Cannot restart.`;
        addLogEntry(label, "warn", stopErrorMsg);
    }

    const canStart =
        (stopStatus === "stopped" ||
            stopStatus === "crashed" ||
            stopStatus === "already_stopped") &&
        originalCommand &&
        originalWorkingDirectory !== null;

    if (canStart) {
        addLogEntry(label, "system", "Starting server after stop/check phase...");
        startResult = await _startServer(
            label,
            originalCommand as string,
            originalWorkingDirectory as string,
            logLines,
        );

        if (startResult.isError) {
            const responseText =
                startResult.content[0]?.type === "text"
                    ? startResult.content[0].text
                    : null;
            try {
                startErrorMsg = responseText
                    ? ((JSON.parse(responseText) as { error?: string }).error ??
                        "Unknown start error")
                    : "Unknown start error";
            } catch {
                startErrorMsg = "Failed to parse start error response.";
            }
            addLogEntry(
                label,
                "error",
                `Start phase failed during restart: ${startErrorMsg}`,
            );
            finalMessage = `Restart failed: Server stopped (or was already stopped) but failed to start. Reason: ${startErrorMsg}`;
        } else {
            addLogEntry(label, "system", "Start phase successful.");
            return startResult;
        }
    } else {
        if (!originalCommand || originalWorkingDirectory === null) {
            startErrorMsg = `Cannot start server "${label}" as original command or working directory was not found (server might not have existed or info was lost).`;
            addLogEntry(label, "error", startErrorMsg);
            finalMessage = `Restart failed: ${startErrorMsg}`;
        } else {
            finalMessage = `Restart aborted: Stop phase did not result in a state allowing restart. Final stop status: ${stopStatus}. Error: ${stopErrorMsg || "Unknown stop phase issue."}`;
        }
    }

    return fail(
        textPayload(
            JSON.stringify(
                {
                    error: finalMessage,
                    stopPhase: {
                        status: stopStatus,
                        error: stopErrorMsg,
                        hint:
                            stopStatus === "error"
                                ? "check_stop_logs"
                                : stopStatus !== "stopped" &&
                                    stopStatus !== "crashed" &&
                                    stopStatus !== "already_stopped"
                                    ? "retry_stop_with_force"
                                    : "stop_phase_ok",
                    },
                    startPhase: {
                        attempted: canStart,
                        error: startErrorMsg,
                        hint: startErrorMsg ? "check_start_logs" : undefined,
                    },
                    finalStatus: runningServers.get(label)?.status ?? stopStatus,
                },
                null,
                2,
            ),
        ),
    );
}

async function _waitForDevServer(
    label: string,
    timeoutSeconds: number,
    checkIntervalSeconds: number,
    targetStatus: string,
    logLines: number,
): Promise<CallToolResult> {
    const startTime = Date.now();
    const endTime = startTime + timeoutSeconds * 1000;
    const targetStatusTyped = targetStatus as ServerStatus;

    addLogEntry(
        label,
        "system",
        `Waiting up to ${timeoutSeconds}s for status '${targetStatus}' (checking every ${checkIntervalSeconds}s).`,
    );

    let serverInfo = await checkAndUpdateStatus(label);
    if (!serverInfo) {
        return fail(
            textPayload(
                JSON.stringify(
                    {
                        error: `Server with label "${label}" not found.`,
                        status: "not_found",
                        error_type: "not_found",
                    },
                    null,
                    2,
                ),
            ),
        );
    }

    let timedOut = false;
    let achievedTargetStatus = serverInfo.status === targetStatusTyped;
    let finalHint = "";
    let terminalStateReached = false;

    while (
        !achievedTargetStatus &&
        Date.now() < endTime &&
        !terminalStateReached
    ) {
        await new Promise((resolve) =>
            setTimeout(resolve, checkIntervalSeconds * 1000),
        );
        serverInfo = await checkAndUpdateStatus(label);
        if (!serverInfo) {
            addLogEntry(
                label,
                "error",
                `Server info for "${label}" disappeared during wait.`,
            );
            return fail(
                textPayload(
                    JSON.stringify(
                        {
                            error: `Server with label "${label}" disappeared during wait. Cannot determine status.`,
                            status: "unknown",
                            error_type: "disappeared_during_wait",
                        },
                        null,
                        2,
                    ),
                ),
            );
        }
        achievedTargetStatus = serverInfo.status === targetStatusTyped;

        if (
            serverInfo.status === "crashed" ||
            serverInfo.status === "error" ||
            serverInfo.status === "stopped"
        ) {
            if (serverInfo.status !== targetStatusTyped) {
                terminalStateReached = true;
                addLogEntry(
                    label,
                    "warn",
                    `Wait aborted: Server entered terminal state '${serverInfo.status}' while waiting for '${targetStatus}'.`,
                );
            }
        }
    }

    if (achievedTargetStatus) {
        addLogEntry(
            label,
            "system",
            `Successfully reached target status '${targetStatus}'.`,
        );
        finalHint = `Wait successful. Server reached target status '${targetStatus}'.`;
    } else if (terminalStateReached) {
        finalHint = `Wait ended prematurely. Server reached terminal state '${serverInfo.status}' instead of target '${targetStatus}'.`;
    } else if (Date.now() >= endTime) {
        timedOut = true;
        addLogEntry(
            label,
            "warn",
            `Timed out after ${timeoutSeconds}s waiting for status '${targetStatus}'. Current status: '${serverInfo.status}'.`,
        );
        finalHint = `Wait timed out after ${timeoutSeconds}s. Server is currently ${serverInfo.status}.`;
    } else {
        finalHint = `Wait ended unexpectedly. Current status: '${serverInfo.status}', Target: '${targetStatus}'.`;
    }

    const linesToReturn = Math.min(logLines, MAX_STORED_LOG_LINES);
    const latestServerInfo = runningServers.get(label);
    const finalLogs = formatLogsForResponse(
        latestServerInfo?.logs ?? serverInfo.logs,
        linesToReturn,
    );
    const finalServerStatus = latestServerInfo?.status ?? serverInfo.status;

    const responsePayload = {
        label: serverInfo.label,
        pid: serverInfo.pid,
        command: serverInfo.command,
        workingDirectory: serverInfo.cwd,
        startTime: serverInfo.startTime.toISOString(),
        status: finalServerStatus,
        targetStatus: targetStatus,
        waitResult: achievedTargetStatus
            ? "success"
            : terminalStateReached
                ? "wrong_state"
                : timedOut
                    ? "timed_out"
                    : "unknown",
        exitCode: serverInfo.exitCode,
        error: serverInfo.error,
        hint: finalHint,
        waitedSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
        timeoutSetting: timeoutSeconds,
        logs: finalLogs,
        logLinesReturned: finalLogs.length,
        monitoring_hint: `Wait complete. Final status: '${finalServerStatus}'. ${finalHint}`,
    };

    const result = {
        content: [textPayload(JSON.stringify(responsePayload, null, 2))],
        isError:
            (timedOut &&
                targetStatusTyped !== "stopped" &&
                targetStatusTyped !== "crashed" &&
                targetStatusTyped !== "error") ||
            terminalStateReached ||
            finalServerStatus === "error" ||
            finalServerStatus === "crashed",
    };
    return result;
}

async function _healthCheck(): Promise<CallToolResult> {
    log.info(null, "Performing health check...");

    const issues: string[] = [];
    let overallStatus: "OK" | "Warning" | "Error" = "OK";

    const statusCounts: Record<ServerStatus | "total", number> = {
        starting: 0,
        verifying: 0,
        running: 0,
        stopping: 0,
        stopped: 0,
        restarting: 0,
        crashed: 0,
        error: 0,
        total: runningServers.size,
    };
    let activePtyHandles = 0;
    let potentialZombieCount = 0;
    const highRetryServers: string[] = [];
    const leakedHandleServers: string[] = [];

    for (const label of runningServers.keys()) {
        await checkAndUpdateStatus(label);
    }

    for (const [label, serverInfo] of runningServers.entries()) {
        if (serverInfo.status in statusCounts) {
            statusCounts[serverInfo.status]++;
        }

        const isActiveState =
            serverInfo.status === "running" ||
            serverInfo.status === "starting" ||
            serverInfo.status === "verifying" ||
            serverInfo.status === "restarting" ||
            serverInfo.status === "stopping";

        if (serverInfo.process) {
            activePtyHandles++;
            if (!isActiveState && serverInfo.status !== "error") {
                leakedHandleServers.push(label);
                issues.push(
                    `Potential handle leak: Server '${label}' is ${serverInfo.status} but still has a process handle.`,
                );
                overallStatus = "Error";
            }
        }

        if (isActiveState && serverInfo.pid) {
            if (!doesProcessExist(serverInfo.pid)) {
                potentialZombieCount++;
                issues.push(
                    `Potential zombie: Server '${label}' is ${serverInfo.status} but process PID ${serverInfo.pid} not found. Status should be updated soon.`,
                );
                if (overallStatus !== "Error") overallStatus = "Warning";
            }
        }

        if (serverInfo.status === "error") {
            issues.push(
                `Server '${label}' is in error state: ${serverInfo.error || "No details"}`,
            );
            if (overallStatus !== "Error") overallStatus = "Warning";
        }

        if (serverInfo.retryCount > 0) {
            const retryThreshold = Math.ceil(MAX_RETRIES / 2);
            const message = `Server '${label}' has retry count ${serverInfo.retryCount}/${MAX_RETRIES}.`;
            issues.push(message);
            if (serverInfo.retryCount >= retryThreshold && overallStatus !== "Error") {
                overallStatus = "Warning";
            }
            if (serverInfo.retryCount >= MAX_RETRIES) {
                overallStatus = "Error";
            }
            highRetryServers.push(label);
        }
    }

    const zombieCheckRunning = !!getZombieCheckIntervalId();
    if (!zombieCheckRunning) {
        issues.push("Zombie check interval is not running.");
        overallStatus = "Error";
    }

    const memoryUsage = process.memoryUsage();
    const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    const memoryInfo = {
        rss: formatBytes(memoryUsage.rss),
        heapTotal: formatBytes(memoryUsage.heapTotal),
        heapUsed: formatBytes(memoryUsage.heapUsed),
        external: formatBytes(memoryUsage.external),
    };

    const payload = {
        healthStatus: overallStatus,
        timestamp: new Date().toISOString(),
        serverSummary: {
            totalManaged: statusCounts.total,
            statusCounts: { ...statusCounts },
            activePtyHandles: activePtyHandles,
        },
        potentialIssues: {
            count: issues.length,
            details: issues,
            serversInErrorState: statusCounts.error,
            serversWithHighRetries: highRetryServers.length,
            potentialZombiesDetected: potentialZombieCount,
            potentialLeakedHandles: leakedHandleServers.length,
        },
        internalChecks: {
            zombieCheckIntervalRunning: zombieCheckRunning,
            zombieCheckIntervalMs: ZOMBIE_CHECK_INTERVAL,
        },
        resourceUsage: {
            memory: memoryInfo,
        },
    };

    log.info(null, `Health check completed with status: ${overallStatus}`);

    return {
        content: [textPayload(JSON.stringify(payload, null, 2))],
        isError: overallStatus === "Error",
    };
}

export function registerToolDefinitions(server: McpServer): void {
    const startDevServerSchema = z.object({
        label: z
            .string()
            .min(1)
            .describe(
                "A unique label to identify this server instance (e.g., 'frontend', 'backend-api'). Must be unique.",
            ),
        command: z
            .string()
            .min(1)
            .describe(
                "The command to execute (e.g., 'npm run dev', 'pnpm start', 'yarn serve')",
            ),
        workingDirectory: z
            .string()
            .optional()
            .describe(
                "The **absolute** working directory to run the command from. **Do not use relative paths like '.'**. Provide the full path (e.g., '/Users/me/myproject'). If omitted, defaults to the MCP workspace root or the CWD of the server process, but providing the full path explicitly is strongly recommended.",
            ),
        logLines: z
            .number()
            .int()
            .positive()
            .optional()
            .default(DEFAULT_RETURN_LOG_LINES)
            .describe(
                `Number of initial log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`,
            ),
    });
    type StartDevServerParams = z.infer<typeof startDevServerSchema>;

    server.tool(
        "start_dev_server",
        "Starts a development server in the background using a specified command and assigns it a unique label. Returns status and initial logs (ANSI codes stripped). Handles verification and basic crash detection/retry.",
        shape(startDevServerSchema.shape),
        (params: StartDevServerParams) =>
            handleToolCall(params.label, "start_dev_server", params, () =>
                _startServer(
                    params.label,
                    params.command,
                    params.workingDirectory,
                    params.logLines,
                ),
            ),
    );

    const checkDevServerStatusSchema = z.object({
        label: z
            .string()
            .min(1)
            .describe("The unique label of the server to check."),
        logLines: z
            .number()
            .int()
            .positive()
            .optional()
            .default(DEFAULT_RETURN_LOG_LINES)
            .describe(
                `Number of recent log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`,
            ),
    });
    type CheckDevServerStatusParams = z.infer<typeof checkDevServerStatusSchema>;

    server.tool(
        "check_dev_server_status",
        "Checks the status and recent logs (ANSI codes stripped) of a development server using its label. Verifies if the process still exists.",
        shape(checkDevServerStatusSchema.shape),
        (params: CheckDevServerStatusParams) =>
            handleToolCall(params.label, "check_dev_server_status", params, () =>
                _checkDevServerStatus(params.label, params.logLines),
            ),
    );

    const stopDevServerSchema = z.object({
        label: z
            .string()
            .min(1)
            .describe("The unique label of the server to stop."),
        force: z
            .boolean()
            .optional()
            .default(false)
            .describe(
                "If true, use SIGKILL for immediate termination instead of SIGTERM.",
            ),
        logLines: z
            .number()
            .int()
            .positive()
            .optional()
            .default(DEFAULT_RETURN_LOG_LINES)
            .describe(
                `Number of recent log lines to return (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`,
            ),
    });
    type StopDevServerParams = z.infer<typeof stopDevServerSchema>;

    server.tool(
        "stop_dev_server",
        "Stops a specific development server using its label and verifies the stop. Returns final status and recent logs (ANSI codes stripped). Handles stop timeouts.",
        shape(stopDevServerSchema.shape),
        (params: StopDevServerParams) =>
            handleToolCall(params.label, "stop_dev_server", params, () =>
                _stopServer(params.label, params.force, params.logLines),
            ),
    );

    server.tool(
        "list_dev_servers",
        "Lists all currently managed development servers and their statuses.",
        {},
        () => handleToolCall(null, "list_dev_servers", {}, _listDevServers),
    );

    const stopAllDevServersSchema = z.object({
        force: z
            .boolean()
            .optional()
            .default(false)
            .describe(
                "If true, use SIGKILL for immediate termination instead of SIGTERM.",
            ),
    });
    type StopAllDevServersParams = z.infer<typeof stopAllDevServersSchema>;

    server.tool(
        "stop_all_dev_servers",
        "Stops all currently running or starting development servers managed by this tool and verifies.",
        shape(stopAllDevServersSchema.shape),
        (params: StopAllDevServersParams) =>
            handleToolCall(null, "stop_all_dev_servers", params, () =>
                _stopAllDevServers(params.force),
            ),
    );

    const restartDevServerSchema = z.object({
        label: z
            .string()
            .min(1)
            .describe("The unique label of the server to restart."),
        force: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, use SIGKILL for the stop phase instead of SIGTERM."),
        logLines: z
            .number()
            .int()
            .positive()
            .optional()
            .default(DEFAULT_RETURN_LOG_LINES)
            .describe(
                `Number of initial log lines to return from the start phase (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`,
            ),
    });
    type RestartDevServerParams = z.infer<typeof restartDevServerSchema>;

    server.tool(
        "restart_dev_server",
        "Stops (if running) and then starts a development server with the same configuration. Returns final status and initial logs from the start phase.",
        shape(restartDevServerSchema.shape),
        (params: RestartDevServerParams) =>
            handleToolCall(params.label, "restart_dev_server", params, () =>
                _restartDevServer(params.label, params.force, params.logLines),
            ),
    );

    const waitForDevServerSchema = z.object({
        label: z
            .string()
            .min(1)
            .describe("The unique label of the server to wait for."),
        timeoutSeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .default(5)
            .describe(
                "Maximum time in seconds to wait for the server to reach the target status (e.g., allow 5s for reload/startup). Default: 5s.",
            ),
        checkIntervalSeconds: z
            .number()
            .positive()
            .optional()
            .default(1)
            .describe(
                "How often to check the server status in seconds during the wait. Default: 1s.",
            ),
        targetStatus: z
            .string()
            .optional()
            .default("running")
            .describe(
                "The desired status to wait for (e.g., 'running', 'stopped'). Default: 'running'.",
            ),
        logLines: z
            .number()
            .int()
            .positive()
            .optional()
            .default(DEFAULT_RETURN_LOG_LINES)
            .describe(
                `Number of recent log lines to return upon completion or timeout (default: ${DEFAULT_RETURN_LOG_LINES}, max stored: ${MAX_STORED_LOG_LINES}).`,
            ),
    });
    type WaitForDevServerParams = z.infer<typeof waitForDevServerSchema>;

    server.tool(
        "wait_for_dev_server",
        "Waits for a specific development server to reach a target status (usually 'running' after a start/restart) within a timeout. Checks status periodically. Use this after starting or restarting a server to ensure it's ready before proceeding.",
        shape(waitForDevServerSchema.shape),
        (params: WaitForDevServerParams) =>
            handleToolCall(params.label, "wait_for_dev_server", params, () =>
                _waitForDevServer(
                    params.label,
                    params.timeoutSeconds,
                    params.checkIntervalSeconds,
                    params.targetStatus,
                    params.logLines,
                ),
            ),
    );

    server.tool(
        "health_check",
        "Provides an overall health status of the MCP Dev Server Manager itself, including managed process counts, resource usage, zombie check status, and potential issues like leaks or crash loops.",
        {},
        () => handleToolCall(null, "health_check", {}, _healthCheck),
    );
}
