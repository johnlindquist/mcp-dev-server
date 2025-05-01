Okay, here is a step-by-step guide to implement the `host` parameter tracking and conditional instructions feature for the `start_process` tool in the `mcp-pm` project.

**Goal:**
1.  Track the "host" (e.g., "cursor", "claude") that initiates a process via `start_process`.
2.  Restrict the allowed host values.
3.  If the host is "cursor", return specific instructions in the `start_process` response for handling the `tail_command`.

---

**Step 1: Define Host Enum and Update Zod Schema**

1.  **File:** `src/toolDefinitions.ts`
2.  **Action:** Define a Zod enum for the allowed host values and add it as an optional parameter to the `StartProcessParams` schema with a default value.
3.  **Code:**

    ```typescript
    // src/toolDefinitions.ts
    import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { z } from "zod";
    // ... other imports ...
    import { log } from "./utils.js";

    // Define the allowed host values using z.enum
    export const HostEnum = z.enum([
    	"cursor",
    	"claude",
    	"chatgpt",
    	"vscode",
    	"windsurf",
    	"unknown", // Default value
    ]);
    export type HostEnumType = z.infer<typeof HostEnum>;

    // ... existing labelSchema and shape function ...

    const StartProcessParams = z.object(
    	shape({
    		label: labelSchema
    			.optional()
    			.describe(
    				"Optional human-readable identifier (e.g. 'dev-server'). Leave blank to let the server generate one based on CWD and command.",
    			),
    		command: z
    			.string()
    			.min(1)
    			.describe("The command to execute. e.g., 'npm' or some other runner"),
    		args: z
    			.array(z.string())
    			.optional()
    			.default([])
    			.describe(
    				"Optional arguments for the command, e.g. 'npm run dev' would be ['run', 'dev']",
    			),
    		workingDirectory: z
    			.string()
    			.min(1)
    			.describe(
    				"The absolute working directory to run the command from. This setting is required. Do not use relative paths like '.' or '../'. Provide the full path (e.g., /Users/me/myproject).",
    			),
            // --- ADD THE NEW HOST PARAMETER ---
    		host: HostEnum.optional()
    			.default("unknown")
    			.describe(
    				"Identifier for the client initiating the process (e.g., 'cursor', 'claude', 'vscode'). Defaults to 'unknown'."
    			),
            // --- END ADD ---
    		verification_pattern: z
    			.string()
    			.optional()
    			.describe(
    				"Optional regex pattern to match in stdout/stderr to verify successful startup. e.g., 'running on port 3000' or 'localhost'",
    			),
    		// ... rest of StartProcessParams ...
    	}),
    );

    export type StartProcessParamsType = z.infer<typeof StartProcessParams>;

    // ... rest of the file ...
    ```

---

**Step 2: Update ProcessInfo Type**

1.  **File:** `src/types.ts`
2.  **Action:** Add the `host` field to the `ProcessInfo` interface to store the host value for each managed process. Import the `HostEnumType`.
3.  **Code:**

    ```typescript
    // src/types.ts
    import type * as fs from "node:fs";
    import type { IPty } from "node-pty";
    import type { IDisposable } from "node-pty";
    import { z } from "zod";
    import { ProcessInfo as OriginalProcessInfo } from "@cursor/types";
    import type { ChildProcessWithoutNullStreams } from "node:child_process";
    import type { HostEnumType } from "./toolDefinitions.js"; // <-- IMPORT HostEnumType

    // ... existing type definitions (TextContent, ToolContent, etc.) ...

    /** Represents the current state of a managed process. */
    export type ProcessStatus =
    	| "starting"
    	| "running"
    	| "verifying"
    	| "stopped"
    	| "crashed"
    	| "error"
    	| "restarting"
    	| "stopping";

    /** Represents a single log entry with timestamp and content. */
    export interface LogEntry {
    	timestamp: number;
    	content: string;
    }

    /** Detailed information about a managed process. */
    export interface ProcessInfo extends OriginalProcessInfo {
    	label: string;
    	command: string;
    	args: string[];
    	cwd: string;
        host: HostEnumType; // <-- ADD host FIELD
    	status: ProcessStatus;
    	logs: LogEntry[];
    	pid?: number;
    	process: IPty | null;
        // ... rest of ProcessInfo fields ...
    }

    // ... rest of the file ...
    ```

