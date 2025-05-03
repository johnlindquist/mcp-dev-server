# MCP Process Manager (mcp-pm)

[![NPM version](https://img.shields.io/npm/v/mcp-pm.svg)](https://www.npmjs.com/package/mcp-pm)

A **Model Context Protocol (MCP)** server designed to reliably manage background processes (like development servers, build scripts, test watchers, etc.) on behalf of AI agents or other tools.

It allows MCP-compatible clients to start, monitor, retrieve logs from, and stop long-running tasks in a structured way.

## Add to Cursor

```json
"mcp-pm": {
  "command": "npx",
  "args": ["mcp-pm@latest"]
}
```

## Features

*   **Start Processes:** Launch new background processes using shell commands within specified working directories.
*   **Monitor Status:** Check if processes are starting, running, verifying, stopped, restarting, crashed, or in an error state.
*   **View Logs:** Retrieve recent output (stdout/stderr) from managed processes.
*   **Stop Processes:** Gracefully terminate (SIGTERM) or forcefully kill (SIGKILL) specific processes.
*   **Stop All:** Terminate all processes managed by the server instance.
*   **Restart Processes:** Conveniently stop and then restart a specific process.
*   **Wait for Status:** Pause execution until a process reaches a desired state (e.g., 'running').
*   **Optional Labels:** Provide a custom label for a process or let the server generate one based on the command and working directory.
*   **Automatic Cleanup:** Includes basic zombie process detection and attempts to terminate managed processes on shutdown.
*   **Stronger Cursor-tail instructions:** Enhanced instructions for Cursor IDE users when starting background processes.
*   **Automatic Purging:** Stopped processes are automatically purged from the process list; querying a purged process returns a stopped status and empty logs.

---

<blockquote style="border-left: 6px solid #222; background: #fff3cd; color: #222; padding: 28px 32px; margin: 32px 0; border-radius: 10px; text-align: center;">
  <div style="font-size: 1.5em; font-weight: bold; margin-bottom: 8px; color: #222;">
    🚀 Want to Become a <span style="color:#0d6efd;">Cursor Pro</span>? 🏆
  </div>
  <div style="font-size: 1.1em; margin-bottom: 10px; color: #222;">
    Unlock advanced workflows, tips, and real-world AI dev strategies in Cursor.<br>
    <strong>I teach semi-weekly workshops live on Thursdays.</strong>
  </div>
  <a href="https://egghead.io/workshop/cursor" style="display: inline-block; background: #0d6efd; color: #fff; font-weight: bold; font-size: 1.15em; padding: 14px 28px; border-radius: 6px; text-decoration: none; margin-top: 8px; box-shadow: 0 2px 8px rgba(13,110,253,0.10);">
    👉 Click here to learn more!
  </a>
</blockquote>

---

## Available Tools

This server exposes the following tools for MCP clients:

*   `start_process`: Starts a new background process. (Label is optional)
*   `start_process_with_verification`: Starts a new background process with verification, timeout, and retry options. (Label is optional)
*   `check_process_status`: Checks the status and logs of a specific process. (Requires label)
*   `stop_process`: Stops a specific process. (Requires label)
*   `list_processes`: Lists all currently managed processes and their basic status.
*   `stop_all_processes`: Attempts to stop all managed processes.
*   `restart_process`: Restarts a specific process. (Requires label)
*   `wait_for_process`: Waits for a specific process to reach a target status. (Requires label)
*   `get_all_loglines`: Retrieves the complete stored log history for a specific managed process. (Requires label)
*   `send_input`: Sends text input to the stdin of a running process. (Requires label)
*   `health_check`: Provides a status summary of the process manager itself.

## Quick Start: Running the Server

The easiest way to run the MCP Process Manager is using `npx`, which ensures you're using the latest published version without needing a manual installation.

1.  **Open your terminal.**
2.  **Run the server:**
    ```bash
    npx mcp-pm
    ```
3.  **Server is running:** The command will download (if needed) and execute the `mcp-pm` server. It will print initialization logs to stderr and then wait, listening for MCP messages on standard input (stdin) and sending responses to standard output (stdout).

Your MCP client or orchestrator can now be configured to communicate with this process via its stdio streams.

## Development Setup

If you want to modify the server or contribute to its development:

**Prerequisites:**

*   Node.js (v20.x or later recommended)
*   npm (usually included with Node.js) or pnpm

**Steps:**

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/johnlindquist/mcp-pm.git # Replace with actual repo URL
    cd mcp-pm
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or if using pnpm:
    # pnpm install
    ```

3.  **Build the project:**
    This compiles the TypeScript code into JavaScript in the `build/` directory.
    ```bash
    npm run build
    ```

4.  **Run the built server locally:**
    Execute the compiled code directly using Node.
    ```bash
    node build/index.js
    ```
    The server will start and listen on stdio, just like the `npx` version.

5.  **(Optional) Watch for changes:**
    For active development, you can run the watch script. This will automatically rebuild the project when you save changes to source files (`src/**/*.ts`).
    ```bash
    npm run watch
    ```
    You'll need to manually restart the `node build/index.js` process after each rebuild to run the updated code.

**Development Notes:**
- The codebase has been modularized for clarity and maintainability.
- Types and constants are now centralized.
- Integration and unit tests are split for clarity and speed.
- All tests and helpers expect the MCP result format (`result.content[]`).
- Type safety and MCP compliance are strictly enforced throughout the codebase.

## Technology Stack

*   Node.js / TypeScript
*   `@modelcontextprotocol/sdk`: Core MCP server framework.
*   `node-pty`: For robust pseudo-terminal process management.
*   `zod`: For runtime validation of tool parameters.
*   `biomejs`: For formatting and linting.
*   `semantic-release`: For automated versioning and publishing.

## MCP Compliance

This project strictly follows the official Model Context Protocol (MCP) standard for tool responses and type usage:

- **All tool result/content types are imported directly from [`@modelcontextprotocol/sdk/types.js`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) (with `.js` for ESM compatibility).**
- **No custom type definitions for tool results or content are allowed.**
- **All tool implementations and helpers must return the `{ content: [...], isError?: boolean }` structure as required by the MCP spec.**
- **Tests and helpers must expect the new format (e.g., `result.content[0].text` instead of any legacy format).**
- **Test helpers and type assertions must match the new format.**

See [`src/mcpUtils.ts`], [`src/toolImplementations.ts`], and [`tests/integration/test-helpers.ts`] for examples.

## Tool Catalogue

This section describes the tools provided by `mcp-pm`.

### `start_process`

Starts a background process (like a dev server or script) and manages it.

**Parameters:**

*   `command` (string, required): The command to execute.
*   `workingDirectory` (string, required): The absolute working directory to run the command from. This setting is required. Do not use relative paths like '.' or '../'. Provide the full path (e.g., /Users/me/myproject).
*   `label` (string, optional): Optional human-readable identifier (e.g. 'dev-server'). Leave blank to let the server generate one based on CWD and command.
*   `args` (array of strings, optional, default: `[]`): Optional arguments for the command.
*   `host` (string, optional, enum: `"cursor"`, `"claude"`, `"chatgpt"`, `"vscode"`, `"windsurf"`, `"unknown"`, default: `"unknown"`): Identifier for the client initiating the process. Helps tailor responses or instructions.

**Returns:** (JSON)

Response payload for a successful start_process call. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `message`, `logs`, `monitoring_hint`, `info_message`.
*   `instructions` (string, optional): If the `host` was specified as `"cursor"` and file logging is enabled, this field will contain a suggested instruction for the Cursor IDE, like starting a background terminal to run the `tail_command`.
On failure, returns an error object, potentially including `error`, `status`, `cwd`, `error_type`.

**Example Usage:**

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "workingDirectory": "/path/to/my-web-app",
  "label": "webapp-dev-server",
  "host": "cursor"
}
```

### `start_process_with_verification`

Starts a background process with verification (pattern, timeout, retries).

**Parameters:**

*   `command` (string, required): The command to execute.
*   `workingDirectory` (string, required): The absolute working directory to run the command from. This setting is required. Do not use relative paths like '.' or '../'. Provide the full path (e.g., /Users/me/myproject).
*   `label` (string, optional): Optional human-readable identifier (e.g. 'dev-server'). Leave blank to let the server generate one based on CWD and command.
*   `args` (array of strings, optional, default: `[]`): Optional arguments for the command.
*   `host` (string, optional, enum: `"cursor"`, `"claude"`, `"chatgpt"`, `"vscode"`, `"windsurf"`, `"unknown"`, default: `"unknown"`): Identifier for the client initiating the process. Helps tailor responses or instructions.
*   `verification_pattern` (string, optional): Optional regex pattern to match in stdout/stderr to verify successful startup. e.g., 'running on port 3000' or 'localhost'.
*   `verification_timeout_ms` (integer, optional, default: -1): Milliseconds to wait for the verification pattern. -1 disables the timer (default).
*   `retry_delay_ms` (integer, optional): Optional delay before restarting a crashed process in milliseconds (default: 1000ms).
*   `max_retries` (integer, optional): Optional maximum number of restart attempts for a crashed process (default: 3). 0 disables restarts.

**Returns:** (JSON)

Response payload for a successful start_process_with_verification call. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `message`, `logs`, `monitoring_hint`, `info_message`.
*   `instructions` (string, optional): If the `host` was specified as `"cursor"` and file logging is enabled, this field will contain a suggested instruction for the Cursor IDE, like starting a background terminal to run the `tail_command`.
On failure, returns an error object, potentially including `error`, `status`, `cwd`, `error_type`.

**Example Usage:**

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "workingDirectory": "/path/to/my-web-app",
  "label": "webapp-dev-server",
  "host": "cursor",
  "verification_pattern": "ready - started server on",
  "verification_timeout_ms": 30000,
  "retry_delay_ms": 1000,
  "max_retries": 3
}
```

### `check_process_status`

Checks the current status of a managed process, including recent logs.

**Parameters:**

*   `label` (string, required): The label of the process to check.
*   `log_lines` (integer, optional, default: 20): Number of recent log lines to request. Default: 20. Max stored: 1000. Use 'getAllLoglines' for the full stored history (up to 1000 lines).

**Returns:** (JSON)

Response payload for check_process_status. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `logs`, `hint`.

**Example Usage:**

```json
{
  "label": "webapp-dev-server",
  "log_lines": 50
}
```

### `list_processes`

Lists all currently managed processes and their status.

**Parameters:**

*   `log_lines` (integer, optional, default: 0): Number of recent log lines to include for each process (default: 0 for none).

**Returns:** (JSON)

Response payload for list_processes, containing an array of process details. Each detail object includes fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `logs`, `log_hint`.

**Example Usage:**

```json
{
  "log_lines": 10
}
```

### `stop_process`

Stops a specific managed process.

**Parameters:**

*   `label` (string, required): The label of the process to stop.
*   `force` (boolean, optional, default: `false`): Use SIGKILL to force kill the process instead of SIGTERM for graceful termination. Defaults to false.

**Returns:** (JSON)

Response payload for stop_process. Contains fields like `label`, `status`, `message`, `pid`.

**Example Usage:**

```json
{
  "label": "webapp-dev-server",
  "force": true
}
```

### `stop_all_processes`

Attempts to gracefully stop all managed processes.

**Parameters:** None

**Returns:** (JSON)

Response payload for stop_all_processes. Contains a `summary` string and a `details` array. Each detail object includes `label`, `result` (e.g., SignalSent, Skipped, Failed), `status`, `pid`.

**Example Usage:**

```json
{}
```

### `restart_process`

Restarts a specific managed process (stops it if running, then starts it again with its original configuration).

**Parameters:**

*   `label` (string, required): The label of the process to restart.

**Returns:** (JSON)

Response payload for a successful restart_process call (structure mirrors start_process success). On failure, returns an error object with `

## Known Limitations: Interactive Prompt Capture

Some interactive prompts (notably from bash and python scripts) may not be captured in PTY logs, even with all known workarounds (e.g., stdbuf, script, unbuffered environment variables). This is due to OS-level and language-level output buffering that cannot always be bypassed from the outside.

- **Node.js-based prompts are reliably captured.**
- **Echo/output from all languages is reliably captured.**
- If you need to ensure prompts are visible to the process manager, prefer Node.js-based CLIs or ensure your tool flushes output explicitly.
- This is a fundamental limitation of PTY and buffering behavior, not a bug in the process manager.