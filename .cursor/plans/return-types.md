Okay, let's break this down into small, manageable steps to align your `mcp-dev-server` codebase with the Cursor MCP guidelines you provided (specifically, returning the `{ content: [...] }` structure).

We'll focus on modifying how your tools return results so that Cursor can potentially understand and act on them better.

**Goal:** Change the tool response format from the current internal structure (`{ isError: ..., payload: [{ contentType: ..., content: ... }] }`) to the standard MCP format (`{ content: [{ type: "text", text: "..." }], isError?: boolean }`).

---

**Baby Step 1: Understand the Target Format**

Remember, the goal is to have your tool implementations ultimately return a JavaScript object like this:

```typescript
// Successful result example
{
  content: [
    { type: "text", text: "Operation successful. Log file at /path/to/log" }
    // Potentially other content items like images here
  ]
  // isError is implicitly false or absent
}

// Error result example
{
  content: [
    { type: "text", text: "Error: Failed to find process." }
  ],
  isError: true
}
```

---

**Baby Step 2: Locate the Key Files**

We'll primarily be working in these files:

1.  `src/mcpUtils.ts`: This contains the `ok()`, `fail()`, and `textPayload()` helpers that currently create the *non-standard* intermediate response format.
2.  `src/types/index.ts`: This defines the `CallToolResult` type, which needs to be updated.
3.  `src/toolDefinitions.ts`: This uses a function `toMcpSdkResponse` to adapt the output from `ok()`/`fail()` for the SDK. We'll likely remove or simplify this adapter.

---

**Baby Step 3: Modify `textPayload` Helper (Check)**

*   **Action:** Look at `src/mcpUtils.ts`. Find the `textPayload` function.
*   **Check:** Does it already return `{ type: "text", text: "some string" }`?
    *   *Your Code:* Yes, it looks like `textPayload` is already correct:
        ```typescript
        export const textPayload = (text: string): TextContent =>
        	({ type: "text", text }) as const;
        ```
*   **Result:** Good, `textPayload` creates the correct *inner* part of the `content` array item. No changes needed here for now.

---

**Baby Step 4: Modify `ok` and `fail` Helpers**

*   **Action:** In `src/mcpUtils.ts`, find the `ok` and `fail` functions (and the `createPayload` function they use).
*   **Goal:** Change them to return the `{ content: [...], isError?: ... }` structure directly.

*   **Replace `createPayload`, `ok`, and `fail` with this:**

    ```typescript
    // src/mcpUtils.ts

    import type { ToolContent, CallToolResult } from "./types/index.js"; // Make sure path is correct

    // Keep textPayload as it is
    export const textPayload = (text: string): TextContent =>
    	({ type: "text", text }) as const;

    // NEW ok() function
    export const ok = (...contentItems: readonly ToolContent[]): CallToolResult => {
    	// Directly return the standard MCP format
    	return {
    		content: [...contentItems], // Spread the array of content items
    		isError: false, // Explicitly set isError to false for clarity
    	};
    };

    // NEW fail() function
    export const fail = (...contentItems: readonly ToolContent[]): CallToolResult => {
    	// Directly return the standard MCP format with isError: true
    	return {
    		content: [...contentItems], // Spread the array of content items
    		isError: true,
    	};
    };

    // --- Keep other helpers like shape, safeSubstring, isRunning, getResultText ---
    // BUT, we need to update getResultText for the new structure

    export const shape = <T extends ZodRawShape>(x: T) => x; // Keep

    export const safeSubstring = (v: unknown, len = 100): string => // Keep
    	typeof v === "string" ? v.substring(0, len) : "";

    export const isRunning = (status: string) => // Keep
    	status === "running" || status === "verifying";

    // UPDATED getResultText to read from the new structure
    export const getResultText = (result: CallToolResult): string | null => {
    	if (result.content && result.content.length > 0) {
    		// Try to find the first 'text' content item
    		const firstTextContent = result.content.find(
    			(item): item is TextContent => item.type === "text",
    		);
    		if (firstTextContent) {
    			return firstTextContent.text;
    		}
    		// Fallback: Stringify the first item if no text type found (less ideal)
    		// return JSON.stringify(result.content[0]);
    		return null; // Or return null if no text found
    	}
    	return null;
    };

    // Remove the old createPayload function completely
    ```

*   **Explanation:** `ok` and `fail` now directly create the object structure with the `content` array. They accept one or more `ToolContent` items (like the one created by `textPayload`) as arguments. `getResultText` is updated to find the text within the `content` array.

---