---

**Step 3: Update Start Process Response Schema**

1.  **File:** `src/types.ts`
2.  **Action:** Add the optional `instructions` field to the `StartSuccessPayloadSchema`.
3.  **Code:**

    ```typescript
    // src/types.ts
    // ... other imports and types ...

    // Schema for start_process success payload
    export const StartSuccessPayloadSchema = ProcessStatusInfoSchema.extend({
    	message: z.string().describe("Summary message indicating the outcome."),
    	logs: z
    		.array(z.string())
    		.describe("Initial block of logs captured during startup or settling."),
    	monitoring_hint: z
    		.string()
    		.describe(
    			"Instructions for monitoring. If file logging is enabled, provides the 'tail' command phrased as an instruction ('If you requested to tail... run this command...'). Otherwise, directs to check_process_status.",
    		),
    	log_file_path: z
    		.string()
    		.nullable()
    		.optional()
    		.describe("Absolute path to the log file, if logging to file is enabled."),
    	tail_command: z
    		.string()
    		.nullable()
    		.optional()
    		.describe(
    			"The specific command to run in a terminal to tail the log file, if available (e.g., 'tail -f /path/to/log'). Null if file logging is disabled.",
    		),
    	info_message: z
    		.string()
    		.optional()
    		.describe(
    			"Optional secondary message providing technical details about startup (e.g., log settling status, timeouts).",
    		),
        // --- ADD INSTRUCTIONS FIELD ---
        instructions: z
            .string()
            .optional()
            .describe(
                "Optional instructions for the host client (e.g., suggesting running the tail_command in a background terminal if host is 'cursor')."
            ),
        // --- END ADD ---
    }).describe("Response payload for a successful start_process call.");

    // ... rest of the file ...
    ```

---

**Step 4: Modify `_startProcess` Logic**

1.  **File:** `src/processLogic.ts`
2.  **Action:**
    *   Update the `_startProcess` function signature to accept the `host` parameter.
    *   Store the `host` in the `ProcessInfo` object when creating/updating it.
    *   Add logic before returning the success payload to conditionally create the `instructions` string if `host` is "cursor" and `tailCommand` exists.
    *   Include the `instructions` field in the success payload.
