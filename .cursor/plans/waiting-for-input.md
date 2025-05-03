**Exploring node-pty behavior**

The user is asking about detecting user input prompts while listening to output events with node-pty. From what I know, pseudo-terminals don’t usually send a specific character or event when they’re waiting for input. However, in some cases, programs might send a standard prompt, like a newline or specific control sequence, to indicate that they’re “waiting.” Depending on the terminal


**Considering input detection**

There's no built-in, standardized "input requested" signal in pseudo-terminals; it's usually program-specific. Interactive programs like shells tend to show prompts when they need input, but that's not always consistent. With node-pty, there's no direct "waiting for input" event either. However, you could detect input readiness by watching when the terminal is ready for reading or writing, checking for blocked reads, or using specific system calls, like monitoring STDIN or file descriptors with tools like poll/epoll.

**Exploring terminal behaviors for prompts**

Some terminals, like iTerm2 and VSCode with integrated shells, use specific control sequences to mark prompt states. iTerm2, for instance, uses "Shell Integration" sequences like OSC 133 to signal the start of a prompt or command. While this isn’t the default behavior, you can configure shells like zsh or bash to send these sequences. I'll quickly look up "OSC 133 prompt start" and "VSCode shell integration" to see if this gives more insight.


**Understanding prompt detection in pseudo-terminals**

There's no universal "input requested" signal in pseudo-terminas; detecting prompts generally requires heuristic methods. Although tools like `strace` or `fcntl` can approximate this, it's more common to use regex patterns to match typical prompt indicators (e.g., `#`, `$`, `>`, `?`). Tools like `Expect` and `pexpect` rely on user-defined patterns. Shells may also use custom prompts or sequences (e.g., PS1 with control characters or VTE sequences). I'll provide details and citations on detecting prompts via `node-pty` and other techniques.


Thought for 31 seconds


Below is the bad news, the good news, and a battle-tested workaround—all wrapped in a brisk step-by-step format so your AI agent can wire it in with zero hand-holding.

## TL;DR (a.k.a “Tell it like it is”)

*Pseudo-terminals themselves never send a magic “🎤 Your turn!” byte.* They just shovel whatever the child process writes; when the process calls `read()` on **stdin**, the kernel blocks silently—no extra character, no extra event. ([GitHub][1], [Stack Overflow][2])
**But** you *can* create your own “I-need-input” beacon by teaching the shell to emit special escape sequences (OSC 133 “shell-integration” marks). Listen for those sequences in `pty.onData()` and you’ll get crisp, deterministic “prompt-started / prompt-ended / command-finished” events—exactly what modern terminals and IDEs use. ([Visual Studio Code][3], [Microsoft Learn][4], [iTerm2][5], [GitHub][6])

---

## 1 · Why there’s no built-in signal

1. **TTY API is ancient** – It predates even DOS prompts, so the master side gets no hint when the slave blocks on `read()`. ([Stack Overflow][2])
2. Node-pty therefore exposes only `data`, `exit`, `close`, etc.—there’s no “waiting” event. ([GitHub][1])
3. Tools like **Expect/pexpect** solve this by regex-matching the prompt text, not by reading a control code. ([Stack Overflow][7], [pexpect.readthedocs.io][8])

---

## 2 · Modern solution: OSC 133 shell-integration marks