**Baby Step 5: Update the `CallToolResult` Type**

*   **Action:** Go to `src/types/index.ts`. Find the `CallToolResult` interface/type.
*   **Goal:** Change it to match the new structure returned by `ok`/`fail`.

*   **Replace the old `CallToolResult` with this:**

    ```typescript
    // src/types/index.ts
    import type { ToolContent } from "./index.js"; // Assuming ToolContent is defined above or imported

    // UPDATED CallToolResult type
    export interface CallToolResult {
    	content: ToolContent[]; // Array of content items (text, image, etc.)
    	isError?: boolean; // Optional boolean, true if it's an error result
    }

    // Keep other types like TextContent, ImageContent etc.
    ```

*   **Explanation:** This type now accurately reflects the object structure we created in Step 4.

---

**Baby Step 6: Remove the `toMcpSdkResponse` Adapter**

*   **Action:** Go to `src/toolDefinitions.ts`. Find the `toMcpSdkResponse` function and where it's used (inside the `.then(...)` calls when registering tools).
*   **Goal:** Remove this adapter, as `ok`/`fail` now produce a format that the SDK *should* understand directly (or is much closer to it).

*   **Remove the `toMcpSdkResponse` function definition.**
*   **Modify the tool registration:** For *each* `server.tool(...)` call, remove the `.then(toMcpSdkResponse)` part.

    *   **Example (Before):**
        ```typescript
        server.tool(
        	"check_process_status",
        	// ... description, shape ...
        	(params: CheckProcessStatusParamsType) => {
        		return handleToolCall(
        			params.label,
        			"check_process_status",
        			params,
        			async () => await checkProcessStatusImpl(params),
        		).then(toMcpSdkResponse); // <-- REMOVE THIS PART
        	},
        );
        ```

    *   **Example (After):**
        ```typescript
        server.tool(
        	"check_process_status",
        	// ... description, shape ...
        	(params: CheckProcessStatusParamsType) => {
        		// Directly return the promise from handleToolCall
        		// The result from ok()/fail() will be passed to the SDK
        		return handleToolCall(
        			params.label,
        			"check_process_status",
        			params,
        			async () => await checkProcessStatusImpl(params),
        		);
        	},
        );
        ```
*   **Apply this change to *all* `server.tool` registrations in that file.**

*   **Explanation:** We are now trusting the `@modelcontextprotocol/sdk` to correctly handle the standard `{ content: [...], isError?: ... }` format directly. This simplifies your code and adheres closer to the MCP standard.

---

**Baby Step 7: Verify Tool Implementations**

*   **Action:** Briefly review `src/toolImplementations.ts`.
*   **Check:** Do all the `...Impl` functions correctly use `ok(...)` or `fail(...)` to return their results? Do they wrap their output strings (especially JSON strings) with `textPayload(...)` before passing them to `ok`/`fail`?
    *   *Your Code:* It looks like most implementations already do `ok(textPayload(JSON.stringify(...)))` or `fail(textPayload(JSON.stringify(...)))`. This pattern is fine. The change we made was *inside* `ok`/`fail`, so the way you *call* them doesn't need to change much.
*   **Result:** Likely no major changes needed here, but good to double-check that all return paths use the updated `ok`/`fail` helpers.

---

**Baby Step 8: Build and Test!**

*   **Action:**
    1.  Run your build command (e.g., `pnpm run build` or `npm run build`).
    2.  Run your server (`npx mcp-pm` or `node build/index.mjs`).
    3.  **Crucially:** Test this thoroughly within Cursor.
        *   Call your tools (e.g., `start_process`, `check_process_status`).
        *   Does Cursor display the output correctly in the chat?
        *   If a tool returns a file path (like `start_process` might in its `message` or a dedicated field), try asking the Cursor AI agent to `tail` that file. Does the agent understand the output and correctly invoke the terminal command?
        *   Test error cases. Do errors returned via `fail()` show up appropriately?
    4.  **(Optional but Recommended):** Use the MCP Inspector (`npm run inspector`) if available. Examine the exact JSON being sent back by your tools *after* these changes. Does it match the target `{ content: [...] }` format?

*   **Explanation:** These changes modify the fundamental structure of your tool responses. Testing is essential to ensure they work correctly with the SDK and, most importantly, with Cursor's AI agent and UI. Pay close attention to whether Cursor can now "see" and potentially act upon structured information returned in the `text` field of the `content` array.

---

By following these steps, you should have modified your server to return data in the format Cursor expects, increasing the likelihood that the AI agent can parse the results and trigger follow-up actions like `tail`. Good luck!