3.  **Code:**

    ```typescript
    // src/processLogic.ts
    // ... other imports ...
    import type { HostEnumType } from "./toolDefinitions.js"; // <-- IMPORT HostEnumType
    import type {
    	CallToolResult,
    	// ... other types ...
        StartSuccessPayloadSchema,
        StartErrorPayloadSchema,
        // ...
    } from "./types.ts"; // Renamed types

    // ... _waitForLogSettleOrTimeout function ...

    /**
     * Internal function to start a background process.
     * Handles process spawning, logging, status updates, verification, and retries.
     */
    export async function _startProcess(
    	label: string,
    	command: string,
    	args: string[],
    	workingDirectoryInput: string | undefined,
        host: HostEnumType, // <-- ADD host PARAMETER
    	verificationPattern: RegExp | undefined,
    	verificationTimeoutMs: number | undefined,
    	retryDelayMs: number | undefined,
    	maxRetries: number | undefined,
    	isRestart = false,
    ): Promise<CallToolResult> {
    	const effectiveWorkingDirectory = workingDirectoryInput
    		? path.resolve(workingDirectoryInput)
    		: process.env.MCP_WORKSPACE_ROOT || process.cwd();

    	log.info(
    		label,
    		`Starting process... Command: "${command}", Args: [${args.join(", ")}], CWD: "${effectiveWorkingDirectory}", Host: ${host}, isRestart: ${isRestart}`, // Log host
    	);

        // ... directory verification, conflict checks, etc. ...

        // --- Add host to ProcessInfo when creating/updating ---
        const processInfo: ProcessInfo = {
            label,
            pid: ptyProcess.pid,
            process: ptyProcess,
            command,
            args,
            cwd: effectiveWorkingDirectory,
            host: host, // <-- STORE host
            logs: existingProcess && isRestart ? existingProcess.logs : [],
            status: "starting",
            // ... rest of ProcessInfo fields ...
        };
        managedProcesses.set(label, processInfo);
        // ...

    	// ... PTY spawning, command writing, verification logic, log handling, exit handling ...

        // --- Wait for settling or timeout ---
        const { settled, timedOut } = await _waitForLogSettleOrTimeout(
            label,
            ptyProcess,
        );
        // --- End Wait ---

    	// --- Determine Final Status and Message ---
        // ... logic to determine finalStatus and message ...
    	const currentInfoAfterWait = managedProcesses.get(label);
        if (!currentInfoAfterWait) {
             // ... handle error ...
             return fail(/* ... */);
        }
        let finalStatus = currentInfoAfterWait.status;
        let message = "Process started."; // Default message
        // ... update finalStatus and message based on verification/settling results ...
        log.info(label, `Final status after settling/wait: ${finalStatus}`);
        // ... format logsToReturn ...
        // --- End Determine Final Status and Message ---

    	// --- Construct Payload ---
        const logsToReturn = formatLogsForResponse(
            currentInfoAfterWait.logs.map((l) => l.content),
            currentInfoAfterWait.logs.length,
        );
        const tailCommand = getTailCommand(currentInfoAfterWait.logFilePath);

        // ... construct monitoringHint ...
        let monitoringHint: string;
        if (tailCommand) {
            monitoringHint = `If you requested to tail the '${label}' process, please run this command in a separate background terminal: ${tailCommand}. For status updates or recent inline logs, use check_process_status('${label}').`;
        } else {
            monitoringHint = `For status updates or recent inline logs, use check_process_status('${label}'). File logging is not enabled for this process.`;
        }

        const infoMessage = message; // Details about settling/timeout

        // --- Conditionally Create Instructions ---
        let instructions: string | undefined = undefined;
        if (host === 'cursor' && tailCommand) {
            instructions = `Please start a background terminal named "${label}" and run the following command in it: ${tailCommand}`;
            log.info(label, "Generating specific instructions for host 'cursor'.");
        }
        // --- End Instructions Logic ---

    	// Construct the final payload, including instructions
    	const successPayload: z.infer<typeof StartSuccessPayloadSchema> = {
    		label,
    		message: `Process "${label}" started with status: ${finalStatus}.`,
    		status: finalStatus,
    		pid: currentInfoAfterWait.pid,
    		command: command,
    		args: args,
    		cwd: effectiveWorkingDirectory,
    		logs: logsToReturn,
    		monitoring_hint: monitoringHint,
    		log_file_path: currentInfoAfterWait.logFilePath,
    		tail_command: tailCommand,
    		info_message: infoMessage,
            instructions: instructions, // <-- INCLUDE instructions field
    		exitCode: currentInfoAfterWait.exitCode ?? null,
    		signal: currentInfoAfterWait.signal ?? null,
    	};
        // ...

    	// If final status is error/crashed, return failure, otherwise success
        if (["error", "crashed"].includes(finalStatus)) {
             // ... handle failure return ...
             const errorPayload: z.infer<typeof StartErrorPayloadSchema> = { /* ... */ };
             return fail(textPayload(JSON.stringify(errorPayload, null, 2)));
        }

    	return ok(textPayload(JSON.stringify(successPayload, null, 2))); // Ensure payload is stringified
    }

    // ... _stopProcess function ...
    // ... _sendInput function ...
    ```

---

**Step 5: Update Tool Registration**

