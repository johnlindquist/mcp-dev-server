# MCP Process Manager

A Model Context Protocol server for managing background processes.

This is a TypeScript-based MCP server that implements a simple notes system. It demonstrates core MCP concepts by providing:

- Resources representing text notes with URIs and metadata
- Tools for creating new notes
- Prompts for generating summaries of notes

## Features

### Resources
- List and access notes via `note://` URIs
- Each note has a title, content and metadata
- Plain text mime type for simple content access

### Tools
- `create_note` - Create new text notes
  - Takes title and content as required parameters
  - Stores note in server state

### Prompts
- `summarize_notes` - Generate a summary of all stored notes
  - Includes all note contents as embedded resources
  - Returns structured prompt for LLM summarization

- Start new background processes (e.g., dev servers, test watchers, build scripts).
- Check status and logs of running processes.
- Stop specific processes or all managed processes.
- Restart processes.
- Wait for a process to reach a stable running state.
- Automatic zombie process cleanup.

Available Tools:

- `start_process`: Starts a new background process.
- `check_process_status`: Checks the status of a specific process.
- `stop_process`: Stops a specific process.
- `list_processes`: Lists all managed processes.
- `stop_all_processes`: Stops all active processes.
- `restart_process`: Restarts a specific process.
- `wait_for_process`: Waits for a specific process to be running.
- `health_check`: Provides a health summary of the process manager.

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

For development with auto-rebuild:
```bash
npm run watch
```

## Installation

```bash
npm install -g mcp-pm
```

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-dev-server": {
      "command": "/path/to/mcp-dev-server/build/index.js"
    }
  },
  "tools": [
    {
      "name": "mcp-pm",
      "path": "/path/to/global/node_modules/mcp-pm/build/index.js"
    }
  ]
}
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.