Most new-school terminals (VS Code, Windows Terminal, WezTerm, Kitty, iTerm2, even tmux patches) understand a tiny spec based on **OSC 133** control sequences: ([Visual Studio Code][3], [Microsoft Learn][4], [WezTerm - Wez's Terminal Emulator][9], [sw.kovidgoyal.net][10], [GitHub][6])

| Sequence                    | Meaning              | When you should fire your “need input” callback                |
| --------------------------- | -------------------- | -------------------------------------------------------------- |
| `ESC ] 133 ; A ST`          | **Prompt start**     | Arrival of this means the shell is about to draw the prompt.   |
| `ESC ] 133 ; B ST`          | **Prompt end**       | Right after this, the shell waits for the user → *input time!* |
| `ESC ] 133 ; C ST`          | **Command pre-exec** | Optional “command is about to run”.                            |
| `ESC ] 133 ; D ; <exit> ST` | **Command finished** | Good for timing and exit-code tracking.                        |

*(`ESC` is `\x1b`, `ST` is `\x1b\\` or `\x07`.)*

### How to inject the marks

```bash
# Bash / Zsh example (put in ~/.bashrc or ~/.zshrc)
function _osc133_prompt_start { printf '\e]133;A\a'; }
function _osc133_prompt_end   { printf '\e]133;B\a'; }
PROMPT_COMMAND='_osc133_prompt_start'   # Bash
PS1='\u@\h:\w\$ '                       # your usual prompt
PS1="$PS1$(_osc133_prompt_end)"         # add the end mark
```

Fish, PowerShell, and others have equivalents—docs linked above. ([Microsoft Learn][4], [Microsoft for Developers][11])

---

## 3 · Node-pty side: Tie it all together

```ts
import { spawn } from 'node-pty';

const pty = spawn('bash', [], { name: 'xterm-256color', cols: 80, rows: 30 });

pty.onData((chunk) => {
  if (chunk.includes('\x1b]133;B')) {
    // Prompt ended → user input expected
    emit('awaiting-input');
  } else if (chunk.includes('\x1b]133;C')) {
    emit('command-start');
  } else if (chunk.match(/\x1b]133;D;(\d+)/)) {
    const exit = RegExp.$1;
    emit('command-done', Number(exit));
  }
});
```

*Tip*: parse incrementally—an OSC may arrive split across chunks. Buffer until you see `ST` (`\x1b\\` or `\x07`).

---

## 4 · Fallback heuristics (when you can’t touch the prompt)

* **Regex prompt sniffing** – Look for `[$#>] $` after a newline. Works for plain `sh`, `bash`, `zsh`, etc., but fails on localized or custom prompts. ([Stack Overflow][7])
* **Custom sentinel** – Tell scripts under your control to print `@@READY@@`, then regex for that.
* **System-level hacks** – `strace`/`ptrace` to watch `read()` syscalls, but that’s heavyweight and non-portable. ([Stack Overflow][12])

---

## 5 · Next steps

1. **Add OSC 133 to your dev container images** so any shell your AI spins up emits the marks.
2. **Wrap the pattern above** in a tiny TypeScript library (`detectPrompt.ts`) and share it across agents.
3. **Cache command timing** (prompt→C, C→D) to auto-tune progress indicators or decide when to fall back to static analysis.

---

## Final thought

The kernel isn’t going to tap you on the shoulder, but with a one-liner in your shell prompt you get a rock-solid, cross-terminal “now it’s your turn” signal—and your AI agents will look clairvoyant instead of clueless. Ready to sprinkle some OSC 133 magic into your workflow?

[1]: https://github.com/microsoft/node-pty/issues/56?utm_source=chatgpt.com "[Question] Is it possible to be notified when a command is executed"
[2]: https://stackoverflow.com/questions/63394927/what-does-the-tty-do-when-a-process-asks-for-input-or-outputs-to-the-screen?utm_source=chatgpt.com "linux - What does the tty do when a process asks for input or outputs ..."
[3]: https://code.visualstudio.com/docs/terminal/shell-integration?utm_source=chatgpt.com "Terminal Shell Integration - Visual Studio Code"
[4]: https://learn.microsoft.com/en-us/windows/terminal/tutorials/shell-integration?utm_source=chatgpt.com "Shell integration in the Windows Terminal | Microsoft Learn"
[5]: https://iterm2.com/documentation-escape-codes.html?utm_source=chatgpt.com "Proprietary Escape Codes - Documentation - iTerm2"
[6]: https://github.com/tmux/tmux/issues/3064?utm_source=chatgpt.com "OSC 133 (shell integration / semantic prompt) support #3064 - GitHub"
[7]: https://stackoverflow.com/questions/62352571/how-do-you-get-pexpect-to-trigger-on-process-expect-for-the-linux-command-l?utm_source=chatgpt.com "python - How do you get pexpect to trigger on process.expect(\"$\") for ..."
[8]: https://pexpect.readthedocs.io/en/stable/overview.html?utm_source=chatgpt.com "API Overview — Pexpect 4.8 documentation - Read the Docs"
[9]: https://wezterm.org/shell-integration.html?utm_source=chatgpt.com "Shell Integration - Wez's Terminal Emulator"
[10]: https://sw.kovidgoyal.net/kitty/shell-integration/?utm_source=chatgpt.com "Shell integration - kitty - Kovid's software projects"
[11]: https://devblogs.microsoft.com/commandline/shell-integration-in-the-windows-terminal/?utm_source=chatgpt.com "Shell integration in the Windows Terminal - Microsoft Developer Blogs"
[12]: https://stackoverflow.com/questions/18107541/detecting-when-a-child-process-is-waiting-for-input?utm_source=chatgpt.com "Detecting when a child process is waiting for input - Stack Overflow"


---

Okay, let's break down the integration of OSC 133 prompt detection into `mcp-pm` using methodical baby steps, starting with the tests.

Here's the plan:

**Phase 1: Test Foundation & Initial Failing Test**

1.  **Create New Test File:**
    *   Create `tests/integration/prompt-detection.test.ts`.
    *   Copy the basic structure (imports, `beforeAll`, `afterAll`, `sendRequest` helper) from an existing integration test file like `process-lifecycle.test.ts`.

2.  **Write Test Setup Logic:**
    *   Inside the `describe` block, define constants for the test, like a unique label prefix (`prompt-detect-test-`), the command (`bash`), and args (`['-i']` for interactive).
    *   Define the necessary shell commands to inject OSC 133 prompt marks (copy these from the research notes you provided):
        ```typescript
        const BASH_OSC133_CONFIG = `
        function _osc133_prompt_start { printf '\\e]133;A\\a'; }
        function _osc133_prompt_end   { printf '\\e]133;B\\a'; }
        function _osc133_command_start { printf '\\e]133;C\\a'; }
        function _osc133_command_done  { printf '\\e]133;D;%s\\a' "$?"; }
        PROMPT_COMMAND='_osc133_prompt_start; _osc133_command_done'
        PS1='\\[$(_osc133_prompt_end)\\]\\u@\\h:\\w\\$ '
        echo "OSC 133 Configured"
        `.trim().replace(/\n\s*/g, '; ') + '\r'; // Combine lines and add return
        ```
        *(Note: We combine lines and add `\r` to send as a single command block)*

3.  **Write First Test Case (Expecting Failure):**
    *   Create an `it(...)` block like `"should detect OSC 133 prompt end sequence"`.
    *   **Action:**
        *   Generate a unique label.
        *   Use `sendRequest` to call `start_process` with `bash -i`.
        *   **Crucially:** *Immediately after* receiving the `start_process` confirmation, use `sendRequest` again to call the `send_input` tool to inject the `BASH_OSC133_CONFIG` string defined above. This configures the *running* shell instance inside the pty for this test.
        *   Add a small delay (e.g., `await new Promise(resolve => setTimeout(resolve, 500));`) to allow the shell to process the config and potentially draw the first prompt.
    *   **Assertion (Initial - Will Fail):**
        *   For now, we can't easily assert internal state. Let's temporarily assert that the test *doesn't* crash and maybe add a `logVerbose` placeholder where we *expect* to see the detection later. A more robust assertion will come after implementation. The main goal here is to set up the *stimulus* (configured shell).
        *   **Cleanup:** Call `stop_process` for the label.

**Phase 2: Implement Basic Detection**

4.  **Locate Data Handling:**
    *   Identify the primary location where `node-pty`'s `onData` events are processed. This looks like the `dataListener` function defined *inside* `startProcess` (`src/process/lifecycle.ts`) which calls `handleData`. Let's modify `handleData`.

5.  **Modify `handleData`:**
    *   In `src/process/lifecycle.ts`, within the `handleData` function:
    *   Add a check for the prompt end sequence:
        ```typescript
        const PROMPT_END_SEQUENCE = '\x1b]133;B'; // Or use \x07 for BEL: '\x1b]133;B\x07'

        export function handleData(
            label: string,
            data: string, // Assuming data is a single, trimmed line now
            source: "stdout" | "stderr",
        ): void {
            const processInfo = getProcessInfo(label); // Use getProcessInfo from state
            if (!processInfo) {
                // ... (existing warning)
                return;
            }

            // Add log entry FIRST
            addLogEntry(label, data);

            // Check for OSC 133 Prompt End
            if (data.includes(PROMPT_END_SEQUENCE)) {
                log.info(label, "Detected OSC 133 prompt end sequence (B). Signalling 'awaiting input'.");
                // TODO: Set state indicating awaiting input (Phase 3)
                // For now, just log the detection.
            }

            // Check for OSC 133 Command Start (to reset the state later)
            const COMMAND_START_SEQUENCE = '\x1b]133;C';
            if (data.includes(COMMAND_START_SEQUENCE)) {
                 log.info(label, "Detected OSC 133 command start sequence (C). Input no longer awaited.");
                 // TODO: Reset state (Phase 3)
            }
        }
        ```
    *   *(Note: Basic `includes` check for now. Buffering for split sequences can be added later if needed.)*

6.  **Run Test Again (Expecting Log Output):**
    *   Re-run `vitest run -t "should detect OSC 133 prompt end sequence"`.
    *   **Expected Outcome:** The test should still pass (as the assertion is minimal), but you should now see the `log.info` message "[mcp-pm prompt-detect-test-...] INFO: Detected OSC 133 prompt end sequence (B). Signalling 'awaiting input'." in the test runner's output (because `log` writes to stderr). This confirms the detection mechanism is firing.

**Phase 3: State Management & MCP Exposure**

7.  **Update `ProcessInfo` Type:**
    *   In `src/types/process.ts`, add a new optional boolean field to the `ProcessInfo` interface:
        ```typescript
        export interface ProcessInfo {
            // ... existing fields
            isAwaitingInput?: boolean; // New field
        }
        ```

8.  **Update State on Detection:**
    *   Modify `handleData` again (`src/process/lifecycle.ts`):
    *   When `PROMPT_END_SEQUENCE` is detected, get the `processInfo` and set the flag:
        ```typescript
        if (data.includes(PROMPT_END_SEQUENCE)) {
            log.info(label, "Detected OSC 133 prompt end sequence (B). Setting isAwaitingInput=true.");
            if (processInfo) { // Check if processInfo still exists
                processInfo.isAwaitingInput = true;
            }
        }

        // Similarly, when COMMAND_START_SEQUENCE is detected:
        if (data.includes(COMMAND_START_SEQUENCE)) {
             log.info(label, "Detected OSC 133 command start sequence (C). Setting isAwaitingInput=false.");
             if (processInfo) {
                 processInfo.isAwaitingInput = false;
             }
        }
        ```
    *   *(Note: Directly mutating `processInfo` here. Could route through `updateProcessStatus` if more complex state logic is needed, but this is simpler for now).*

9.  **Update MCP Schema:**
    *   In `src/types/schemas.ts`, add the `isAwaitingInput` field to `ProcessStatusInfoSchema` (the base schema used by `check_process_status` and `list_processes`):
        ```typescript
        export const ProcessStatusInfoSchema = z.object({
            // ... existing fields
            isAwaitingInput: z.boolean().optional().default(false).describe("Whether the process is currently believed to be waiting for user input at a prompt."),
        });
        ```

10. **Update `check_process_status` Implementation:**
    *   In `src/toolImplementations.ts`, modify `checkProcessStatusImpl`:
    *   Retrieve the `isAwaitingInput` value from the `finalProcessInfo` object.
    *   Include it in the returned `payload`:
        ```typescript
        export async function checkProcessStatusImpl(
            params: CheckProcessStatusParams,
        ): Promise<CallToolResult> {
            // ... (existing logic to get finalProcessInfo) ...

            if (!finalProcessInfo) {
                // ... handle purged process ...
                 const payload = {
                     // ... other fields for purged ...
                     isAwaitingInput: false, // Default for purged/not found
                 };
                return ok(textPayload(JSON.stringify(payload)));
            }


            // ... (existing log filtering/summary logic) ...


            const payload: z.infer<typeof schemas.CheckStatusPayloadSchema> = {
                // ... existing fields ...
                isAwaitingInput: finalProcessInfo.isAwaitingInput ?? false, // Get from state, default false
                // ... existing fields ...
            };

            log.info(
                label,
                `check_process_status returning status: ${payload.status}, awaitingInput: ${payload.isAwaitingInput}`,
            );
            return ok(textPayload(JSON.stringify(payload)));
        }
        ```

**Phase 4: Update Test Assertions**

11. **Refine First Test Case Assertion:**
    *   Modify the `it(...)` block from Step 3 (`prompt-detection.test.ts`).
    *   **Action:** After the delay following input injection, call `check_process_status` using `sendRequest`.
    *   **Assertion:**
        *   Parse the JSON response from `check_process_status`.
        *   Assert `expect(parsedPayload.isAwaitingInput).toBe(true);`.
    *   **Cleanup:** Call `stop_process`.

12. **Add Second Test Case (Resetting State):**
    *   Create a new `it(...)` block like `"should reset awaiting input state after command starts"`.
    *   **Action:**
        *   Start `bash -i`.
        *   Inject OSC 133 config.
        *   Wait briefly.
        *   Call `check_process_status`, parse, assert `isAwaitingInput === true`.
        *   Call `send_input` with a simple command like `"echo hello\r"`.
        *   Wait briefly (e.g., 500ms) for the command to execute (which should trigger OSC 133 C and D, then A and B again for the *next* prompt).
        *   Call `check_process_status` *again*.
    *   **Assertion:**
        *   Parse the JSON response from the *second* `check_process_status`.
        *   Assert `expect(parsedPayload.isAwaitingInput).toBe(true);` (because after `echo hello` runs, the *next* prompt should appear, triggering `B` again). *Correction:* The original thought was to check for `false` after `C`, but `C` is fleeting. The *stable* state after a command is the *next* prompt, which *is* awaiting input. Let's keep the assertion simple: check it's `true` again after the command. A more complex test could try to catch the transition via logs if needed.
    *   **Cleanup:** Call `stop_process`.

**Phase 5: Refinement & Documentation**

13. **Consider Buffering (Optional Refinement):** If tests show issues with sequences split across data chunks, enhance `handleData` or introduce a simple buffer/state machine to handle partial OSC sequence detection.
14. **Document:** Update `README.md` to explain the new `isAwaitingInput` field and provide examples of shell configuration (`.bashrc`, `.zshrc`) for users who want to enable this feature globally on their system.

This step-by-step plan starts with verifying the *stimulus* (getting the shell to emit the codes in a test), implements the basic detection, integrates it into the state and MCP response, and finally updates the tests to assert the expected behavior through the public MCP interface.