1.  **File:** `src/toolDefinitions.ts`
2.  **Action:** Pass the `host` parameter from the incoming tool call arguments to the `_startProcess` function.
3.  **Code:**

    ```typescript
    // src/toolDefinitions.ts
    // ... imports ...
    import { _sendInput, _startProcess, _stopProcess } from "./processLogic.js"; // Ensure HostEnumType is exported or imported if needed here
    import type { HostEnumType } from "./toolDefinitions.js"; // Import if needed
    // ... other imports/definitions ...

    export function registerToolDefinitions(server: McpServer): void {
    	server.tool(
    		"start_process",
    		"Starts a background process (like a dev server or script) and manages it.",
    		shape(StartProcessParams.shape),
    		(params: z.infer<typeof StartProcessParams>) => {
    			const cwdForLabel = params.workingDirectory;
    			const effectiveLabel = params.label || `${cwdForLabel}:${params.command}`;
    			const hostValue = params.host; // Get the host value

    			log.info(
    				effectiveLabel,
    				`Determined label for start_process: ${effectiveLabel}`,
    			);

    			return handleToolCall(
    				effectiveLabel,
    				"start_process",
    				params,
    				async () => {
    					const verificationPattern = params.verification_pattern
    						? new RegExp(params.verification_pattern)
    						: undefined;

    					return await _startProcess(
    						effectiveLabel,
    						params.command,
    						params.args,
    						params.workingDirectory,
                            hostValue, // <-- PASS host value
    						verificationPattern,
    						params.verification_timeout_ms,
    						params.retry_delay_ms,
    						params.max_retries,
    						false, // isRestart
    					);
    				},
    			);
    		},
    	);

        // ... other tool registrations ...
    }
    ```

---

**Step 6: Update Documentation**

1.  **File:** `README.md`
2.  **Action:**
    *   Add the `host` parameter to the `start_process` tool description.
    *   List the possible values and the default.
    *   Add the `instructions` field to the `start_process` return description and explain when it appears.
3.  **Code Snippets (Additions/Modifications to README.md):**

    ```markdown
    ### `start_process`

    Starts a background process (like a dev server or script) and manages it.

    **Parameters:**

    *   `command` (string, required): The command to execute.
    *   `workingDirectory` (string, required): The absolute working directory...
    *   `label` (string, optional): Optional human-readable identifier...
    *   `args` (array of strings, optional, default: `[]`): Optional arguments...
    *   `host` (string, optional, enum: `"cursor"`, `"claude"`, `"chatgpt"`, `"vscode"`, `"windsurf"`, `"unknown"`, default: `"unknown"`): Identifier for the client initiating the process. Helps tailor responses or instructions.
    *   `verification_pattern` (string, optional): Optional regex pattern...
    *   `verification_timeout_ms` (integer, optional, default: `-1`): Milliseconds to wait...
    *   `retry_delay_ms` (integer, optional, default: 1000): Optional delay...
    *   `max_retries` (integer, optional, default: 3): Optional maximum number...

    **Returns:** (JSON)

    Response payload for a successful start_process call. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `message`, `logs`, `monitoring_hint`, `info_message`.
    *   `instructions` (string, optional): If the `host` was specified as `"cursor"` and file logging is enabled, this field will contain a suggested instruction for the Cursor IDE, like starting a background terminal to run the `tail_command`.
    On failure, returns an error object...

    **Example Usage:**

    ```json
    {
      "command": "npm",
      "args": ["run", "dev"],
      "workingDirectory": "/path/to/my-web-app",
      "label": "webapp-dev-server",
      "host": "cursor", // Specifying the host
      "verification_pattern": "ready - started server on",
      "verification_timeout_ms": 30000
    }
    ```
    ```

---

**Step 7: Build and Test**

1.  **Action:** Rebuild the project.
    ```bash
    npm run build
    # or pnpm build
    ```
2.  **Action:** Test the changes:
    *   Use the MCP Inspector (`npm run inspector`) or your test suite.
    *   Call `start_process` *without* the `host` parameter. Verify the `host` defaults to "unknown" internally (check logs if possible) and the `instructions` field is absent in the response.
    *   Call `start_process` with `host: "claude"`. Verify the `instructions` field is absent.
    *   Call `start_process` with `host: "cursor"`. Verify the `instructions` field *is present* in the response and contains the correct text referencing the label and the `tail_command`.
    *   Ensure processes still start, stop, and report status correctly.

---

This guide covers the necessary code modifications and documentation updates to implement the requested feature. Remember to rebuild after making changes and test thoroughly.