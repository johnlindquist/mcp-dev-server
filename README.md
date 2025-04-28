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

## Available Tools

This server exposes the following tools for MCP clients:

*   `start_process`: Starts a new background process. (Label is optional)
*   `check_process_status`: Checks the status and logs of a specific process. (Requires label)
*   `stop_process`: Stops a specific process. (Requires label)
*   `list_processes`: Lists all currently managed processes and their basic status.
*   `stop_all_processes`: Attempts to stop all managed processes.
*   `restart_process`: Restarts a specific process. (Requires label)
*   `wait_for_process`: Waits for a specific process to reach a target status. (Requires label)
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

## Debugging

Since MCP servers communicate over stdio, standard debugging methods can be tricky. We recommend using the **MCP Inspector**:

1.  **Ensure the project is built:** `npm run build`
2.  **Run the inspector script:**
    ```bash
    npm run inspector
    ```
3.  **Access the Inspector:** The script will output a URL (usually `http://localhost:8080`). Open this URL in your web browser.
4.  **Interact:** The Inspector provides a UI to manually call tools, view request/response logs, and introspect the server's behavior, making debugging much easier.

## Technology Stack

*   Node.js / TypeScript
*   `@modelcontextprotocol/sdk`: Core MCP server framework.
*   `node-pty`: For robust pseudo-terminal process management.
*   `zod`: For runtime validation of tool parameters.
*   `biomejs`: For formatting and linting.
*   `semantic-release`: For automated versioning and publishing.