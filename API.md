# API Reference: mcp-shell-yeah

This document describes the tools provided by `mcp-shell-yeah` for MCP clients and agent developers.

---

## Tool Catalogue

### `start_shell`

Starts a background process (like a dev server or script) and manages it.

**Parameters:**

*   `command` (string, required): The command to execute.
*   `workingDirectory` (string, required): The absolute working directory to run the command from. This setting is required. Do not use relative paths like '.' or '../'. Provide the full path (e.g., /Users/me/myproject).
*   `label` (string, optional): Optional human-readable identifier (e.g. 'dev-server'). Leave blank to let the server generate one based on CWD and command.
*   `args` (array of strings, optional, default: `[]`): Optional arguments for the command.
*   `host` (string, optional, enum: `"cursor"`, `"claude"`, `"chatgpt"`, `"vscode"`, `"windsurf"`, `"unknown"`, default: `"unknown"`): Identifier for the client initiating the process. Helps tailor responses or instructions.

**Returns:** (JSON)

Response payload for a successful start_shell call. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `message`, `logs`, `monitoring_hint`, `info_message`, and `detected_urls` (if any URLs are found in logs, the AI should extract and return them as markdown links).
*   `ai_instructions` (string, mandatory): The AI MUST always follow the instructions in this field. It will always tell the AI to run the `tail_command` in a BACKGROUND terminal (never in the foreground, as it may be blocking) and to display all `detected_urls` as clickable markdown links. The AI must never skip or delay these steps.
*   `user_hint` (string, optional): A user-facing hint about what to do next.

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

### `check_shell`

Checks the current status of a managed process, including recent logs.

**Parameters:**

*   `label` (string, required): The label of the process to check.
*   `log_lines` (integer, optional, default: 20): Number of recent log lines to request. Default: 20. Max stored: 1000. Use 'getAllLoglines' for the full stored history (up to 1000 lines).

**Returns:** (JSON)

Response payload for check_shell. Contains fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `logs`, `hint`, and `detected_urls` (if any URLs are found in logs, the AI should extract and return them as markdown links).
*   `ai_instructions` (string, mandatory): The AI MUST always follow the instructions in this field, including running the `tail_command` in a background terminal and displaying all `detected_urls` as markdown links.

**Example Usage:**

```json
{
  "label": "webapp-dev-server",
  "log_lines": 50
}
```

### `list_shells`

Lists all currently managed processes and their status.

**Parameters:**

*   `log_lines` (integer, optional, default: 0): Number of recent log lines to include for each process (default: 0 for none).

**Returns:** (JSON)

Response payload for list_shells, containing an array of process details. Each detail object includes fields like `label`, `status`, `pid`, `command`, `args`, `cwd`, `exitCode`, `signal`, `log_file_path`, `tail_command`, `logs`, `log_hint`.

**Example Usage:**

```json
{
  "log_lines": 10
}
```

### `stop_shell`

Stops a specific managed process.

**Parameters:**

*   `label` (string, required): The label of the process to stop.
*   `force` (boolean, optional, default: `false`): Use SIGKILL to force kill the process instead of SIGTERM for graceful termination. Defaults to false.

**Returns:** (JSON)

Response payload for stop_shell. Contains fields like `label`, `status`, `message`, `pid`.

**Example Usage:**

```json
{
  "label": "webapp-dev-server",
  "force": true
}
```

### `stop_all_shells`

Attempts to gracefully stop all managed processes.

**Parameters:** None

**Returns:** (JSON)

Response payload for stop_all_shells. Contains a `summary` string and a `details` array. Each detail object includes `label`, `result` (e.g., SignalSent, Skipped, Failed), `status`, `pid`.

**Example Usage:**

```json
{}
```

### `restart_shell`

Restarts a specific managed process (stops it if running, then starts it again with its original configuration).

**Parameters:**

*   `label` (string, required): The label of the process to restart.

**Returns:** (JSON)

Response payload for a successful restart_shell call (structure mirrors start_shell success). On failure, returns an error object with details.

---

## Known Limitations: Interactive Prompt Capture

Some interactive prompts (notably from bash and python scripts) may not be captured in PTY logs, even with all known workarounds (e.g., stdbuf, script, unbuffered environment variables). This is due to OS-level and language-level output buffering that cannot always be bypassed from the outside.

- **Node.js-based prompts are reliably captured.**
- **Echo/output from all languages is reliably captured.**
- If you need to ensure prompts are visible to the process manager, prefer Node.js-based CLIs or ensure your tool flushes output explicitly.
- This is a fundamental limitation of PTY and buffering behavior, not a bug in the process manager.

## Known Limitations: Node.js Readline Prompts and PTY Capture

**Node.js readline prompts may not appear in logs or be detected as input-waiting prompts.**

- The Node.js `readline` library sometimes writes prompts directly to the terminal device, not through the process's stdout stream.
- In PTY-based process managers, this means the prompt may not be visible in logs or trigger prompt detection heuristics.
- This is a well-documented limitation of Node.js readline and PTY interaction ([see Node.js issue #29589](https://github.com/nodejs/node/issues/29589)).
- All other prompt types (bash, python, node custom CLI, etc.) are captured and detected correctly.
- If you do not see a prompt in logs, it is almost always because the program did not actually print one (or it used an escape sequence your parser ignores).

**Test Coverage:**
- The integration test for Node.js readline prompt detection is included but skipped, to document this limitation and catch any future improvements in PTY or Node.js behavior.

## Known Limitation: OSC 133 Prompt Detection on macOS

- On macOS (bash 3.2), emitting raw OSC 133 prompt sequences (e.g., `\x1b]133;B\x07`) from the shell is not reliable.
- Even with direct `printf` or shell prompt configuration, the expected escape sequence does not appear in the PTY buffer.
- This is a limitation of the shell/environment, not the detection logic.
- As a result, OSC 133-based prompt detection tests are skipped, with detailed comments in the test file.
- Heuristic prompt detection (e.g., lines ending with `:`, `?`, etc.) is used as a fallback and is sufficient for most interactive CLI use cases.
- If you need robust OSC 133 detection, consider running tests in a Linux environment with a newer bash or zsh shell. 